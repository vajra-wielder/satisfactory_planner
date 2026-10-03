/**
 * supply-panel.js — what a factory is built on, and what it sends on.
 *
 * Resources: the nodes it mines. Pick them on the map (map-picker.js) — each
 * node's purity is known, and one marked as mined by another factory can't be
 * taken twice — or type them in (resource, extractor, purity, how many).
 * Power shards on the extractors decide how much comes out: each takes an
 * extractor 50% higher, three at most; "Spread" puts a number of them where
 * they give the most. Miners run at the tier unlocked in Machines & Alts.
 * "Fixed rate" is a plain number. ∞ marks a resource unlimited. The rates are
 * the same as supply.py's.
 *
 * From factories: what it takes from other saved factories. The item list is
 * everything they make; the rate starts at what the chosen factory has left —
 * what it makes, less what other factories take and store — and can't go above.
 *
 * To storage: what it sends to storage, out of what it makes — no other
 * factory can take that share. Sent out lists everything it owes; solving
 * makes at least that much.
 *
 * Nodes and imports add up into SC.available_resources, all the solver sees.
 */

import { SC, RESULT, keyOf, EXTRACTORS, PURITY, MINER_TIERS, MAX_SHARDS, PROGRESS, ALL_ITEMS, itemName } from './state.js';
import { makeAC } from './sidebar.js';
import { evalExpr } from './kv-panel.js';
import { fetchFactoryOutputs } from './api.js';
import { openMapPicker, mapNode, loadMap } from './map-picker.js';

const $ = id => document.getElementById(id);
const down = v => Math.floor(v * 1000 + 1e-6) / 1000;   // to 0.001, never above v
const fmt = v => (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : +v.toFixed(2)).toLocaleString();
// This factory's save key (as handleSave makes it), from the name as typed
export const ownKey = () => keyOf(document.getElementById('sc-name')?.value || SC.name);
export const STORAGE = '@storage';

let NODES = [];       // rows, as SC.resource_nodes
let FROM = [];        // rows, as SC.from_factories
let STO = [];         // rows, as SC.to_storage
let UNLIM = new Set();
let OUTPUTS = null;   // /api/factory-outputs
let PAINTS = [];      // import + storage notes, repainted together (they share what's left)
let CUT = [];         // what the last save cut back

const facName = k => k === STORAGE ? 'Storage' : OUTPUTS?.factories.find(x => x.key === k)?.name || k;

// ── Rates ─────────────────────────────────────────────────
const canon = ex => (/^Miner_Mk\d$/.test(ex) ? 'Miner' : ex);
const baseRate = ex => (ex === 'Miner' ? MINER_TIERS[PROGRESS.miner] : EXTRACTORS[ex]?.rate);
const clockOf = s => 100 + 50 * Math.min(MAX_SHARDS, Math.max(0, parseInt(s, 10) || 0));
const isWell = n => n.extractor === 'Resource_Well';
const GEO = 'Geothermal_Generator';
const isGeo = n => n.extractor === GEO;
const GEO_MW = { impure: 100, normal: 200, pure: 400 };
export const geoMW = n => (isGeo(n) ? (n.nodes || []).reduce((a, id) => a + (GEO_MW[mapNode(id)?.p] || 0), 0) : 0);

export function nodeRate(n) {
  const e = EXTRACTORS[n.extractor];
  if (!e) return Math.max(0, parseFloat(n.rate) || 0);
  const base = baseRate(n.extractor);
  const cap = r => (e.cap ? Math.min(r, e.cap) : r);
  if (n.nodes?.length) {
    const pur = id => PURITY[mapNode(id)?.p || 'normal'] ?? 1;
    if (isWell(n)) return n.nodes.reduce((s, id) => s + base * pur(id), 0) * clockOf(n.shards) / 100;
    return n.nodes.reduce((s, id) => s + cap(base * pur(id) * clockOf(n.node_shards?.[id] ?? n.shards) / 100), 0);
  }
  const each = cap(base * (e.purity ? PURITY[n.purity || 'normal'] ?? 1 : 1) * clockOf(n.shards) / 100);
  return each * Math.max(0, n.count == null || n.count === '' ? 1 : parseInt(n.count, 10) || 0);
}

// Power shards a row's extractors hold
export function rowShards(n) {
  if (!EXTRACTORS[n.extractor]) return 0;
  if (n.nodes?.length && !isWell(n)) return n.nodes.reduce((s, id) => s + (parseInt(n.node_shards?.[id] ?? n.shards, 10) || 0), 0);
  return (parseInt(n.shards, 10) || 0) * (n.nodes?.length ? 1 : Math.max(0, parseInt(n.count ?? 1, 10) || 0));
}

const resourcePool = () => {     // node resources first, then anything else (a fixed rate)
  const nodes = [...new Set(Object.values(EXTRACTORS).flatMap(e => e.for))];
  return [...nodes, ...ALL_ITEMS.filter(k => !nodes.includes(k))];
};
const extractorsFor = res => Object.entries(EXTRACTORS).filter(([, e]) => e.for.includes(res)).map(([k]) => k);
const defaultExtractor = res => ['Miner', 'Oil_Extractor', 'Water_Extractor', 'Resource_Well']
  .find(k => extractorsFor(res).includes(k)) || 'fixed';
