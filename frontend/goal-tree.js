/**
 * goal-tree.js — the Tree view in the middle: what your resources can become.
 *
 * Each resource you have is a root on the left; every step of processing is a
 * column further right, so branches meet where a recipe takes two of them and
 * split where one part feeds many. A part's column is the fewest steps it
 * takes from what you have (with the recipes your unlocks allow).
 *
 * Click a tile to set its goal — maximize (weight), exact, at least, at most,
 * a range — and how much to store. "What's next" adds, faded, what you can't
 * make yet (other resources, milestones not done); hover one to see it, and
 * click it for what it needs at a rate you pick: the parts you can't make,
 * where to get them (a factory with some left, the map, or a fixed supply),
 * and the milestone or machine it waits on. Accept one and it's in your
 * resources; the tree grows to match. Faded tiles stay out of the fit.
 */
import { RECIPES, ALL_ITEMS, itemName, SC, PROGRESS, UNLOCKED_ALTS, lockedBy, unlockName, UNLOCKS, mCol, MABBR } from './state.js';
import { goalOf, setGoal, evalExpr } from './kv-panel.js';
import { storageOf, setStorage, sourcesOf, bringIn, pickOnMap } from './supply-panel.js';
import { saveProgress } from './api.js';
import { openRecipes } from './recipe-lookup.js';

const $ = id => document.getElementById(id);
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = v => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : +v.toFixed(v < 10 ? 2 : 1)).toLocaleString();
const EVENT = /FICSMAS|Snowball|Candy_Cane|Fireworks/;
const TW = 150, TH = 34, CW = 210, RH = 42;          // tile, column and row sizes (px at zoom 1)

let T = null;                 // the built tree: { tiles: {item: tile}, edges, raw, bounds }
let VIEW = null, NEXT = false, OPEN = null;

// Packing is for moving fluids about, not a step of making: unpacking never
// shows, and packing only where a recipe takes the packaged item
let USED = null;
function transport(k, r) {
  if (r.machine !== 'Packager') return false;
  if (!USED) {
    USED = new Set();
    Object.values(RECIPES).forEach(x => { if (x.machine !== 'Packager') Object.keys(x.inputs).forEach(i => USED.add(i)); });
  }
  return k.startsWith('Unpackage_') || !Object.keys(r.outputs).some(o => USED.has(o));
}

// Items nothing makes (other than the converter's swaps): mined, pumped, found
let RAW = null;
function raw() {
  if (RAW) return RAW;
  const made = new Set();
  Object.entries(RECIPES).forEach(([k, r]) => { if (r.machine !== 'Converter' && !transport(k, r)) Object.keys(r.outputs).forEach(i => made.add(i)); });
  RAW = new Set(ALL_ITEMS.filter(i => !made.has(i) && Object.entries(RECIPES).some(([k, r]) => r.inputs[i] && !transport(k, r))));
  return RAW;
}

const machineOn = m => !PROGRESS.machines || PROGRESS.machines.includes(m);
const altOn = k => UNLOCKED_ALTS.has(k) || (SC.alternate_recipes_enabled || []).includes(k);
// The recipes a solve here may use; and those you could later (any machine or milestone, unlocked alternates)
const nowOk = (k, r) => !EVENT.test(k) && !transport(k, r) && machineOn(r.machine) && !lockedBy(k) && (!r.alternate || altOn(k));
const laterOk = (k, r) => !EVENT.test(k) && !transport(k, r) && (!r.alternate || altOn(k));

// Fewest steps to each item from `have`, with the recipes `ok` allows
function levels(have, ok) {
  const lv = new Map([...have].map(i => [i, 0]));
  const rs = Object.entries(RECIPES).filter(([k, r]) => ok(k, r));
  for (let changed = true, n = 0; changed && n < 60; n++) {
    changed = false;
    rs.forEach(([, r]) => {
      const ins = Object.keys(r.inputs);
      if (!ins.every(i => lv.has(i))) return;
      const l = 1 + Math.max(0, ...ins.map(i => lv.get(i)));
      Object.keys(r.outputs).forEach(o => { if (!(lv.get(o) <= l)) { lv.set(o, l); changed = true; } });
    });
  }
  return lv;
}

