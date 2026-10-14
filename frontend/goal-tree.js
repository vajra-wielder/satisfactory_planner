/**
 * goal-tree.js — the Tree: the one place to plan a factory's parts.
 *
 * Each resource you have is a root on the left; every step of processing is a
 * column further right, so branches meet where a recipe takes two parts and
 * split where one feeds many (a part's column: the fewest steps from what you
 * have, with the recipes your unlocks allow). Packing fluids isn't a step.
 *
 * A tile:
 *   ⟳ badge    cycles its alternates (1/4 … 4/4, then none) — a pick is
 *              offered to the solver, which uses it if it's better
 *   click      its popover: every recipe that makes it (pick one; at a rate,
 *              how many machines and how much of each part — click a part to
 *              go to it), what it's used in, and its goals (several at once:
 *              maximize with a floor, a cap; or exactly) and storage
 *   after a solve: the rate it's made at and the recipe the solver chose;
 *              parts the plan doesn't make fade, the plan's links light up,
 *              and alternates worth unlocking show as ✨ on the parts they'd
 *              change (click to pick)
 * What's next adds, faded, what you can't make yet; click one: the
 * alternates that get it from what you have (use them), what to bring in —
 * the solver's answer — and where from, and the milestone it waits on.
 * Search (Ctrl+Q, or the top bar's box) finds a part and opens it; a sum
 * there is worked out, and belts — "4 x 120 into 5 x 80 + 40 + 20 + 20" — get
 * the splitters and mergers that make the exact rates, drawn (splits.js).
 */
import { itemColor } from './bundles.js';
import { RECIPES, ALL_ITEMS, itemName, SC, RESULT, PROGRESS, TRANSPORT, FLUIDS, UNLOCKED_ALTS, lockedBy, unlockName, UNLOCKS, mCol, MABBR } from './state.js';
import { goalOf, setGoal, evalExpr } from './kv-panel.js';
import { storageOf, setStorage, sourcesOf, bringIn, pickOnMap } from './supply-panel.js';
import { saveProgress, fetchNeeds } from './api.js';
import { gainText } from './new-alts.js';
import { parseSplit, design, splitSVG, feedPattern } from './splits.js';
import { openSplit } from './build-sheet.js';

const $ = id => document.getElementById(id);
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = v => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : +v.toFixed(v < 10 ? 2 : 1)).toLocaleString();
const EVENT = /FICSMAS|Snowball|Candy_Cane|Fireworks/;
const TW = 150, TH = 38, CW = 210, RH = 46;          // tile, column and row sizes (px at zoom 1)
const rname = r => r.display.replace(/^Alternate:\s*/i, '').replace(/\s*\(Alt\)/, '');

let T = null;                 // the built tree: { tiles: {item: tile}, edges, have, bounds }
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

const picks = () => SC.recipe_picks || (SC.recipe_picks = {});
const picked = k => Object.values(picks()).includes(k);
const machineOn = m => !PROGRESS.machines || PROGRESS.machines.includes(m);
const altOn = k => UNLOCKED_ALTS.has(k) || (SC.alternate_recipes_enabled || []).includes(k) || picked(k);
const usable = (k, r) => !EVENT.test(k) && !transport(k, r);
// The recipes a solve here may use; those any alternate opens (from what you have); and later (any machine, milestone)
const nowOk = (k, r) => usable(k, r) && machineOn(r.machine) && !lockedBy(k) && (!r.alternate || altOn(k));
const altsOk = (k, r) => usable(k, r) && machineOn(r.machine) && !lockedBy(k);
const laterOk = (k, r) => usable(k, r);

// Every way to make an item (it the main output), the standard ones first
const WAYS = {};
function ways(item) {
  if (!WAYS[item]) {
    const all = Object.entries(RECIPES).filter(([k, r]) => usable(k, r) && r.outputs[item]);
    const main = all.filter(([, r]) => Object.keys(r.outputs)[0] === item);
    WAYS[item] = (main.length ? main : all).sort((a, b) => a[1].alternate - b[1].alternate || rname(a[1]).localeCompare(rname(b[1])));
  }
  return WAYS[item];
}
const altsOf = item => ways(item).filter(([, r]) => r.alternate);

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