const exName = ex => (ex === 'Miner' ? `Miner ${PROGRESS.miner.replace('Mk', 'Mk.')}` : EXTRACTORS[ex]?.display || 'Fixed rate');

/**
 * Put `budget` shards where they add the most: every extractor (a map node, a
 * well's pressurizer, or a typed row's extractors together) gains the same per
 * shard up to three, so the biggest gain per shard is filled first. Unlimited
 * resources and fixed rates take none. Returns the shards used.
 */
export function spreadShards(budget) {
  const units = [];
  NODES.forEach(n => {
    const e = EXTRACTORS[n.extractor];
    if (!e || UNLIM.has(n.resource)) return;
    const base = baseRate(n.extractor);
    if (n.nodes?.length && !isWell(n)) {
      n.node_shards = {};
      n.nodes.forEach(id => units.push({ cost: 1, gain: base * (PURITY[mapNode(id)?.p] ?? 1) * 0.5, cap: e.cap,
        top: base * (PURITY[mapNode(id)?.p] ?? 1), set: s => { n.node_shards[id] = s; } }));
    } else if (n.nodes?.length) {
      const sum = n.nodes.reduce((s, id) => s + base * (PURITY[mapNode(id)?.p] ?? 1), 0);
      units.push({ cost: 1, gain: sum * 0.5, set: s => { n.shards = s; } });
    } else {
      const count = Math.max(0, parseInt(n.count ?? 1, 10) || 0);
      const one = base * (e.purity ? PURITY[n.purity || 'normal'] ?? 1 : 1);
      if (count) units.push({ cost: count, gain: one * 0.5, cap: e.cap, top: one, set: s => { n.shards = s; } });
    }
  });
  units.forEach(u => u.set(0));
  // what level s+1 adds over s, for one extractor (a belt or pipe cap can cut the last ones)
  const step = (u, s) => (u.cap ? Math.min(u.cap, u.top * (1 + 0.5 * (s + 1))) - Math.min(u.cap, u.top * (1 + 0.5 * s)) : u.gain);
  const level = new Map(units.map(u => [u, 0]));
  let left = Math.max(0, parseInt(budget, 10) || 0);
  for (;;) {
    let best = null, bestGain = 1e-9;
    units.forEach(u => {
      const s = level.get(u);
      if (s >= MAX_SHARDS || u.cost > left) return;
      const g = step(u, s);
      if (g > bestGain) { best = u; bestGain = g; }
    });
    if (!best) break;
    level.set(best, level.get(best) + 1);
    best.set(level.get(best));
    left -= best.cost;
  }
  syncSupply();
  renderNodes();
  return Math.max(0, parseInt(budget, 10) || 0) - left;
}

// ── What others make and take ─────────────────────────────
// For importing `item` from `fac`: what it makes, who takes how much, what's left.
// row: this row — the factory's other rows for the same item and source count as taken too
function offer(fac, item, row = null) {
  const f = OUTPUTS?.factories.find(x => x.key === fac);
  const made = f?.made[item];
  if (made == null) return null;
  const by = { ...(OUTPUTS.claims[fac]?.[item] || {}) };
  delete by[ownKey()];
  const mine = FROM.filter(r => r !== row && r.factory === fac && r.item === item)
    .reduce((s, r) => s + (parseFloat(r.rate) || 0), 0);
  if (mine > 0) by[ownKey()] = mine;
  const others = Object.values(by).reduce((s, v) => s + v, 0);
  return { made, by, left: Math.max(0, made - others), stale: f.stale, solved: f.solved };
}

// What this factory makes now: its current plan, else its saved one
function ownMade() {
  if (RESULT && String(RESULT.status || '').startsWith('Optimal')) {
    const m = {};
    Object.entries(RESULT.sink_nodes || {}).forEach(([k, v]) => { if (v > 1e-4) m[k] = v; });
    Object.entries({ ...(RESULT.surplus_intermediates || {}), ...(RESULT.error_sinks || {}) })
      .forEach(([k, v]) => { if (v > 1e-4 && !(k in m)) m[k] = v; });
    return m;
  }
  return OUTPUTS?.factories.find(x => x.key === ownKey())?.made || {};
}

// For storing `item`: what this factory makes, less what others import, less other storage rows
function storeOffer(item, row = null) {
  const made = ownMade()[item];
  if (made == null) return null;
  const by = { ...(OUTPUTS?.claims[ownKey()]?.[item] || {}) };
  delete by[STORAGE];
  const others = Object.values(by).reduce((s, v) => s + v, 0);
  const mine = STO.filter(r => r !== row && r.item === item).reduce((s, r) => s + (parseFloat(r.rate) || 0), 0);
  return { made, by, mine, left: Math.max(0, made - others - mine) };
}