function build() {
  const have = new Set(Object.keys(SC.available_resources || {}).filter(i => (SC.available_resources[i] || 0) > 0));
  (SC.unlimited_resources || []).forEach(i => have.add(i));
  const now = levels(have, nowOk);
  const later = NEXT ? levels(new Set([...raw(), ...have]), laterOk) : new Map();
  const tiles = {};
  now.forEach((l, i) => { tiles[i] = { item: i, level: l, ghost: false, root: have.has(i) }; });
  later.forEach((l, i) => { if (!tiles[i]) tiles[i] = { item: i, level: l, ghost: true, root: raw().has(i) }; });
  // every way an item's made from items on the tree: an edge from each input
  const edges = new Map();
  Object.entries(RECIPES).forEach(([k, r]) => {
    const real = nowOk(k, r);
    if (!real && !(NEXT && laterOk(k, r))) return;
    const ins = Object.keys(r.inputs);
    if (!ins.every(i => tiles[i])) return;
    Object.keys(r.outputs).forEach(o => {
      if (!tiles[o]) return;
      ins.forEach(i => {
        if (i === o || tiles[i].level >= tiles[o].level) return;          // back the other way (unpacking, loops): left out
        const key = i + '>' + o, ghost = !real || tiles[i].ghost || tiles[o].ghost;
        const e = edges.get(key);
        if (!e) edges.set(key, { a: i, b: o, ghost });
        else if (!ghost) e.ghost = false;
      });
    });
  });
  // columns: what you can make first, then (faded) what's next — each ordered by where its inputs sit
  const cols = {};
  Object.values(tiles).forEach(t => (cols[t.level] = cols[t.level] || []).push(t));
  const ins = {};
  edges.forEach(e => (ins[e.b] = ins[e.b] || []).push(e.a));
  Object.keys(cols).map(Number).sort((a, b) => a - b).forEach(c => {
    const list = cols[c];
    list.forEach(t => {
      const ys = (ins[t.item] || []).map(i => tiles[i].y).filter(y => y != null);
      t.bary = ys.length ? ys.reduce((a, y) => a + y, 0) / ys.length : (t.root ? -1 : 1e6);
    });
    list.sort((a, b) => a.ghost - b.ghost || a.bary - b.bary || itemName(a.item).localeCompare(itemName(b.item)));
    let y = 0, gap = false;
    list.forEach(t => {
      if (t.ghost && !gap && y) { y += RH * 0.6; gap = true; }    // what's next sits below, apart
      t.x = c * CW; t.y = y; y += RH;
    });
  });
  const real = Object.values(tiles).filter(t => !t.ghost);
  const bounds = real.length ? { x0: Math.min(...real.map(t => t.x)), y0: Math.min(...real.map(t => t.y)),
    x1: Math.max(...real.map(t => t.x)) + TW, y1: Math.max(...real.map(t => t.y)) + TH } : null;
  return { tiles, edges: [...edges.values()], have, bounds };
}

// ── Drawing ───────────────────────────────────────────────
export function treeShown() { return $('gt')?.classList.contains('show'); }
export function showTree(on = true) {
  const el = $('gt');
  if (!el) return;
  el.classList.toggle('show', on);
  document.querySelectorAll('#gv-seg button').forEach(b => b.classList.toggle('on', (b.dataset.v === 'tree') === on));
  document.getElementById('graph').classList.toggle('tree-on', on);
  if (on) renderTree(true);
}

let fitNext = true;
export function renderTree(fit = false) {
  if (!treeShown()) return;
  T = build();
  fitNext = fitNext || fit || !VIEW?.touched;      // the tree grows: it fits again, until you move it
  draw();
}

function badge(item) {
  const g = goalOf(item), st = storageOf(item), out = [];
  if (g.obj != null) out.push(`<b class="gb mx" title="Maximize, weight ${g.obj}">max${g.obj !== 1 ? ` ×${num(g.obj)}` : ''}</b>`);
  if (g.must != null) out.push(`<b class="gb" title="Exactly">=${num(g.must)}</b>`);
  if (g.min != null && g.max != null) out.push(`<b class="gb" title="Between">${num(g.min)}–${num(g.max)}</b>`);
  else if (g.min != null) out.push(`<b class="gb" title="At least">≥${num(g.min)}</b>`);
  else if (g.max != null) out.push(`<b class="gb" title="At most">≤${num(g.max)}</b>`);
  if (st > 0) out.push(`<b class="gb st" title="To storage">📦${num(st)}</b>`);
  return out.join('');
}