// The last solve: what each part's made at, by which recipes, and which inputs feed which outputs
function planOf() {
  const p = { rate: {}, by: {}, links: new Set(), flow: {}, most: 0 };
  if (!RESULT?.flows?.length) return null;
  RESULT.flows.forEach(f => {
    Object.entries(f.outputs || {}).forEach(([o, v]) => {
      p.rate[o] = (p.rate[o] || 0) + v;
      (p.by[o] = p.by[o] || new Set()).add(f.recipe_key);
      Object.entries(f.inputs || {}).forEach(([i, r]) => {
        p.links.add(i + '>' + o);
        p.flow[i + '>' + o] = (p.flow[i + '>' + o] || 0) + r;   // how much of i goes into making o
      });
    });
  });
  p.most = Math.max(1, ...Object.values(p.flow));
  return p;
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
        if (i === o || tiles[i].level >= tiles[o].level) return;          // back the other way (loops): left out
        const key = i + '>' + o, ghost = !real || tiles[i].ghost || tiles[o].ghost;
        const e = edges.get(key);
        if (!e) edges.set(key, { a: i, b: o, ghost, pick: picks()[o] === k });
        else { if (!ghost) e.ghost = false; if (picks()[o] === k) e.pick = true; }
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
  return { tiles, edges: [...edges.values()], have, bounds, plan: planOf() };
}