const makersOf = item => (OUTPUTS?.factories || []).filter(f => f.key !== ownKey() && f.made[item] != null);
const madeItems = () => {
  const s = new Set();
  (OUTPUTS?.factories || []).forEach(f => { if (f.key !== ownKey()) Object.keys(f.made).forEach(i => s.add(i)); });
  return [...s].sort((a, b) => itemName(a).localeCompare(itemName(b)));
};
const ownItems = () => Object.keys(ownMade()).filter(i => i !== 'Power').sort((a, b) => itemName(a).localeCompare(itemName(b)));
// What other factories' own nodes give that their plans don't use, with what's
// still free of it (others' imports off) and what this factory brings already
function spareOffers() {
  const out = [];
  (OUTPUTS?.factories || []).forEach(f => {
    if (f.key === ownKey()) return;
    Object.keys(f.spare || {}).forEach(item => {
      const o = offer(f.key, item);
      if (!o) return;
      const mine = FROM.filter(r => r.factory === f.key && r.item === item).reduce((a, r) => a + (parseFloat(r.rate) || 0), 0);
      const ids = Object.entries(OUTPUTS.nodes || {}).filter(([, k]) => k === f.key).map(([id]) => id);   // the map keeps its own of `item`
      // what's free for this factory: what's left once the others take theirs (its own rows count back in)
      out.push({ factory: f.key, name: f.name, item, left: o.left + mine, mine, ids, stale: f.stale });
    });
  });
  return out;
}

// Map nodes other factories mine: id → factory name
const nodesTaken = () => Object.fromEntries(Object.entries(OUTPUTS?.nodes || {})
  .filter(([, k]) => k !== ownKey()).map(([id, k]) => [id, facName(k)]));

export function refreshOutputs() {
  return fetchFactoryOutputs().then(d => { OUTPUTS = d; renderNodes(); renderFrom(); renderStorage(); renderGeo(); }).catch(() => {});
}

// ── Load / sync ───────────────────────────────────────────
let wired = false;
export function loadSupply() {
  if (!wired) {
    wired = true;
    // renaming changes which factory this is, so whose claims count
    $('sc-name')?.addEventListener('change', () => { renderFrom(); renderStorage(); });
    // a new miner tier changes every miner's rate
    document.addEventListener('progress-changed', () => { syncSupply(); renderNodes(); });
  }
  UNLIM = new Set(SC.unlimited_resources || []);
  if (Array.isArray(SC.resource_nodes)) NODES = SC.resource_nodes.map(n => {
    const r = { ...n, extractor: canon(n.extractor) };
    if (r.clock != null && r.shards == null) r.shards = Math.min(MAX_SHARDS, Math.max(0, Math.round((r.clock - 100) / 50)));
    delete r.clock;
    return r;
  });
  else   // saved before nodes: each rate becomes a fixed row
    NODES = Object.entries(SC.available_resources || {}).map(([resource, rate]) =>
      ({ resource, extractor: 'fixed', rate: +rate }));
  FROM = (SC.from_factories || []).map(f => ({ ...f }));
  STO = (SC.to_storage || []).map(f => ({ ...f }));
  if ($('sh-spread')) $('sh-spread').value = SC.extractor_shards ?? '';
  CUT = [];
  syncSupply();
  renderNodes(); renderFrom(); renderStorage();
  if (NODES.some(n => n.nodes?.length)) loadMap().then(() => { syncSupply(); renderNodes(); });
  refreshOutputs();
}

export function syncSupply() {
  SC.resource_nodes = NODES.filter(n => n.resource).map(n => {
    if (isGeo(n)) return { resource: 'Geyser', extractor: GEO, nodes: [...n.nodes] };
    if (!EXTRACTORS[n.extractor]) return { resource: n.resource, extractor: 'fixed', rate: parseFloat(n.rate) || 0 };
    if (n.nodes?.length) return isWell(n)
      ? { resource: n.resource, extractor: n.extractor, nodes: [...n.nodes], shards: parseInt(n.shards, 10) || 0 }
      : { resource: n.resource, extractor: n.extractor, nodes: [...n.nodes],
          node_shards: Object.fromEntries(n.nodes.map(id => [id, parseInt(n.node_shards?.[id] ?? n.shards, 10) || 0])) };
    const r = { resource: n.resource, extractor: n.extractor, count: parseInt(n.count ?? 1, 10) || 0, shards: parseInt(n.shards, 10) || 0 };
    if (EXTRACTORS[n.extractor].purity) r.purity = n.purity || 'normal';
    if (n.at) r.at = [...n.at];          // a water-extractor pin on the map
    return r;
  });
  SC.from_factories = FROM.filter(f => f.item && f.factory)
    .map(f => ({ item: f.item, factory: f.factory, rate: parseFloat(f.rate) || 0 }));
  SC.to_storage = STO.filter(t => t.item).map(t => ({ item: t.item, rate: parseFloat(t.rate) || 0 }));
  const av = {};
  NODES.forEach(n => { if (n.resource && !isGeo(n)) av[n.resource] = (av[n.resource] || 0) + nodeRate(n); });
  SC.from_factories.forEach(f => { av[f.item] = (av[f.item] || 0) + f.rate; });
  Object.keys(av).forEach(k => { av[k] = +av[k].toFixed(6); });
  SC.available_resources = av;
  SC.unlimited_resources = [...UNLIM].filter(r => r in av);
  renderTotals();
}