function draw() {
  const el = $('gt-c'), svg = $('gt-e'), box = $('gt');
  if (!T) return;
  const tiles = Object.values(T.tiles);
  if (!tiles.length) {
    el.innerHTML = ''; svg.innerHTML = '';
    $('gt-empty').style.display = '';
    return;
  }
  $('gt-empty').style.display = 'none';
  if (fitNext || !VIEW) fit();
  fitNext = false;
  const { k, ox, oy } = VIEW;
  el.style.transform = `translate(${ox}px, ${oy}px) scale(${k})`;
  svg.style.transform = el.style.transform;
  const W = Math.max(...tiles.map(t => t.x)) + TW + 40, H = Math.max(...tiles.map(t => t.y)) + TH + 40;
  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.innerHTML = T.edges.map(e => {
    const a = T.tiles[e.a], b = T.tiles[e.b];
    const x1 = a.x + TW, y1 = a.y + TH / 2, x2 = b.x, y2 = b.y + TH / 2, mx = (x1 + x2) / 2;
    return `<path class="gt-l ${e.ghost ? 'gh' : ''}" data-a="${e.a}" data-b="${e.b}" d="M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}"/>`;
  }).join('');
  el.innerHTML = tiles.map(t => {
    const sup = T.have.has(t.item) ? SC.available_resources?.[t.item] : null;
    return `<div class="gt-t ${t.ghost ? 'gh' : ''} ${t.root ? 'rt' : ''} ${OPEN === t.item ? 'sel' : ''}" data-i="${t.item}"
      style="left:${t.x}px;top:${t.y}px" title="${esc(itemName(t.item))}${t.ghost ? ' — not yet: click for what it needs' : ''}">
      <span class="gt-n">${esc(itemName(t.item))}</span>${sup ? `<span class="gt-s">${num(sup)}/min</span>` : ''}${badge(t.item)}</div>`;
  }).join('');
  box.querySelector('.gt-count').textContent = `${tiles.filter(t => !t.ghost).length} you can make${NEXT ? ` · ${tiles.filter(t => t.ghost).length} next` : ''}`;
}

function fit() {
  const box = $('gt'), b = T.bounds || { x0: 0, y0: 0, x1: 400, y1: 200 };
  const w = box.clientWidth || 800, h = box.clientHeight || 600, pad = 40;
  const k = Math.min(1.25, Math.max(0.25, Math.min((w - pad * 2) / (b.x1 - b.x0 || 1), (h - pad * 2 - 30) / (b.y1 - b.y0 || 1))));
  VIEW = { k, ox: pad - b.x0 * k + Math.max(0, (w - pad * 2 - (b.x1 - b.x0) * k) / 2), oy: pad + 30 - b.y0 * k };
}

// ── The tile editor: a goal and storage, or for what's next, what it needs ──
function openEditor(item) {
  OPEN = item;
  const t = T.tiles[item], pop = $('gt-pop');
  pop.innerHTML = t.ghost ? needsHTML(item) : editorHTML(item);
  pop.style.display = 'block';
  place(pop, t);
  wire(pop, item);
  draw();
}
function closeEditor() { OPEN = null; $('gt-pop').style.display = 'none'; draw(); }
function place(pop, t) {
  const box = $('gt').getBoundingClientRect();
  let x = VIEW.ox + (t.x + TW) * VIEW.k + 10, y = VIEW.oy + t.y * VIEW.k - 10;
  const w = pop.offsetWidth || 300, h = pop.offsetHeight || 260;
  if (x + w > box.width - 8) x = VIEW.ox + t.x * VIEW.k - w - 10;
  pop.style.left = `${Math.max(8, x)}px`;
  pop.style.top = `${Math.max(8, Math.min(y, box.height - h - 8))}px`;
}