// ── Drawing ───────────────────────────────────────────────
export function treeShown() { return $('gt')?.classList.contains('show'); }
export function showTree(on = true) {
  const el = $('gt');
  if (!el) return;
  el.classList.toggle('show', on);
  $('btn-tree')?.classList.toggle('on', on);
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

// Alternates worth unlocking (the last solve's suggestions), by the part each makes
function suggested() {
  const out = {};
  (RESULT?.suggest?.steps || []).forEach(s => {
    const r = RECIPES[s.key];
    if (r) out[Object.keys(r.outputs)[0]] = s;
  });
  return out;
}

// The ⟳ badge: how many alternates, and which one's picked
function cycleBadge(item) {
  const alts = altsOf(item);
  if (!alts.length) return '';
  const i = alts.findIndex(([k]) => k === picks()[item]);
  return i < 0 ? `<b class="gc" data-cyc="${item}" title="${alts.length} alternate${alts.length > 1 ? 's' : ''} — click to try them in turn">⟳${alts.length}</b>`
    : `<b class="gc on" data-cyc="${item}" title="${esc(rname(alts[i][1]))} — offered to the solver; click for the next">${i + 1}/${alts.length}</b>`;
}
function cycle(item) {
  const alts = altsOf(item), i = alts.findIndex(([k]) => k === picks()[item]);
  if (i + 1 >= alts.length) delete picks()[item]; else picks()[item] = alts[i + 1][0];
  changed();
}
function pick(item, key) {
  if (!key || !RECIPES[key]?.alternate) delete picks()[item]; else picks()[item] = key;
  changed();
}
function changed() {
  document.dispatchEvent(new Event('goals-changed'));
  T = build(); draw();
  if (OPEN && T.tiles[OPEN]) openEditor(OPEN);
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
  const P = T.plan, sug = suggested();
  svg.innerHTML = T.edges.map(e => {
    const a = T.tiles[e.a], b = T.tiles[e.b];
    const x1 = a.x + TW, y1 = a.y + TH / 2, x2 = b.x, y2 = b.y + TH / 2, mx = (x1 + x2) / 2;
    const used = P?.links.has(e.a + '>' + e.b);
    // a plan's link: in its item's colour, as wide as what it carries
    const look = used ? ` style="stroke:${itemColor(e.a, FLUIDS.has(e.a))};stroke-width:${(1.5 + 9 * Math.sqrt(P.flow[e.a + '>' + e.b] / P.most)).toFixed(1)}px"` : '';
    return `<path class="gt-l ${e.ghost ? 'gh' : ''} ${used ? 'pl' : ''} ${e.pick ? 'pk' : ''}" data-a="${e.a}" data-b="${e.b}"${look} d="M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}"><title>${
      used ? `${esc(itemName(e.a))} ${num(P.flow[e.a + '>' + e.b])}/min → ${esc(itemName(e.b))}` : ''}</title></path>`;
  }).join('');
  el.innerHTML = tiles.map(t => {
    const sup = T.have.has(t.item) ? SC.available_resources?.[t.item] : null;
    const made = P?.rate[t.item], idle = P && !t.ghost && !t.root && !made;
    const s = sug[t.item];
    return `<div class="gt-t ${t.ghost ? 'gh' : ''} ${t.root ? 'rt' : ''} ${idle ? 'idle' : ''} ${OPEN === t.item ? 'sel' : ''}" data-i="${t.item}"
      style="left:${t.x}px;top:${t.y}px;border-left:3px solid ${itemColor(t.item, FLUIDS.has(t.item))}" title="${esc(itemName(t.item))}${t.ghost ? ' — not yet: click for what it needs' : idle ? ' — not in the plan' : ''}">
      <span class="gt-n">${esc(itemName(t.item))}</span><span class="gt-m">${made ? `<span class="gt-s pl">${num(made)}/min</span>` : sup ? `<span class="gt-s">${num(sup)}/min</span>` : ''}${badge(t.item)}</span>
      ${s ? `<b class="gs" data-sug="${s.key}" data-for="${t.item}" title="Worth unlocking: ${esc(rname(RECIPES[s.key]))} — ${esc(gainText(s, false))}. Click to pick it">✨</b>` : ''}${t.ghost ? '' : cycleBadge(t.item)}</div>`;
  }).join('');
  // and what alternates would bring in reach (not unlocked ones too: hard drives)
  const real = tiles.filter(t => !t.ghost);
  T.withAlts ??= [...levels(T.have, altsOk).keys()].filter(i => (!T.tiles[i] || T.tiles[i].ghost) && !EVENT.test(i) && ways(i).length).length;
  const withAlts = T.withAlts;
  const cnt = box.querySelector('.gt-count');
  cnt.innerHTML = `${real.length} you can make${withAlts ? ` · <a class="gt-more" title="Show them, faded — click one for the alternates that get there">${withAlts} more with alternates</a>` : ''}${
    NEXT ? ` · ${tiles.filter(t => t.ghost).length} next` : ''}${P ? ' · lit: the plan' : ''}`;
  cnt.querySelector('.gt-more')?.addEventListener('click', () => { NEXT = true; $('gt-next').checked = true; renderTree(); });
}

function fit() {
  const box = $('gt'), b = T.bounds || { x0: 0, y0: 0, x1: 400, y1: 200 };
  const w = box.clientWidth || 800, h = box.clientHeight || 600, pad = 40;
  const k = Math.min(1.25, Math.max(0.25, Math.min((w - pad * 2) / (b.x1 - b.x0 || 1), (h - pad * 2 - 30) / (b.y1 - b.y0 || 1))));
  VIEW = { k, ox: pad - b.x0 * k + Math.max(0, (w - pad * 2 - (b.x1 - b.x0) * k) / 2), oy: pad + 30 - b.y0 * k };
}
// Bring a tile into view (search, a part clicked in a popover)
function focusOn(item) {
  const t = T.tiles[item], box = $('gt');
  if (!t || !VIEW) return;
  VIEW.ox = box.clientWidth * 0.35 - (t.x + TW / 2) * VIEW.k;
  VIEW.oy = box.clientHeight * 0.4 - (t.y + TH / 2) * VIEW.k;
  VIEW.touched = true;
  draw();
}
/** Open a part on the tree: shown, in view, its popover open (faded parts too). */
export function openPart(item) {
  showTree(true);
  if (!T.tiles[item] && !NEXT) { NEXT = true; $('gt-next').checked = true; T = build(); }
  if (!T.tiles[item]) return false;
  focusOn(item);
  openEditor(item);
  return true;
}

// ── The popover ───────────────────────────────────────────
function openEditor(item) {
  OPEN = item;
  const t = T.tiles[item], pop = $('gt-pop');
  pop.innerHTML = t.ghost ? needsHTML(item) : editorHTML(item);
  pop.style.display = 'block';
  place(pop, t);
  wire(pop, item);
  if (t.ghost) loadNeeds(pop, item);
  draw();
}
function closeEditor() { OPEN = null; $('gt-pop').style.display = 'none'; draw(); }
function place(pop, t) {
  const box = $('gt').getBoundingClientRect();
  let x = VIEW.ox + (t.x + TW) * VIEW.k + 10, y = VIEW.oy + t.y * VIEW.k - 10;
  const w = pop.offsetWidth || 340, h = pop.offsetHeight || 300;
  if (x + w > box.width - 8) x = VIEW.ox + t.x * VIEW.k - w - 10;
  pop.style.left = `${Math.max(8, x)}px`;
  pop.style.top = `${Math.max(8, Math.min(y, box.height - h - 8))}px`;
}

// Goals that go together on one part: maximize it, and keep at least (a
// floor, so the weights can't trade it away to nothing) or at most some of it;
// or make exactly so much — that one alone
const GOALS = [['obj', 'Maximize', 'weight', 'how much it counts against the other maximized parts'],
  ['min', 'At least', '/min', 'a floor: never less than this'], ['max', 'At most', '/min', 'a cap: never more than this'],
  ['must', 'Exactly', '/min', 'this much, no more, no less — on its own']];
function goalBox(item, rate) {
  const g = goalOf(item), st = storageOf(item);
  const dflt = { obj: 1, min: rate ?? '', max: '', must: rate ?? '' };
  return `<div class="gp-sec">Goals</div><div class="gp-f">${GOALS.map(([k, l, u, tip]) => `<label class="gp-g" title="${tip}">
      <input type="checkbox" data-on="${k}" ${g[k] != null ? 'checked' : ''}/><span>${l}</span>
      <input data-f="${k}" inputmode="decimal" value="${g[k] ?? dflt[k]}"/><span class="n-hint">${u}</span></label>`).join('')}</div>
    <label class="gp-st">📦 Store <input data-f="sto" inputmode="decimal" value="${st || ''}" placeholder="0"/> /min
      <span class="n-hint">taken out of what it makes</span></label>
    <div class="gp-b"><span style="flex:1"></span>
      <button class="bsm" data-a="close">Cancel</button><button class="bsm act" data-a="apply">Set</button></div>`;
}

// The rate a part is looked at: the plan's, else its goal's, else none (one machine each)
function rateOf(item) {
  const g = goalOf(item);
  return T.plan?.rate[item] || g.must || g.min || g.max || null;
}
// Every recipe that makes it: pick one (offered to the solver); at its rate, the machines and parts
function recipesHTML(item, rate) {
  const ws = ways(item), cur = picks()[item], P = T.plan, used = P?.by[item] || new Set();
  if (!ws.length) return `<p class="n-hint">${raw().has(item) ? 'Mined, pumped or found — no recipe makes it.' : 'No recipe makes it.'}</p>`;
  const io = (items, per, dir) => Object.entries(items).map(([i, v]) =>
    `<a class="rl-io ${dir} ${i === item ? 'me' : ''}" data-go="${i}"><span>${dir === 'in' ? '←' : '→'} ${esc(itemName(i))}</span><span>${num(v * per)}</span></a>`).join('');
  return `<div class="gp-sec">Made by <span class="n-hint">${rate ? `at ${num(rate)}/min${T.plan?.rate[item] ? ' (the plan)' : ' (its goal)'}` : '· one machine each'}</span></div>
    ${ws.map(([k, r]) => {
      const c = mCol(r.machine), per = rate ? rate / r.outputs[item] : 1, lock = lockedBy(k), noMach = !machineOn(r.machine);
      const own = !r.alternate || UNLOCKED_ALTS.has(k);
      const on = r.alternate ? cur === k : !cur;
      return `<div class="gp-r ${on ? 'on' : ''} ${lock || noMach ? 'dim' : ''}">
        <label class="gp-rh"><input type="radio" name="gp-pick" data-pick="${r.alternate ? k : ''}" ${on ? 'checked' : ''}/>
          <span class="rl-m" style="background:${c}22;color:${c};border:1px solid ${c}44">${MABBR[r.machine] || r.machine}</span>
          ${r.alternate ? `<span class="rl-alt ${own ? '' : 'lk'}" title="${own ? 'Unlocked' : 'Not unlocked — its hard drive'}">${own ? 'ALT' : '🔒 ALT'}</span>` : ''}
          <span class="rl-n" title="${esc(r.display)}">${esc(rname(r))}</span>
          ${used.has(k) ? '<span class="gp-used" title="The last solve made it this way">✓ plan</span>' : ''}
          <span class="rl-k" title="${rate ? 'Machines at 100%' : 'Made by one machine'}">${rate ? `×${num(per)}` : `${num(r.outputs[item])}/min`}</span></label>
        ${lock ? `<div class="rl-note">🔒 ${esc(unlockName(lock))}</div>` : noMach ? `<div class="rl-note">needs a ${esc(r.machine.replace(/_/g, ' '))}</div>` : ''}
        <div class="gp-io">${io(r.inputs, per, 'in')}${Object.keys(r.outputs).length > 1 ? io(r.outputs, per, 'out') : ''}</div></div>`;
    }).join('')}
    <p class="n-hint" style="margin:4px 0 0">A pick is offered to the solver — it uses it if it's better.</p>`;
}
// Other factories with some of it free (or stored): import it from there
function elsewhereHTML(item) {
  const src = sourcesOf(item);
  if (!src.length) return '';
  const have = (SC.from_factories || []).filter(r => r.item === item);
  return `<div class="gp-sec">From your other factories</div><div class="gn-src">${src.map(s => {
    const on = have.find(r => r.factory === s.factory);
    return `<button class="bsm ${on ? '' : 'act'}" data-bring="${item}" data-rate="${s.left}" data-fac="${s.factory}"
      title="${num(s.free)}/min free there${s.stored ? `, ${num(s.stored)}/min stored — saving takes what's needed out of its storage` : ''}${s.stale ? ' (its plan is out of date)' : ''}">${on ? `Importing ${num(+on.rate)} · all` : 'Import'} ${num(s.left)} from ${esc(s.name)}${s.stored && s.left > s.free + 1e-6 ? ` <span class="n-hint">(${num(s.left - s.free)} stored)</span>` : ''}</button>`;
  }).join('')}</div>`;
}
function usedInHTML(item) {
  const uses = [...new Set(Object.entries(RECIPES).filter(([k, r]) => usable(k, r) && r.inputs[item])
    .map(([, r]) => Object.keys(r.outputs)[0]))].sort((a, b) => itemName(a).localeCompare(itemName(b)));
  return uses.length ? `<div class="gp-sec">Used in</div><div class="gp-uses">${uses.map(u =>
    `<a class="gp-u ${T.tiles[u] && !T.tiles[u].ghost ? '' : 'gh'}" data-go="${u}">${esc(itemName(u))}</a>`).join('')}</div>` : '';
}
function editorHTML(item) {
  const t = T.tiles[item], made = T.plan?.rate[item];
  return `<div class="gp-h"><b>${esc(itemName(item))}</b><span class="n-hint">${made ? `${num(made)}/min in the plan` : t.root ? 'a resource you have' : `${t.level} step${t.level > 1 ? 's' : ''} from your resources`}</span></div>
    ${recipesHTML(item, rateOf(item))}${elsewhereHTML(item)}${usedInHTML(item)}${goalBox(item)}`;
}

// A part you can't make yet: the alternates that get it from what you have,
// what to bring in (the solver's answer) and from where, what it waits on
function viaAlts(item) {
  const have = T.have, lv = levels(have, altsOk);
  if (!lv.has(item)) return null;
  const need = {}, seen = new Set();
  const walk = i => {
    if (seen.has(i) || have.has(i) || (T.tiles[i] && !T.tiles[i].ghost)) return;
    seen.add(i);
    // the way there with what's reachable, plain recipes before alternates
    const w = Object.entries(RECIPES).filter(([k, r]) => altsOk(k, r) && r.outputs[i] && Object.keys(r.inputs).every(x => lv.has(x)))
      .sort((a, b) => (a[1].alternate && !altOn(a[0])) - (b[1].alternate && !altOn(b[0]))
        || Math.max(...Object.keys(a[1].inputs).map(x => lv.get(x))) - Math.max(...Object.keys(b[1].inputs).map(x => lv.get(x))))[0];
    if (!w) return;
    if (w[1].alternate && !altOn(w[0])) need[i] = w[0];
    Object.keys(w[1].inputs).forEach(walk);
  };
  walk(item);
  return Object.keys(need).length ? need : null;
}
function waitsOf(item) {
  const out = [], w = ways(item)[0];
  if (!w) return out;
  const [k, r] = w;
  if (lockedBy(k)) out.push(`<div class="gn-w">🔒 Needs <b>${esc(unlockName(lockedBy(k)))}</b> <button class="bsm" data-done="${lockedBy(k)}">I've done it</button></div>`);
  if (!machineOn(r.machine)) out.push(`<div class="gn-w">🔒 Needs a <b>${esc(r.machine.replace(/_/g, ' '))}</b>${UNLOCKS.machines[r.machine] ? ` <span class="n-hint">(${esc(unlockName(UNLOCKS.machines[r.machine]))})</span>` : ''} <button class="bsm" data-mach="${r.machine}">Unlock it</button></div>`);
  return out;
}
// How much of a part you can't make yet to bring in for: its goal, else one machine's
const needRate = item => rateOf(item) || ways(item)[0]?.[1].outputs[item] || 1;
function needsHTML(item) {
  const via = viaAlts(item), rate = needRate(item);
  return `<div class="gp-h"><b>${esc(itemName(item))}</b><span class="n-hint">not yet</span></div>
    ${waitsOf(item).join('')}
    ${via ? `<div class="gn-via"><div>You can make it with what you have, with these alternates:</div>
      <ul>${Object.entries(via).map(([i, k]) => `<li>${esc(rname(RECIPES[k]))} <span class="n-hint">for ${esc(itemName(i))}${UNLOCKED_ALTS.has(k) ? '' : ' · 🔒 its hard drive'}</span></li>`).join('')}</ul>
      <button class="bsm act" data-via='${esc(JSON.stringify(via))}'>Use them</button></div>` : ''}
    <div class="gn-rate">For <b data-need>${num(rate)}</b>/min <span class="n-hint">(${rateOf(item) ? 'its goal' : 'one machine — set a goal below for more'})</span>, bring in:</div>
    <div class="gn-list"><p class="n-hint">Working it out…</p></div>
    ${recipesHTML(item, rateOf(item))}
    <div class="gn-goal">${goalBox(item, +(+rate).toFixed(3))}</div>`;
}
let NEED_SEQ = 0;
function loadNeeds(pop, item, rate = needRate(item)) {
  const mine = ++NEED_SEQ;
  const at = pop.querySelector('[data-need]');
  if (at) at.textContent = num(rate);
  fetchNeeds(SC, item, rate).then(d => {
    if (mine !== NEED_SEQ || OPEN !== item) return;
    const list = pop.querySelector('.gn-list');
    const bring = Object.entries(d.bring || {});
    list.innerHTML = !bring.length ? '<p class="n-hint">Nothing more — it fits what you have. Set its goal below and solve.</p>'
      : bring.map(([i, amt]) => {
        const src = sourcesOf(i), isRaw = raw().has(i), has = (SC.available_resources || {})[i] > 0;
        return `<div class="gn-p"><div class="gn-ph"><span><b>${num(amt)}/min</b> ${esc(itemName(i))}</span>
            <span class="n-hint">${has ? 'more than you have' : isRaw ? 'a resource you don\'t have' : 'you can\'t make it here yet'}</span></div>
          <div class="gn-src">
            ${src.map(s => `<button class="bsm act" data-bring="${i}" data-rate="${Math.min(amt, s.left)}" data-fac="${s.factory}"
              title="${num(s.left)}/min left there${s.stale ? ' (its plan is out of date)' : ''}">Import ${s.left < amt - 1e-6 ? `all ${num(s.left)}` : num(amt)} from ${esc(s.name)}</button>`).join('')}
            ${isRaw ? `<button class="bsm" data-map="${i}" title="Pick ${esc(itemName(i))} nodes on the map">🗺 Find nodes</button>` : ''}
            <button class="bsm" data-bring="${i}" data-rate="${amt}" title="As a fixed supply — from anywhere">+ ${num(amt)}/min as supply</button>
            ${T.tiles[i] ? `<button class="bsm" data-go="${i}" title="Go to it on the tree">→</button>` : ''}
          </div></div>`;
      }).join('');
    wireNeeds(pop, item);
    place(pop, T.tiles[item]);
  }).catch(() => { pop.querySelector('.gn-list').innerHTML = '<p class="n-hint">Couldn\'t work it out.</p>'; });
}

function wire(pop, item) {
  const box = k => pop.querySelector(`[data-on="${k}"]`);
  // Exactly stands alone; typing in a goal's box ticks it
  const tick = (k, on) => {
    if (!box(k)) return;
    box(k).checked = on;
    if (on && k === 'must') ['obj', 'min', 'max'].forEach(o => { box(o).checked = false; });
    if (on && k !== 'must') box('must').checked = false;
  };
  pop.querySelectorAll('[data-on]').forEach(c => c.addEventListener('change', () => tick(c.dataset.on, c.checked)));
  pop.querySelectorAll('.gp-g [data-f]').forEach(i => i.addEventListener('input', () => tick(i.dataset.f, true)));
  const val = f => { const v = evalExpr(pop.querySelector(`[data-f="${f}"]`)?.value || ''); return v == null ? null : v; };
  const apply = () => {
    const g = {};
    ['obj', 'min', 'max', 'must'].forEach(k => { if (box(k)?.checked) g[k] = val(k) ?? (k === 'obj' ? 1 : null); });
    setGoal(item, g);
    setStorage(item, val('sto') || 0);
    document.dispatchEvent(new Event('goals-changed'));
    closeEditor();
  };
  pop.querySelector('[data-a="apply"]')?.addEventListener('click', apply);
  pop.querySelector('[data-a="close"]')?.addEventListener('click', closeEditor);
  pop.querySelectorAll('.gp-g input, .gp-st input').forEach(i => i.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); apply(); }
  }));
  pop.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeEditor(); } }));
  // a recipe picked
  pop.querySelectorAll('[data-pick]').forEach(r => r.addEventListener('change', () => pick(item, r.dataset.pick)));
  // a part not made yet: what to bring in follows the amount typed in its goal
  if (T.tiles[item]?.ghost) ['must', 'min'].forEach(k => pop.querySelector(`[data-f="${k}"]`)?.addEventListener('change', () => {
    const v = val(k);
    if (v > 0) loadNeeds(pop, item, v);
  }));
  // from another factory (the popover's own list; the needs list wires its own)
  pop.querySelectorAll(':scope > .gn-src [data-bring]').forEach(b => b.addEventListener('click', () => {
    bringIn(b.dataset.bring, +b.dataset.rate, b.dataset.fac);
    document.dispatchEvent(new Event('supply-changed'));
    after(item);
  }));
  pop.querySelector('[data-via]')?.addEventListener('click', e => {
    Object.entries(JSON.parse(e.target.dataset.via)).forEach(([i, k]) => { picks()[i] = k; });
    document.dispatchEvent(new Event('goals-changed'));
    after(item);
  });
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
  wireGo(pop);
}
function wireNeeds(pop, item) {
  pop.querySelectorAll('.gn-list [data-bring]').forEach(b => b.addEventListener('click', () => {
    bringIn(b.dataset.bring, +b.dataset.rate, b.dataset.fac || null);
    document.dispatchEvent(new Event('supply-changed'));
    after(item);
  }));
  pop.querySelectorAll('.gn-list [data-map]').forEach(b => b.addEventListener('click', () => { closeEditor(); pickOnMap(b.dataset.map); }));
  wireGo(pop.querySelector('.gn-list'));
}
// a part named in a popover: go to it
function wireGo(el) {
  el.querySelectorAll('[data-go]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); openPart(a.dataset.go); }));
}
function progress(p) {
  Object.assign(PROGRESS, p);
  if (p.machines) SC.enabled_machines = [...p.machines];
  saveProgress(p).catch(() => {});
  document.dispatchEvent(new CustomEvent('progress-changed'));
}
// After accepting something: the tree grows; the part's popover again (its goals, once in reach)
function after(item) {
  T = build(); draw();
  if (!T.tiles[item]) { closeEditor(); return; }
  openEditor(item);
}

// ── Search: find a part and open it; a sum is worked out ──
function searchHits(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return ALL_ITEMS.filter(i => !EVENT.test(i) && (ways(i).length || raw().has(i)))
    .map(i => ({ i, n: itemName(i).toLowerCase() }))
    .filter(x => words.every(w => x.n.includes(w)))
    .sort((a, b) => (b.n.startsWith(words[0]) - a.n.startsWith(words[0])) || a.n.length - b.n.length).slice(0, 12).map(x => x.i);
}
const isSum = t => /[\d)]\s*[-+*/%]\s*[\d(.]|^\(/.test(t) && evalExpr(t) !== null;
let HIT = 0;
// "4 x 120 into 5 x 80 + 40 + 20 + 20": the splitters and mergers for it, drawn
function drawSplit(q) {
  const el = $('gt-split'), p = q && parseSplit(q, evalExpr);
  el.style.display = p ? 'block' : 'none';
  if (!p) return false;
  const tier = PROGRESS.belt, cap = TRANSPORT.belts?.[tier] ?? Infinity;
  const d = design(p.ins, p.outs, { cap });
  const list = v => { const c = new Map(); v.forEach(r => c.set(r, (c.get(r) || 0) + 1)); return [...c].map(([r, n]) => (n > 1 ? `${n} × ` : '') + num(r)).join(' + '); };
  if (d.error) { el.innerHTML = `<div class="sp-h">${list(p.ins)} → ${list(p.outs)}</div><p class="n-warn">${esc(d.error)}</p>`; return true; }
  const notes = [
    d.merged && 'The belts merge into one first.',
    d.loop > 1e-6 && `${num(d.loop)}/min loops back into the belt it came from (dashed).`,
    d.rest > 1e-6 && `↯ ${num(d.rest)}/min left over — into a sink or storage, so nothing backs up.`,
    d.over && `Red: over a ${tier} belt (${num(cap)}/min).`,
    d.splitters && 'Exact while every output flows freely.',
  ].filter(Boolean);
  // one belt into equal shares: the pattern in words, before the drawing
  const same = p.ins.length === 1 && p.outs.every(o => Math.abs(o - p.outs[0]) < 1e-9) && Math.abs(p.outs[0] * p.outs.length - p.ins[0]) < 1e-6;
  const fp = same && p.outs.length > 1 && feedPattern(p.ins[0], p.outs.length);
  const words = fp ? `<p class="fd-w">${fp.spare ? `Merge ${fp.spare} looped-back belt${fp.spare > 1 ? 's' : ''} into it (${num(fp.load)}/min), then s` : 'S'}plit ${
    fp.splits.map(x => `${x}`).join(' → ')} ways, each belt again: ${fp.ends} belts of ${num(fp.each)}/min${fp.spare ? ` — ${p.outs.length} out, ${fp.spare} back` : ''}.</p>` : '';
  el.innerHTML = `<div class="sp-h">${list(p.ins)} → ${list(p.outs)}<span><b>${d.splitters}</b> splitter${d.splitters === 1 ? '' : 's'} · <b>${d.mergers}</b> merger${d.mergers === 1 ? '' : 's'}</span></div>${words}
    <div class="sp-d">${splitSVG(d.graph, num)}</div>${notes.map(n => `<p class="n-hint">${n}</p>`).join('')}`;
  return true;
}
function drawSearch() {
  const q = $('gt-q').value.trim(), out = $('gt-hits');
  if (drawSplit(q) || !q) { out.style.display = 'none'; return; }
  out.style.display = 'block';
  if (isSum(q)) { out.innerHTML = `<div class="gt-sum">${esc(q)} = <b>${num(evalExpr(q))}</b></div>`; return; }
  const hits = searchHits(q);
  HIT = Math.min(HIT, Math.max(0, hits.length - 1));
  out.innerHTML = hits.length ? hits.map((i, n) => {
    const t = T?.tiles[i];
    return `<div class="gt-hit ${n === HIT ? 'on' : ''}" data-hit="${i}"><span>${esc(itemName(i))}</span>
      <span class="n-hint">${t && !t.ghost ? 'on the tree' : 'not yet'}</span></div>`;
  }).join('') : '<div class="n-hint" style="padding:6px 8px">No part by that name</div>';
}
function goHit(i) {
  $('gt-q').value = ''; drawSearch(); $('gt-q').blur();
  openPart(i);
}
/** Ctrl+Q / the top bar's box: the tree, and its search. */
export function openSearch() {
  showTree(true);
  const q = $('gt-q');
  q.focus(); q.select();
}

// ── Pan, zoom, clicks, hover ──────────────────────────────
export function initTree() {
  const box = $('gt');
  if (!box || box._wired) return;
  box._wired = true;
  $('btn-tree')?.addEventListener('click', () => showTree(!treeShown()));
  $('tb-rl-open')?.addEventListener('click', openSearch);
  $('gt-close').addEventListener('click', () => showTree(false));
  $('gt-next').addEventListener('change', e => { NEXT = e.target.checked; renderTree(); });
  $('gt-fit').addEventListener('click', () => { fitNext = true; draw(); });
  const q = $('gt-q');
  q.addEventListener('input', () => { HIT = 0; drawSearch(); });
  q.addEventListener('keydown', e => {
    const hits = [...$('gt-hits').querySelectorAll('[data-hit]')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hits.length) return;
      HIT = (HIT + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length; drawSearch();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sp = $('gt-split');
      if (sp.style.display === 'block' && sp.querySelector('svg')) openSplit(sp.querySelector('.sp-h')?.firstChild?.textContent?.trim() || 'Splitters and mergers', sp.innerHTML);
      else if (hits[HIT]) goHit(hits[HIT].dataset.hit);
    } else if (e.key === 'Escape') { e.preventDefault(); q.value = ''; drawSearch(); q.blur(); }
  });
  $('gt-hits').addEventListener('mousedown', e => { const h = e.target.closest('[data-hit]'); if (h) { e.preventDefault(); goHit(h.dataset.hit); } });
  q.addEventListener('blur', () => setTimeout(() => { $('gt-hits').style.display = 'none'; }, 150));
  q.addEventListener('focus', drawSearch);

  box.addEventListener('wheel', e => {
    if (e.target.closest('#gt-pop, #gt-hits, #gt-split') || !VIEW) return;
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
    if (e.button !== 0 || e.target.closest('.gt-t, #gt-pop, .gt-bar, .gt-find')) return;
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
    const c = e.target.closest('[data-cyc]');
    if (c) { e.stopPropagation(); cycle(c.dataset.cyc); return; }
    const s = e.target.closest('[data-sug]');
    if (s) { e.stopPropagation(); pick(s.dataset.for, s.dataset.sug); return; }
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
    if (e.key !== 'Escape' || e.defaultPrevented || !treeShown() || document.querySelector('.far.show, #map-modal.show, #nav-pal.show, #nav-help.show')) return;
    if (OPEN) closeEditor(); else if (!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) showTree(false);
  });
  new ResizeObserver(() => { if (treeShown() && T && !VIEW?.touched) { fitNext = true; draw(); } }).observe(box);
  ['progress-changed', 'unlocks-changed', 'suggest-ready'].forEach(ev => document.addEventListener(ev, () => renderTree()));
}