// ── Resources (nodes) ─────────────────────────────────────
const opt = (v, label, on) => `<option value="${v}" ${on ? 'selected' : ''}>${label}</option>`;
const shardOpts = s => [...Array(MAX_SHARDS + 1).keys()].map(k => opt(k, `⚡${k} · ${clockOf(k)}%`, k === (parseInt(s, 10) || 0))).join('');

function purityMix(ids) {
  const c = {};
  ids.forEach(id => { const p = mapNode(id)?.p || 'normal'; c[p] = (c[p] || 0) + 1; });
  return ['pure', 'normal', 'impure'].filter(p => c[p]).map(p => `${c[p]} ${p}`).join(', ');
}

function renderNodes(focus = -1) {
  const c = $('kv-res');
  if (!c) return;
  c.innerHTML = '';
  const taken = nodesTaken();
  NODES.forEach((n, i) => {
    const row = document.createElement('div');
    row.className = 'nrow';
    const e = EXTRACTORS[n.extractor];
    const unl = UNLIM.has(n.resource);
    const map = n.nodes?.length > 0;
    const clash = map ? n.nodes.filter(id => taken[id]) : [];
    if (map && isGeo(n)) {
      row.innerHTML = `
        <div class="nrow-1">
          <div class="n-map-res">Geothermal</div>
          <div class="n-map-ex">Generator × ${n.nodes.length}</div>
          <span></span>
          <button class="bi n-x" title="Remove">✕</button>
        </div>
        <div class="nrow-2">
          <span class="n-mix">${purityMix(n.nodes)} geyser${n.nodes.length > 1 ? 's' : ''}</span>
          <button class="bsm n-edit" title="Edit on the map">map</button>
          <span class="n-rate" title="Geysers swing between half and 1.5× this; the average is counted. It adds to the power cap.">≈ ${fmt(geoMW(n))} MW</span>
          ${clash.length ? `<span class="n-sh n-warn">${clash.length} used by ${[...new Set(clash.map(id => taken[id]))].join(', ')}</span>` : ''}
        </div>`;
      row.querySelector('.n-edit').addEventListener('click', () => pickOnMap('Geyser'));
    } else if (map) {
      const sh = rowShards(n);
      row.innerHTML = `
        <div class="nrow-1">
          <div class="n-map-res">${itemName(n.resource)}</div>
          <div class="n-map-ex">${exName(n.extractor)}${isWell(n) ? '' : ` × ${n.nodes.length}`}</div>
          <button class="bi binf ${unl ? 'on' : ''}" title="${unl ? 'Unlimited — click to use the rate' : 'Unlimited (no cap, not scored)'}">∞</button>
          <button class="bi n-x" title="Remove">✕</button>
        </div>
        <div class="nrow-2">
          <span class="n-mix">${isWell(n) ? `${n.nodes.length} satellites: ` : ''}${purityMix(n.nodes)}</span>
          ${isWell(n) ? `<select class="n-sh-sel" title="Shards on the pressurizer">${shardOpts(n.shards)}</select>`
                      : `<span class="n-mix">⚡${sh}</span>`}
          <button class="bsm n-edit" title="Edit on the map">map</button>
          <span class="n-rate">${unl ? '∞' : `= ${fmt(nodeRate(n))}/min`}</span>
          ${clash.length ? `<span class="n-sh n-warn">${clash.length} mined by ${[...new Set(clash.map(id => taken[id]))].join(', ')}</span>` : ''}
        </div>`;
      row.querySelector('.n-edit').addEventListener('click', () => pickOnMap(n.resource));
      row.querySelector('.n-sh-sel')?.addEventListener('change', ev => { n.shards = +ev.target.value; syncSupply(); renderNodes(); });
    } else {
      row.innerHTML = `
        <div class="nrow-1">
          <div class="acw"><input type="text" class="n-res" placeholder="Resource…" value="${n.resource ? itemName(n.resource) : ''}"/></div>
          <select class="n-ex">${[...extractorsFor(n.resource).map(k => opt(k, exName(k), k === n.extractor)),
            opt('fixed', 'Fixed rate', !e)].join('')}</select>
          <button class="bi binf ${unl ? 'on' : ''}" title="${unl ? 'Unlimited — click to use the rate' : 'Unlimited (no cap, not scored)'}">∞</button>
          <button class="bi n-x" title="Remove">✕</button>
        </div>
        <div class="nrow-2">${e ? `
          ${e.purity ? `<select class="n-pu">${Object.keys(PURITY).map(p => opt(p, p[0].toUpperCase() + p.slice(1), p === (n.purity || 'normal'))).join('')}</select>` : ''}
          <label>× <input type="number" class="n-ct" min="0" step="1" value="${n.count ?? 1}" title="How many"/></label>
          <select class="n-sh-sel" title="Power shards on each">${shardOpts(n.shards)}</select>
          ${n.at ? `<button class="bsm n-edit" title="A pin on the map at ${n.at.join(', ')} m">📍 map</button>` : ''}
          <span class="n-rate">${unl ? '∞' : `= ${fmt(nodeRate(n))}/min`}</span>`
        : `<input type="text" inputmode="decimal" class="n-rate-in" placeholder="/min" value="${n.rate ?? ''}"/><span class="n-rate">/min</span>`}
        </div>`;
      const ri = row.querySelector('.n-res');
      const setRes = key => {
        n.resource = key;
        if (n.extractor !== 'fixed' && !extractorsFor(key).includes(n.extractor)) n.extractor = defaultExtractor(key);
        syncSupply(); renderNodes();
      };
      makeAC(ri, setRes, null, resourcePool);
      ri.addEventListener('change', () => {
        const v = ri.value.trim().toLowerCase();
        const k = ALL_ITEMS.find(x => x.toLowerCase() === v.replace(/\s+/g, '_') || itemName(x).toLowerCase() === v);
        if (k && k !== n.resource) setRes(k);
      });
      row.querySelector('.n-ex').addEventListener('change', ev => {
        const prev = nodeRate(n);
        n.extractor = ev.target.value;
        if (n.extractor === 'fixed') n.rate = +prev.toFixed(3);
        else { n.count ??= 1; n.shards ??= 0; n.purity ??= 'normal'; }
        syncSupply(); renderNodes();
      });
      row.querySelector('.n-edit')?.addEventListener('click', () => pickOnMap('Water'));
      const repaint = () => { syncSupply(); row.querySelector('.n-rate').textContent = unl ? '∞' : `= ${fmt(nodeRate(n))}/min`; renderShardTotal(); };
      row.querySelector('.n-pu')?.addEventListener('change', ev => { n.purity = ev.target.value; repaint(); });
      row.querySelector('.n-ct')?.addEventListener('input', ev => { n.count = ev.target.value; repaint(); });
      row.querySelector('.n-sh-sel')?.addEventListener('change', ev => { n.shards = +ev.target.value; repaint(); });
      const rin = row.querySelector('.n-rate-in');
      rin?.addEventListener('input', () => { n.rate = rin.value; syncSupply(); });
      rin?.addEventListener('blur', () => {
        const v = evalExpr(rin.value);
        if (v !== null) { rin.value = n.rate = parseFloat(v.toPrecision(6)); syncSupply(); }
      });
      if (unl) row.querySelectorAll('.nrow-2 input, .nrow-2 select').forEach(x => { x.disabled = true; });
      if (i === focus) requestAnimationFrame(() => ri.focus());
    }
    row.querySelector('.binf')?.addEventListener('click', () => {
      if (!n.resource) return;
      UNLIM.has(n.resource) ? UNLIM.delete(n.resource) : UNLIM.add(n.resource);
      syncSupply(); renderNodes();
    });
    row.querySelector('.n-x').addEventListener('click', () => { NODES.splice(i, 1); syncSupply(); renderNodes(); });
    c.appendChild(row);
  });
  renderShardTotal();
  renderTotals();
}