const KINDS = [['none', 'None'], ['obj', 'Maximize'], ['must', 'Exactly'], ['min', 'At least'], ['max', 'At most'], ['range', 'Range']];
function kindOf(g) {
  if (g.obj != null) return 'obj';
  if (g.must != null) return 'must';
  if (g.min != null && g.max != null) return 'range';
  if (g.min != null) return 'min';
  if (g.max != null) return 'max';
  return 'none';
}
function goalBox(item, rate) {
  const g = goalOf(item), kind = kindOf(g), st = storageOf(item);
  return `<div class="gp-k">${KINDS.map(([k, l]) => `<button class="bsm ${k === kind ? 'act' : ''}" data-k="${k}">${l}</button>`).join('')}</div>
    <div class="gp-f">
      <label data-for="obj">Weight <input data-f="obj" inputmode="decimal" value="${g.obj ?? 1}"/></label>
      <label data-for="must">/min <input data-f="must" inputmode="decimal" value="${g.must ?? rate ?? ''}"/></label>
      <label data-for="min range">At least /min <input data-f="min" inputmode="decimal" value="${g.min ?? rate ?? ''}"/></label>
      <label data-for="max range">At most /min <input data-f="max" inputmode="decimal" value="${g.max ?? ''}"/></label>
    </div>
    <label class="gp-st">📦 Store <input data-f="sto" inputmode="decimal" value="${st || ''}" placeholder="0"/> /min
      <span class="n-hint">taken out of what it makes</span></label>
    <div class="gp-b"><button class="bsm" data-a="recipes">Recipes ↗</button><span style="flex:1"></span>
      <button class="bsm" data-a="close">Cancel</button><button class="bsm act" data-a="apply">Set</button></div>`;
}
function editorHTML(item) {
  const t = T.tiles[item];
  return `<div class="gp-h"><b>${esc(itemName(item))}</b><span class="n-hint">${t.root ? 'a resource you have' : `${t.level} step${t.level > 1 ? 's' : ''} from your resources`}</span></div>
    ${goalBox(item)}`;
}

// What a part you can't make yet needs, at `rate`/min: the parts you can't make
// (with where to get them), the milestones and machines it waits on
function recipeFor(item) {
  const ways = Object.entries(RECIPES).filter(([k, r]) => r.outputs[item] && laterOk(k, r));
  const lv = levels(new Set([...raw(), ...T.have]), laterOk);
  // the way with the fewest parts you can't make here, then nothing to unlock, then the shortest
  const missing = r => Object.keys(r.inputs).filter(i => !(T.tiles[i] && !T.tiles[i].ghost)).length;
  const cost = ([k, r]) => missing(r) * 20 + (lockedBy(k) ? 30 : 0) + (machineOn(r.machine) ? 0 : 30) + (r.alternate ? 5 : 0)
    + Math.max(0, ...Object.keys(r.inputs).map(i => lv.get(i) ?? 99));
  return ways.sort((a, b) => cost(a) - cost(b))[0] || null;
}
function needs(item, rate, depth = 0, seen = new Set()) {
  const out = { item, rate, waits: [], parts: [] };
  const w = recipeFor(item);
  if (!w || seen.has(item) || depth > 6) return out;
  seen.add(item);
  const [k, r] = w;
  out.recipe = k;
  if (lockedBy(k)) out.waits.push({ kind: 'sch', id: lockedBy(k) });
  if (!machineOn(r.machine)) out.waits.push({ kind: 'mach', id: r.machine, by: UNLOCKS.machines[r.machine] });
  const per = rate / r.outputs[item];
  Object.entries(r.inputs).forEach(([i, v]) => {
    const amt = v * per, here = T.tiles[i] && !T.tiles[i].ghost;
    if (here) return;                                         // made here already
    const p = { item: i, rate: amt, raw: raw().has(i), sources: sourcesOf(i) };
    if (!p.raw) p.make = needs(i, amt, depth + 1, seen);
    out.parts.push(p);
  });
  return out;
}
function needsHTML(item, rate) {
  const r0 = recipeFor(item);
  rate = rate ?? (r0 ? r0[1].outputs[item] : 1);
  const n = needs(item, rate);
  const waits = n.waits.map(w => w.kind === 'sch'
    ? `<div class="gn-w">🔒 Needs <b>${esc(unlockName(w.id))}</b> <button class="bsm" data-done="${w.id}">I've done it</button></div>`
    : `<div class="gn-w">🔒 Needs a <b>${esc(w.id.replace(/_/g, ' '))}</b>${w.by ? ` <span class="n-hint">(${esc(unlockName(w.by))})</span>` : ''} <button class="bsm" data-mach="${w.id}">Unlock it</button></div>`).join('');
  const part = (p, d = 0) => `<div class="gn-p" style="margin-left:${d * 12}px">
      <div class="gn-ph"><span><b>${num(p.rate)}/min</b> ${esc(itemName(p.item))}</span>
        <span class="n-hint">${p.raw ? 'a resource you don\'t have' : 'you can\'t make it here yet'}</span></div>
      <div class="gn-src">
        ${p.sources.map(s => `<button class="bsm act" data-bring="${p.item}" data-rate="${Math.min(p.rate, s.left)}" data-fac="${s.factory}"
          title="${num(s.left)}/min left there${s.stale ? ' (its plan is out of date)' : ''}">Import ${s.left < p.rate - 1e-6 ? `all ${num(s.left)}` : num(p.rate)} from ${esc(s.name)}</button>`).join('')}
        ${p.raw ? `<button class="bsm" data-map="${p.item}" title="Pick ${esc(itemName(p.item))} nodes on the map">🗺 Find nodes</button>` : ''}
        <button class="bsm" data-bring="${p.item}" data-rate="${p.rate}" title="As a fixed supply — from anywhere">+ ${num(p.rate)}/min as supply</button>
      </div>
      ${p.make && (p.make.parts.length || p.make.waits.length) ? `<details class="gn-make"><summary>or make it here: needs</summary>
        ${p.make.waits.map(w => `<div class="gn-w">🔒 ${esc(w.kind === 'sch' ? unlockName(w.id) : w.id.replace(/_/g, ' '))}</div>`).join('')}
        ${p.make.parts.map(q => part(q, d + 1)).join('')}</details>` : ''}
    </div>`;
  const how = r0 ? `<div class="n-hint" style="margin:-4px 0 6px">${esc(r0[1].display.replace(/^Alternate:\s*/, 'Alt: '))} · ${esc((MABBR[r0[1].machine] || r0[1].machine).replace(/_/g, ' '))}</div>` : '';
  return `<div class="gp-h"><b>${esc(itemName(item))}</b><span class="n-hint">not yet</span></div>${how}
    <label class="gn-rate">at <input data-f="need" inputmode="decimal" value="${+rate.toFixed(3)}"/> /min it needs:</label>
    ${waits}${n.parts.map(p => part(p)).join('') || (waits ? '' : '<p class="n-hint">Nothing else — solve to see.</p>')}
    <div class="gn-goal"><div class="n-hint" style="margin:8px 0 4px">Its goal, once it's in reach</div>${goalBox(item, +rate.toFixed(3))}</div>`;
}

