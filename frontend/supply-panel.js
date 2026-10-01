/**
 * supply-panel.js — what a factory is built on.
 *
 * Resources: the nodes it mines — resource, extractor, purity, how many, clock —
 * each giving its rate (supply.py has the same table). "Fixed rate" is a plain
 * number, for anything not mined from a node. ∞ marks a resource unlimited.
 *
 * From factories: what it takes from other saved factories. The item list is
 * everything they make (their last plans); pick the factory it comes from and
 * the rate starts at what that factory has left — what it makes, less what
 * other factories already take — which is also the most you can enter.
 *
 * Both add up into SC.available_resources, all the solver sees.
 */

import { SC, EXTRACTORS, PURITY, MAX_CLOCK, ALL_ITEMS, itemName } from './state.js';
import { makeAC } from './sidebar.js';
import { evalExpr } from './kv-panel.js';
import { fetchFactoryOutputs } from './api.js';

const $ = id => document.getElementById(id);
const fmt = v => (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : +v.toFixed(2)).toLocaleString();
// This factory's save key (as handleSave makes it), from the name as typed
const ownKey = () => (document.getElementById('sc-name')?.value || SC.name || '').replace(/\s+/g, '_').toLowerCase();

let NODES = [];       // rows, as SC.resource_nodes
let FROM = [];        // rows, as SC.from_factories
let UNLIM = new Set();
let OUTPUTS = null;   // /api/factory-outputs
let PAINTS = [];

// ── Rates ─────────────────────────────────────────────────
export function nodeRate(n) {
  const e = EXTRACTORS[n.extractor];
  if (!e) return Math.max(0, parseFloat(n.rate) || 0);
  const clock = Math.min(MAX_CLOCK, Math.max(1, parseFloat(n.clock) || 100));
  let each = e.rate * (e.purity ? PURITY[n.purity || 'normal'] ?? 1 : 1) * clock / 100;
  if (e.cap) each = Math.min(each, e.cap);
  return each * Math.max(0, n.count == null || n.count === '' ? 1 : parseInt(n.count, 10) || 0);
}

// Power shards the extractors' clock takes: one per 50% over 100%, each
const shardsFor = n => (EXTRACTORS[n.extractor] && n.clock > 100
  ? Math.ceil((Math.min(MAX_CLOCK, n.clock) - 100) / 50 - 1e-9) * (parseInt(n.count, 10) || 0) : 0);

// Node resources first, then anything else (a fixed rate)
const resourcePool = () => {
  const nodes = [...new Set(Object.values(EXTRACTORS).flatMap(e => e.for))];
  return [...nodes, ...ALL_ITEMS.filter(k => !nodes.includes(k))];
};
const extractorsFor = res => Object.entries(EXTRACTORS).filter(([, e]) => e.for.includes(res)).map(([k]) => k);
const defaultExtractor = res => {
  const ok = extractorsFor(res);
  return ['Miner_Mk3', 'Oil_Extractor', 'Water_Extractor', 'Resource_Well'].find(k => ok.includes(k)) || 'fixed';
};

// ── Factory outputs ───────────────────────────────────────
// Per other factory and item: { made, others (taken by other factories), left }
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
  return { made, others, by, left: Math.max(0, made - others), stale: f.stale, solved: f.solved };
}
const makersOf = item => (OUTPUTS?.factories || []).filter(f => f.key !== ownKey() && f.made[item] != null);
const madeItems = () => {
  const s = new Set();
  (OUTPUTS?.factories || []).forEach(f => { if (f.key !== ownKey()) Object.keys(f.made).forEach(i => s.add(i)); });
  return [...s].sort((a, b) => itemName(a).localeCompare(itemName(b)));
};

export function refreshOutputs() {
  return fetchFactoryOutputs().then(d => { OUTPUTS = d; renderFrom(); }).catch(() => {});
}

// ── Load / sync ───────────────────────────────────────────
let wired = false;
export function loadSupply() {
  if (!wired) {   // renaming changes which factory this is, so whose claims count
    wired = true;
    document.getElementById('sc-name')?.addEventListener('change', () => renderFrom());
  }
  UNLIM = new Set(SC.unlimited_resources || []);
  if (Array.isArray(SC.resource_nodes)) NODES = SC.resource_nodes.map(n => ({ ...n }));
  else   // saved before nodes: each rate becomes a fixed row
    NODES = Object.entries(SC.available_resources || {}).map(([resource, rate]) =>
      ({ resource, extractor: 'fixed', rate: +rate }));
  FROM = (SC.from_factories || []).map(f => ({ ...f }));
  renderNodes();
  renderFrom();
  refreshOutputs();
}