const extractorShards = () => NODES.reduce((s, r) => s + (UNLIM.has(r.resource) ? 0 : rowShards(r)), 0);

function renderShardTotal() {
  const el = $('sh-total');
  if (el) {
    const n = extractorShards();
    el.textContent = n ? `${n} on extractors` : '';
  }
  renderGeo();
}

// Geysers' power, beside the power cap it adds to
function renderGeo() {
  const geo = $('geo-note');
  if (!geo) return;
  const mw = NODES.reduce((a, n) => a + geoMW(n), 0);
  geo.textContent = mw ? `+ ${fmt(mw)} geothermal` : '';
}

export function addNode() {
  NODES.push({ resource: '', extractor: 'Miner', purity: 'normal', count: 1, shards: 0 });
  renderNodes(NODES.length - 1);
}

// Map rows: one per resource for miners and oil extractors, one per well
// Map rows: one per resource for miners and oil extractors, one per well, one
// for the geothermal generators; water pins are water-extractor rows with a place
export function pickOnMap(resource = null) {
  const picked = new Set(), shards = {};
  NODES.filter(n => n.nodes?.length).forEach(n => n.nodes.forEach(id => {
    picked.add(id);
    if (isGeo(n)) return;
    if (isWell(n)) shards[mapNode(id)?.w || id] = parseInt(n.shards, 10) || 0;
    else shards[id] = parseInt(n.node_shards?.[id] ?? n.shards, 10) || 0;
  }));
  const pins = NODES.filter(n => n.at).map(n => ({ x: n.at[0], y: n.at[1], count: parseInt(n.count ?? 1, 10) || 1, shards: parseInt(n.shards, 10) || 0 }));
  openMapPicker({
    resource, picked, shards, pins, taken: nodesTaken(), minerRate: MINER_TIERS[PROGRESS.miner], spare: spareOffers(),
    onApply: (ids, sh, newPins, brought = []) => {
      // what's brought from other factories' unused nodes: their import rows here
      brought.forEach(b => {
        const rows = FROM.filter(r => r.factory === b.factory && r.item === b.item);
        if (b.rate > 1e-6) {
          if (rows.length) { rows[0].rate = down(b.rate); rows.slice(1).forEach(r => FROM.splice(FROM.indexOf(r), 1)); }
          else FROM.push({ item: b.item, factory: b.factory, rate: down(b.rate) });
        } else rows.forEach(r => FROM.splice(FROM.indexOf(r), 1));
      });
      if (brought.length) renderFrom();
      const kept = NODES.filter(n => !n.nodes?.length && !n.at);
      const byRes = {}, wells = {}, geysers = [];
      [...ids].forEach(id => {
        const m = mapNode(id);
        if (!m) return;
        if (m.r === 'Geyser') geysers.push(id);
        else if (m.w) (wells[m.w] = wells[m.w] || { resource: m.r, nodes: [] }).nodes.push(id);
        else (byRes[m.r] = byRes[m.r] || []).push(id);
      });
      const rows = [
        ...Object.entries(byRes).map(([r, list]) => ({ resource: r, extractor: r === 'Crude_Oil' ? 'Oil_Extractor' : 'Miner',
          nodes: list, node_shards: Object.fromEntries(list.map(id => [id, sh[id] || 0])) })),
        ...Object.entries(wells).map(([w, x]) => ({ resource: x.resource, extractor: 'Resource_Well', nodes: x.nodes, shards: sh[w] || 0 })),
        ...newPins.map(p => ({ resource: 'Water', extractor: 'Water_Extractor', count: p.count, shards: p.shards || 0, at: [p.x, p.y] })),
      ].sort((a, b) => itemName(a.resource).localeCompare(itemName(b.resource)));
      if (geysers.length) rows.push({ resource: 'Geyser', extractor: GEO, nodes: geysers });
      NODES = [...rows, ...kept];
      syncSupply(); renderNodes();
    },
  });
}