function wire(pop, item) {
  let kind = kindOf(goalOf(item));
  const show = () => {
    pop.querySelectorAll('.gp-k button').forEach(b => b.classList.toggle('act', b.dataset.k === kind));
    pop.querySelectorAll('.gp-f label').forEach(l => { l.style.display = l.dataset.for.split(' ').includes(kind) ? '' : 'none'; });
  };
  show();
  pop.querySelectorAll('.gp-k button').forEach(b => b.addEventListener('click', () => { kind = b.dataset.k; show(); }));
  const val = f => { const v = evalExpr(pop.querySelector(`[data-f="${f}"]`)?.value || ''); return v == null ? null : v; };
  const apply = () => {
    const g = {};
    if (kind === 'obj') g.obj = val('obj') ?? 1;
    if (kind === 'must') g.must = val('must');
    if (kind === 'min' || kind === 'range') g.min = val('min');
    if (kind === 'max' || kind === 'range') g.max = val('max');
    setGoal(item, g);
    setStorage(item, val('sto') || 0);
    document.dispatchEvent(new Event('goals-changed'));
    closeEditor();
  };
  pop.querySelector('[data-a="apply"]')?.addEventListener('click', apply);
  pop.querySelector('[data-a="close"]')?.addEventListener('click', closeEditor);
  pop.querySelector('[data-a="recipes"]')?.addEventListener('click', () => openRecipes(item));
  pop.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => {
    if (e.key === 'Enter' && i.dataset.f !== 'need') { e.preventDefault(); apply(); }
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(); }
  }));
  // what's next: a new rate redraws what it needs
  const need = pop.querySelector('[data-f="need"]');
  need?.addEventListener('change', () => {
    const v = evalExpr(need.value);
    if (!(v > 0)) return;
    pop.innerHTML = needsHTML(item, v); wire(pop, item); place(pop, T.tiles[item]);
  });
  need?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); need.dispatchEvent(new Event('change')); } });
  pop.querySelectorAll('[data-bring]').forEach(b => b.addEventListener('click', () => {
    bringIn(b.dataset.bring, +b.dataset.rate, b.dataset.fac || null);
    document.dispatchEvent(new Event('supply-changed'));
    after(item);
  }));
  pop.querySelectorAll('[data-map]').forEach(b => b.addEventListener('click', () => { closeEditor(); pickOnMap(b.dataset.map); }));
  pop.querySelectorAll('[data-done]').forEach(b => b.addEventListener('click', () => {
    const s = new Set(PROGRESS.schematics || []); s.add(b.dataset.done);
    progress({ schematics: [...s].sort() });
    after(item);
  }));
  pop.querySelectorAll('[data-mach]').forEach(b => b.addEventListener('click', () => {
    const m = new Set(PROGRESS.machines || []); m.add(b.dataset.mach);
    const by = UNLOCKS.machines[b.dataset.mach], s = new Set(PROGRESS.schematics || []);
    progress({ machines: [...m].sort(), ...(PROGRESS.schematics && by ? { schematics: [...s.add(by)].sort() } : {}) });
    after(item);
  }));
}
function progress(p) {
  Object.assign(PROGRESS, p);
  if (p.machines) SC.enabled_machines = [...p.machines];
  saveProgress(p).catch(() => {});
  document.dispatchEvent(new CustomEvent('progress-changed'));
}
// After accepting something: the tree grows; if it's in reach now, its goal editor
function after(item) {
  T = build(); draw();
  const t = T.tiles[item];
  if (!t) { closeEditor(); return; }
  openEditor(item);
}