export function syncSupply() {
  SC.resource_nodes = NODES.filter(n => n.resource).map(n => EXTRACTORS[n.extractor]
    ? { resource: n.resource, extractor: n.extractor, purity: EXTRACTORS[n.extractor].purity ? n.purity || 'normal' : undefined,
        count: parseInt(n.count, 10) || 0, clock: parseFloat(n.clock) || 100 }
    : { resource: n.resource, extractor: 'fixed', rate: parseFloat(n.rate) || 0 });
  SC.resource_nodes.forEach(n => { if (n.purity === undefined) delete n.purity; });
  SC.from_factories = FROM.filter(f => f.item && f.factory)
    .map(f => ({ item: f.item, factory: f.factory, rate: parseFloat(f.rate) || 0 }));
  const av = {};
  NODES.forEach(n => { if (n.resource) av[n.resource] = (av[n.resource] || 0) + nodeRate(n); });
  SC.from_factories.forEach(f => { av[f.item] = (av[f.item] || 0) + f.rate; });
  Object.keys(av).forEach(k => { av[k] = +av[k].toFixed(6); });
  SC.available_resources = av;
  SC.unlimited_resources = [...UNLIM].filter(r => r in av);
  renderTotals();
}

// ── Resources (nodes) ─────────────────────────────────────
const opt = (v, label, on) => `<option value="${v}" ${on ? 'selected' : ''}>${label}</option>`;

function renderNodes(focus = -1) {
  const c = $('kv-res');
  c.innerHTML = '';
  NODES.forEach((n, i) => {
    const row = document.createElement('div');
    row.className = 'nrow';
    const e = EXTRACTORS[n.extractor];
    const unl = UNLIM.has(n.resource);
    row.innerHTML = `
      <div class="nrow-1">
        <div class="acw"><input type="text" class="n-res" placeholder="Resource…" value="${n.resource ? itemName(n.resource) : ''}"/></div>
        <select class="n-ex">${[...extractorsFor(n.resource).map(k => opt(k, EXTRACTORS[k].display, k === n.extractor)),
          opt('fixed', 'Fixed rate', !e)].join('')}</select>
        <button class="bi binf ${unl ? 'on' : ''}" title="${unl ? 'Unlimited — click to use the rate' : 'Unlimited (no cap, not scored)'}">∞</button>
        <button class="bi n-x" title="Remove">✕</button>
      </div>
      <div class="nrow-2">${e ? `
        ${e.purity ? `<select class="n-pu">${Object.keys(PURITY).map(p => opt(p, p[0].toUpperCase() + p.slice(1), p === (n.purity || 'normal'))).join('')}</select>` : ''}
        <label>× <input type="number" class="n-ct" min="0" step="1" value="${n.count ?? 1}" title="${n.extractor === 'Resource_Well' ? 'Satellite nodes' : 'How many'}"/></label>
        <label><input type="number" class="n-cl" min="1" max="${MAX_CLOCK}" step="any" value="${n.clock ?? 100}" title="Clock speed"/> %</label>
        <span class="n-rate"></span><span class="n-sh"></span>`
      : `<input type="text" inputmode="decimal" class="n-rate-in" placeholder="/min" value="${n.rate ?? ''}"/><span class="n-rate"></span>`}
      </div>`;
    const ri = row.querySelector('.n-res');
    const paintRate = () => {
      const r = row.querySelector('.n-rate');
      if (unl) { r.textContent = '∞'; return; }
      const sh = shardsFor(n), shEl = row.querySelector('.n-sh');
      r.textContent = e ? `= ${fmt(nodeRate(n))}/min` : '/min';
      if (shEl) shEl.textContent = sh ? `${sh} power shard${sh > 1 ? 's' : ''} on the extractors` : '';
    };
    const setRes = key => {
      n.resource = key;
      if (n.extractor !== 'fixed' && !extractorsFor(key).includes(n.extractor) || !n.extractor)
        n.extractor = defaultExtractor(key);
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
      else { n.count ??= 1; n.clock ??= 100; n.purity ??= 'normal'; }
      syncSupply(); renderNodes();
    });
    row.querySelector('.n-pu')?.addEventListener('change', ev => { n.purity = ev.target.value; syncSupply(); paintRate(); });
    row.querySelector('.n-ct')?.addEventListener('input', ev => { n.count = ev.target.value; syncSupply(); paintRate(); });
    const cl = row.querySelector('.n-cl');
    cl?.addEventListener('input', () => { n.clock = cl.value; syncSupply(); paintRate(); });
    cl?.addEventListener('blur', () => {
      const v = Math.min(MAX_CLOCK, Math.max(1, parseFloat(cl.value) || 100));
      cl.value = n.clock = v; syncSupply(); paintRate();
    });
    const rin = row.querySelector('.n-rate-in');
    rin?.addEventListener('input', () => { n.rate = rin.value; syncSupply(); });
    rin?.addEventListener('blur', () => {
      const v = evalExpr(rin.value);
      if (v !== null) { rin.value = n.rate = parseFloat(v.toPrecision(6)); syncSupply(); }
    });
    row.querySelector('.binf').addEventListener('click', () => {
      if (!n.resource) return;
      UNLIM.has(n.resource) ? UNLIM.delete(n.resource) : UNLIM.add(n.resource);
      syncSupply(); renderNodes();
    });
    row.querySelector('.n-x').addEventListener('click', () => { NODES.splice(i, 1); syncSupply(); renderNodes(); });
    if (unl) row.querySelectorAll('.nrow-2 input, .nrow-2 select').forEach(x => { x.disabled = true; });
    paintRate();
    c.appendChild(row);
    if (i === focus) requestAnimationFrame(() => ri.focus());
  });
  renderTotals();
}