// One line per resource when several rows add up, or imports join in
function renderTotals() {
  const el = $('res-total');
  if (!el) return;
  const av = SC.available_resources || {};
  const rows = {};
  NODES.forEach(n => { if (n.resource) rows[n.resource] = (rows[n.resource] || 0) + 1; });
  FROM.forEach(f => { if (f.item && f.factory) rows[f.item] = (rows[f.item] || 0) + 1; });
  const multi = Object.keys(rows).filter(k => rows[k] > 1);
  el.innerHTML = multi.length ? 'Total: ' + multi.map(k =>
    `${itemName(k)} <b>${UNLIM.has(k) ? '∞' : fmt(av[k] || 0)}</b>`).join(' · ') : '';
}

// ── From factories ────────────────────────────────────────
function renderFrom(focus = -1) {
  const c = $('kv-from');
  if (!c) return;
  c.innerHTML = '';
  PAINTS = PAINTS.filter(p => p.storage);
  if (CUT.length) {
    c.insertAdjacentHTML('beforeend', `<p class="n-hint n-warn">Saved with less than asked — already taken: ${
      CUT.map(x => x.kind === 'node' ? `a ${itemName(x.item || '')} node (mined by ${facName(x.factory)})`
        : `${itemName(x.item)}${x.kind === 'storage' ? ' to storage' : ` from ${facName(x.factory)}`} ${fmt(x.asked)} → ${fmt(x.rate)}`).join('; ')}.</p>`);
  }
  if (OUTPUTS && !madeItems().length && !FROM.length)
    c.insertAdjacentHTML('beforeend', '<p class="n-hint">Nothing yet — solve and save another factory first.</p>');
  FROM.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'nrow';
    const makers = makersOf(f.item);
    row.innerHTML = `
      <div class="nrow-1 nrow-from">
        <div class="acw"><input type="text" class="f-item" placeholder="Item…" value="${f.item ? itemName(f.item) : ''}"/></div>
        <input type="text" inputmode="decimal" class="f-rate" placeholder="/min" value="${f.rate ?? ''}"/>
        <button class="bi n-x" title="Remove">✕</button>
      </div>
      <div class="nrow-2">
        <select class="f-fac">${f.factory ? '' : opt('', 'From factory…', true)}${makers.map(m => opt(m.key, m.name, m.key === f.factory)).join('')}
          ${f.factory && !makers.some(m => m.key === f.factory) ? opt(f.factory, `${facName(f.factory)} (doesn't make it now)`, true) : ''}</select>
        <span class="n-rate f-note"></span>
        <button class="bsm f-use" style="display:none" title="Take what's left instead">use</button>
      </div>`;
    const note = row.querySelector('.f-note'), rin = row.querySelector('.f-rate'), use = row.querySelector('.f-use');
    const paint = () => {
      const o = f.factory ? offer(f.factory, f.item, f) : null;
      note.classList.remove('n-warn');
      use.style.display = 'none';
      if (!f.factory || !o) {
        note.textContent = f.factory && OUTPUTS ? 'not made there now' : '';
        if (f.factory && OUTPUTS) note.classList.add('n-warn');
        return;
      }
      const takers = Object.keys(o.by).filter(k => k !== ownKey()).map(facName);
      note.textContent = (o.left < 1e-6 && takers.length ? `all taken by ${takers.join(', ')}` : `up to ${fmt(o.left)}`)
        + (o.stale ? ' · old plan' : !o.solved ? ' · not solved' : '');
      note.title = [`${facName(f.factory)} makes ${fmt(o.made)}/min`
        + (o.stale ? ' (its last plan — it changed since)' : !o.solved ? ' (its declared rate — not solved)' : ''),
        ...Object.entries(o.by).map(([k, v]) => `${k === ownKey() ? 'Your other rows take' : `${facName(k)} ${k === STORAGE ? 'gets' : 'takes'}`} ${fmt(v)}`)].join('\n');
      const over = (parseFloat(f.rate) || 0) - o.left;
      if (over > 1e-3) {
        note.classList.add('n-warn');
        note.textContent = `${fmt(over)} over — ${note.textContent}`;
        use.style.display = '';
        use.textContent = `use ${fmt(down(o.left))}`;
      }
    };
    use.addEventListener('click', () => {
      const o = offer(f.factory, f.item, f);
      if (!o) return;
      f.rate = down(o.left); rin.value = f.rate;
      syncSupply(); PAINTS.forEach(p => p());
    });
    const setItem = key => {
      f.item = key;
      const ms = makersOf(key);
      if (!ms.some(m => m.key === f.factory)) f.factory = ms.length === 1 ? ms[0].key : '';
      if (f.factory) f.rate = down(offer(f.factory, key, f).left);
      syncSupply(); renderFrom(ms.length > 1 ? -1 : i);
      if (ms.length > 1) requestAnimationFrame(() => $('kv-from').querySelectorAll('.nrow')[i]?.querySelector('.f-fac')?.focus());
    };
    makeAC(row.querySelector('.f-item'), setItem, null, madeItems);
    row.querySelector('.f-fac').addEventListener('change', ev => {
      f.factory = ev.target.value;
      const of = offer(f.factory, f.item, f);
      if (of) f.rate = down(of.left);
      syncSupply(); renderFrom();
    });
    rin.addEventListener('input', () => { f.rate = rin.value; syncSupply(); PAINTS.forEach(p => p()); });
    rin.addEventListener('blur', () => {
      let v = evalExpr(rin.value);
      if (v === null) return;
      const of = f.factory && offer(f.factory, f.item, f);
      if (of) v = Math.min(v, of.left);            // no more than that factory has left
      rin.value = f.rate = parseFloat(Math.max(0, v).toPrecision(6));
      syncSupply(); PAINTS.forEach(p => p());
    });
    row.querySelector('.n-x').addEventListener('click', () => { FROM.splice(i, 1); syncSupply(); renderFrom(); });
    PAINTS.push(paint);
    paint();
    c.appendChild(row);
    if (i === focus) requestAnimationFrame(() => rin.focus());
  });
  renderTotals();
}

export function addFrom() {
  FROM.push({ item: '', factory: '', rate: '' });
  renderFrom();
  requestAnimationFrame(() => [...$('kv-from').querySelectorAll('.nrow')].pop()?.querySelector('.f-item')?.focus());
}

// Everything the other factories have left, as imports — a start for a factory built on leftovers
export function addLeftovers() {
  let n = 0;
  (OUTPUTS?.factories || []).forEach(fac => {
    if (fac.key === ownKey()) return;
    Object.keys(fac.made).forEach(item => {
      if (FROM.some(r => r.factory === fac.key && r.item === item)) return;
      const o = offer(fac.key, item);
      if (o && o.left > 1e-3) { FROM.push({ item, factory: fac.key, rate: down(o.left) }); n++; }
    });
  });
  syncSupply(); renderFrom();
  return n;
}

// ── To storage, and what's sent out ───────────────────────
function renderStorage() {
  const c = $('kv-sto');
  if (!c) return;
  c.innerHTML = '';
  PAINTS = PAINTS.filter(p => !p.storage);
  STO.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'nrow';
    row.innerHTML = `
      <div class="nrow-1 nrow-from">
        <div class="acw"><input type="text" class="f-item" placeholder="Item it makes…" value="${t.item ? itemName(t.item) : ''}"/></div>
        <input type="text" inputmode="decimal" class="f-rate" placeholder="/min" value="${t.rate ?? ''}"/>
        <button class="bi n-x" title="Remove">✕</button>
      </div>
      <div class="nrow-2"><span class="n-rate f-note"></span></div>`;
    const note = row.querySelector('.f-note'), rin = row.querySelector('.f-rate');
    const paint = () => {
      const o = t.item ? storeOffer(t.item, t) : null;
      note.classList.remove('n-warn');
      if (!t.item) { note.textContent = ''; return; }
      if (!o) { note.textContent = 'not made here now — solve to check'; note.classList.add('n-warn'); return; }
      note.textContent = `up to ${fmt(o.left)}`;
      note.title = [`This factory makes ${fmt(o.made)}/min`,
        ...Object.entries(o.by).map(([k, v]) => `${facName(k)} takes ${fmt(v)}`),
        ...(o.mine ? [`Your other storage rows: ${fmt(o.mine)}`] : [])].join('\n');
      const over = (parseFloat(t.rate) || 0) - o.left;
      if (over > 1e-3) { note.classList.add('n-warn'); note.textContent = `${fmt(over)} over — ${note.textContent}`; }
    };
    paint.storage = true;
    makeAC(row.querySelector('.f-item'), key => {
      t.item = key;
      const o = storeOffer(key, t);
      if (o) t.rate = down(o.left);
      syncSupply(); renderStorage();
    }, null, ownItems);
    rin.addEventListener('input', () => { t.rate = rin.value; syncSupply(); PAINTS.forEach(p => p()); renderSentOut(); });
    rin.addEventListener('blur', () => {
      let v = evalExpr(rin.value);
      if (v === null) return;
      const o = t.item && storeOffer(t.item, t);
      if (o) v = Math.min(v, o.left);
      rin.value = t.rate = parseFloat(Math.max(0, v).toPrecision(6));
      syncSupply(); PAINTS.forEach(p => p()); renderSentOut();
    });
    row.querySelector('.n-x').addEventListener('click', () => { STO.splice(i, 1); syncSupply(); renderStorage(); });
    PAINTS.push(paint);
    paint();
    c.appendChild(row);
  });
  renderSentOut();
}

export function addStorage() {
  STO.push({ item: '', rate: '' });
  renderStorage();
  requestAnimationFrame(() => [...$('kv-sto').querySelectorAll('.nrow')].pop()?.querySelector('.f-item')?.focus());
}

// Everything this factory owes: other factories' imports from it, and its storage
function renderSentOut() {
  const el = $('sent-out');
  if (!el) return;
  const out = {};
  Object.entries(OUTPUTS?.claims[ownKey()] || {}).forEach(([item, by]) => Object.entries(by).forEach(([k, v]) => {
    if (k !== STORAGE && k !== ownKey() && v > 1e-6) (out[item] = out[item] || []).push([facName(k), v]);
  }));
  STO.forEach(t => { const v = parseFloat(t.rate) || 0; if (t.item && v > 0) (out[t.item] = out[t.item] || []).push(['Storage', v]); });
  const made = ownMade();
  const unmet = RESULT?.owed_unmet || {};
  const items = Object.keys(out).sort((a, b) => itemName(a).localeCompare(itemName(b)));
  const takers = new Set(Object.values(OUTPUTS?.claims[ownKey()] || {}).flatMap(by => Object.keys(by)).filter(k => k !== STORAGE && k !== ownKey()));
  const again = takers.size && OUTPUTS?.factories.some(f => f.key === ownKey())
    ? `<button class="bsm" id="chain-down" title="Solve this factory, then everything that takes from it, in order">↻ Re-solve this and the ${takers.size} that take from it</button>` : '';
  el.innerHTML = (items.length ? `<div class="n-sent-t">Sent out <span>— solving makes at least this</span></div>` + items.map(it => {
    const total = out[it].reduce((s, [, v]) => s + v, 0);
    const short = unmet[it] ?? (made[it] != null ? total - made[it] : 0);
    return `<div class="n-sent ${short > 1e-3 ? 'n-warn' : ''}"><span>${itemName(it)} <b>${fmt(total)}</b></span>
      <span>${out[it].map(([n, v]) => `${n} ${fmt(v)}`).join(' · ')}${short > 1e-3 ? ` — ${fmt(short)} short` : ''}</span></div>`;
  }).join('') : '') + again + '<div id="chain-side"></div>';
  $('chain-down')?.addEventListener('click', () =>
    document.dispatchEvent(new CustomEvent('resolve-chain', { detail: { keys: [ownKey()] } })));
}

// The server capped some claims on save (another factory got there first)
export function applyCut(res) {
  FROM = (res.from_factories || []).map(f => ({ ...f }));
  STO = (res.to_storage || []).map(f => ({ ...f }));
  if (res.resource_nodes) NODES = res.resource_nodes.map(n => ({ ...n }));
  CUT = res.cut || [];
  syncSupply();
  refreshOutputs().then(() => { CUT = []; });
}

// After a solve: storage offers and sent-out shortfalls follow the new plan
export function onResult() { PAINTS.forEach(p => p()); renderSentOut(); }