// ── Pan, zoom, clicks, hover ──────────────────────────────
export function initTree() {
  const box = $('gt');
  if (!box || box._wired) return;
  box._wired = true;
  document.querySelectorAll('#gv-seg button').forEach(b => b.addEventListener('click', () => showTree(b.dataset.v === 'tree')));
  $('gt-next').addEventListener('change', e => { NEXT = e.target.checked; renderTree(); });
  $('gt-fit').addEventListener('click', () => { fitNext = true; draw(); });
  box.addEventListener('wheel', e => {
    if (e.target.closest('#gt-pop') || !VIEW) return;
    e.preventDefault();
    const r = box.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const k = Math.min(2.5, Math.max(0.15, VIEW.k * Math.pow(0.9985, d)));
    VIEW.ox = px - (px - VIEW.ox) * k / VIEW.k; VIEW.oy = py - (py - VIEW.oy) * k / VIEW.k; VIEW.k = k;
    VIEW.touched = true;
    draw();
    if (OPEN && T.tiles[OPEN]) place($('gt-pop'), T.tiles[OPEN]);
  }, { passive: false });
  let drag = null;
  box.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('.gt-t, #gt-pop, .gt-bar')) return;
    drag = { x: e.clientX, y: e.clientY, ox: VIEW?.ox, oy: VIEW?.oy, moved: false };
  });
  window.addEventListener('mousemove', e => {
    if (!drag || !VIEW) return;
    VIEW.ox = drag.ox + e.clientX - drag.x; VIEW.oy = drag.oy + e.clientY - drag.y;
    drag.moved = drag.moved || Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3;
    VIEW.touched = VIEW.touched || drag.moved;
    draw();
    if (OPEN && T.tiles[OPEN]) place($('gt-pop'), T.tiles[OPEN]);
  });
  window.addEventListener('mouseup', () => {
    if (drag && !drag.moved && OPEN) closeEditor();
    drag = null;
  });
  box.addEventListener('click', e => {
    const t = e.target.closest('.gt-t');
    if (t) openEditor(t.dataset.i);
  });
  // hovering a tile: its inputs and outputs light up, the rest dims
  box.addEventListener('mouseover', e => {
    const t = e.target.closest('.gt-t');
    box.classList.toggle('hl', !!t);
    if (!t) return;
    const i = t.dataset.i;
    box.querySelectorAll('.gt-l').forEach(l => l.classList.toggle('on', l.dataset.a === i || l.dataset.b === i));
    const near = new Set([i]);
    box.querySelectorAll('.gt-l.on').forEach(l => { near.add(l.dataset.a); near.add(l.dataset.b); });
    box.querySelectorAll('.gt-t').forEach(x => x.classList.toggle('on', near.has(x.dataset.i)));
  });
  box.addEventListener('mouseleave', () => box.classList.remove('hl'));
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && OPEN && treeShown()) { closeEditor(); }
  });
  new ResizeObserver(() => { if (treeShown() && T && !VIEW?.touched) { fitNext = true; draw(); } }).observe(box);
  ['progress-changed', 'unlocks-changed'].forEach(ev => document.addEventListener(ev, () => renderTree()));
}