export function addNode() {
  NODES.push({ resource: '', extractor: 'Miner_Mk3', purity: 'normal', count: 1, clock: 100 });
  renderNodes(NODES.length - 1);
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
  PAINTS = [];   // every row's note, repainted when any rate changes (they share what's left)
  if (CUT.length) {
    const name = k => OUTPUTS?.factories.find(x => x.key === k)?.name || k;
    c.insertAdjacentHTML('beforeend', `<p class="n-hint n-warn">Saved with less than asked — already taken by other factories: ${
      CUT.map(x => `${itemName(x.item)} from ${name(x.factory)} ${fmt(x.asked)} → ${fmt(x.rate)}`).join('; ')}.</p>`);
    CUT = [];
  }
  if (OUTPUTS && !madeItems().length && !FROM.length)
    c.innerHTML = '<p class="n-hint">Nothing yet — solve and save another factory first.</p>';
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
          ${f.factory && !makers.some(m => m.key === f.factory) ? opt(f.factory, `${f.factory} (doesn't make it now)`, true) : ''}</select>
        <span class="n-rate f-note"></span>
      </div>`;
    const note = row.querySelector('.f-note'), rin = row.querySelector('.f-rate');
    const paint = () => {
      const o = f.factory ? offer(f.factory, f.item, f) : null;
      note.classList.remove('n-warn');
      if (!f.factory || !o) { note.textContent = f.factory && OUTPUTS ? 'not made there now' : ''; if (f.factory && OUTPUTS) note.classList.add('n-warn'); return; }
      const name = k => OUTPUTS.factories.find(x => x.key === k)?.name || k;
      const takers = Object.keys(o.by).filter(k => k !== ownKey()).map(name);
      note.textContent = (o.left < 1e-6 && takers.length ? `all taken by ${takers.join(', ')}` : `up to ${fmt(o.left)}`) + (o.stale ? ' · old plan' : !o.solved ? ' · not solved' : '');
      note.title = [`${name(f.factory)} makes ${fmt(o.made)}/min`
        + (o.stale ? ' (its last plan — it changed since)' : !o.solved ? ' (its declared rate — not solved)' : ''),
        ...Object.entries(o.by).map(([k, v]) => `${k === ownKey() ? 'Your other rows take' : `${name(k)} takes`} ${fmt(v)}`)].join('\n');
      const over = (parseFloat(f.rate) || 0) - o.left;
      if (over > 1e-6) { note.classList.add('n-warn'); note.textContent = `${fmt(over)} over — ` + note.textContent; }
    };
    const setItem = key => {
      f.item = key;
      const ms = makersOf(key);
      if (!ms.some(m => m.key === f.factory)) f.factory = ms.length === 1 ? ms[0].key : '';
      if (f.factory) f.rate = +offer(f.factory, key, f).left.toFixed(3);
      syncSupply(); renderFrom(ms.length > 1 ? -1 : i);
      if (ms.length > 1) requestAnimationFrame(() => $('kv-from').children[i]?.querySelector('.f-fac')?.focus());
    };
    makeAC(row.querySelector('.f-item'), setItem, null, madeItems);
    row.querySelector('.f-fac').addEventListener('change', ev => {
      f.factory = ev.target.value;
      const of = offer(f.factory, f.item, f);
      if (of) f.rate = +of.left.toFixed(3);
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
  requestAnimationFrame(() => $('kv-from').lastElementChild?.querySelector('.f-item')?.focus());
}

// The server capped some imports on save (another factory took that share
// first): show the saved rates and say what changed
let CUT = [];
export function applyCut(rows, cut) {
  FROM = (rows || []).map(f => ({ ...f }));
  CUT = cut || [];
  syncSupply();
  refreshOutputs();
}
