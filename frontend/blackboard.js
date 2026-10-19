/**
 * blackboard.js — logistics planning, in two parts, and the world map (below)
 * it and the node picker draw. Loaded the first time either opens.
 *
 * Between factories: every saved scenario is a black box showing only what it
 * imports and exports (from its last plan), where its imports come from and
 * how much of its outputs others take ("From factories" in each scenario —
 * those joins are drawn as routes). Join factories with routes — train,
 * truck, tractor or drone, each with its round trip time — and plan the network: which
 * recipe runs where, what crosses each path and what that takes, what each
 * factory draws, and what the leftovers could still make (network.py).
 * Clicking a factory's name opens it.
 *
 * Items: every item across the factories — who makes it, who takes it,
 * what's stored (change it here, for any factory) and what's still free.
 * (Splitting belts inside a factory is the find box's: "480 into 3 x 160".)
 */
import { itemName, RECIPES, fetchFactoryOutputs, setStored, loadMap, mapNode, PURITY, MAX_SHARDS, MAPD } from './state.js';
import { BB_TABS } from './nav.js';
import { onChain, chainHTML } from './ui.js';
import { bandStripes, bandScale, itemColor as colorOf } from './geometry.js';
import { uploadSave, changesHTML, wireChanges } from './unlocks.js';

let DATA = null;          // { factories, fluids, transport }
let LAYOUT = { positions: {}, routes: [] };
let FLUIDS = new Set();
let NET = null;           // last network plan
const STORE = '@storage';
let onOpenFactory = () => {};
let saveTimer = null;

const $ = id => document.getElementById(id);
const fmt = v => (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : +v.toFixed(2)).toLocaleString();
const recipeName = k => (RECIPES[k]?.display || k.replace(/_/g, ' ')).replace(/^Alternate:\s*/, 'Alt: ');
// Vehicles between factories (belts and pipes stay inside them); each route's
// time is one vehicle's round trip
const MODES = { train: 'Train', truck: 'Truck', tractor: 'Tractor', drone: 'Drone' };
const LOAD_UNIT = { train: 'freight cars', truck: 'trucks', tractor: 'tractors', drone: 'drones' };
// What a planned route takes: the vehicles (or cars) its heavier way keeps
// busy, the stations at each end, and for drones the batteries — an estimate
// (24,000 MJ a trip plus 12 MJ a metre between the ports, 6,000 MJ a battery);
// the port's own readout is exact
const ceil = v => Math.ceil(v - 1e-6);

// A path: stops one vehicle runs in order — out and back along a line
// (A→B→C→B→A), or round a loop (A→B→C→D→A); any stop loads for any other
// (network.py's legs and _hops, the same here)
const stopsOf = rt => rt.stops || [rt.a, rt.b];
const looped = rt => !!rt.loop && stopsOf(rt).length > 2;
function legsOf(rt) {
  const st = stopsOf(rt), fwd = st.slice(1).map((b, i) => [st[i], b]);
  return looped(rt) ? [...fwd, [st[st.length - 1], st[0]]] : [...fwd, ...[...fwd].reverse().map(([a, b]) => [b, a])];
}
function hopsOf(rt, src, dst) {
  const st = stopsOf(rt), i = st.indexOf(src), j = st.indexOf(dst);
  if (i < 0 || j < 0 || i === j) return [];
  if (looped(rt)) { const n = st.length; return Array.from({ length: (j - i + n) % n }, (_, k) => (i + k) % n); }
  const n = st.length - 1;
  return j > i ? Array.from({ length: j - i }, (_, k) => i + k) : Array.from({ length: i - j }, (_, k) => 2 * n - i + k);
}
const pathName = rt => {
  const ns = stopsOf(rt).map(k => factory(k)?.name || k);
  return looped(rt) ? [...ns, ns[0]].join(' → ') : ns.join(' ⇄ ');
};
// the first path with both on it (what the factories declare goes on it)
const pathOn = (a, b) => LAYOUT.routes.findIndex(r => stopsOf(r).includes(a) && stopsOf(r).includes(b));

// What a path's flows keep busy, as the network plan counts it: per kind of
// car, the heaviest leg's loads (one per round trip) — for the declared flows
function declaredLoad(rt, flows) {
  const v = DATA?.vehicles?.[rt.mode] || DATA?.vehicles?.train || { stacks: 32 };
  const L = legsOf(rt), per = L.map(() => ({ solid: 0, fluid: 0 }));
  flows.forEach(f => {
    const fluid = FLUIDS.has(f.item);
    if (fluid && !v.fluid) return;
    const c = fluid ? rt.trip_min / v.fluid : rt.trip_min / (v.stacks * (DATA?.stacks?.[f.item] || 100));
    hopsOf(rt, f.from, f.to).forEach(h => { per[h][fluid ? 'fluid' : 'solid'] += f.rate * c; });
  });
  const cars = { solid: Math.max(0, ...per.map(x => x.solid)), fluid: Math.max(0, ...per.map(x => x.fluid)) };
  return { ...rt, cars, load: cars.solid + cars.fluid, legs: L.map(([a, b], h) => ({ from: a, to: b, load: per[h].solid + per[h].fluid })) };
}

// Too much for one route: over this many cars (one train), vehicles or drones
const HEAVY = { train: 8, truck: 6, tractor: 6, drone: 4 };
const STK = it => DATA?.stacks?.[it] || 100;
// The heaviest thing on it, and a step the receiving factory runs on it that
// would ship lighter if it ran at the sending end instead
function heavy(rt, flows) {
  const v = vehicles(rt);
  const n = rt.mode === 'train' ? ceil((rt.cars?.solid || 0) + (rt.cars?.fluid || 0)) : ceil(rt.cars?.solid || 0);
  if (n <= HEAVY[rt.mode]) return null;
  const worst = flows.filter(f => !FLUIDS.has(f.item)).sort((a, b) => b.rate / STK(b.item) - a.rate / STK(a.item))[0];
  let tip = '';
  if (worst) {
    const cars = (io) => Object.entries(io || {}).reduce((s, [i, r]) => s + (FLUIDS.has(i) ? 0 : r / STK(i)), 0);
    const best = (factory(worst.to)?.recipes || []).map(k => RECIPES[k]).filter(r => r && worst.item in (r.inputs || {}))
      .map(r => ({ r, ratio: cars(r.outputs) / (cars(r.inputs) || 1) })).sort((a, b) => a.ratio - b.ratio)[0];
    if (best && best.ratio < 0.75) {
      const outs = Object.keys(best.r.outputs).filter(i => !FLUIDS.has(i)).map(itemName).join(' + ');
      tip = ` Run ${(best.r.display || '').replace(/^Alternate:\s*/i, 'Alt: ')} at ${nameOf(worst.from)} instead and ship ${outs}: about ${Math.round((1 - best.ratio) * 100)}% less to carry.`;
    }
  }
  return { short: `⚠ ${v.short}`, long: `Heavy: ${n} ${LOAD_UNIT[rt.mode]} busy${worst ? ` — mostly ${itemName(worst.item)} (${fmt(worst.rate)}/min)` : ''}.${tip}${NET ? '' : ' Plan network finds the lightest split.'}` };
}
// How far a vehicle goes one way: between the two ends, or half a path's whole run
function distance(rt) {
  let d = 0;
  for (const [a, b] of legsOf(rt)) {
    const p = factory(a)?.at, q = factory(b)?.at;
    if (!p || !q) return null;
    d += Math.hypot(p[0] - q[0], p[1] - q[1]);
  }
  return d / 2;
}
const km = d => (d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`);
function vehicles(rt) {
  const cars = rt.cars || { solid: rt.load || 0, fluid: 0 }, d = distance(rt);
  const away = d == null ? '' : stopsOf(rt).length > 2 ? `A ${km(2 * d)} run round` : `${km(d)} apart`;
  if (rt.mode === 'train') {
    const f = ceil(cars.solid), l = ceil(cars.fluid), n = f + l;
    if (!n) return { short: '—', long: 'Nothing to carry.' };
    return { short: `1 train · ${n} car${n > 1 ? 's' : ''}`,
      long: `${[f && `${f} freight car${f > 1 ? 's' : ''}`, l && `${l} fluid car${l > 1 ? 's' : ''}`].filter(Boolean).join(' + ')} (${fmt(cars.solid + cars.fluid)} busy):
        one train of ${n}, or more trains of fewer cars; at each stop a ${[f && `freight platform per freight car`, l && `fluid platform per fluid car`].filter(Boolean).join(' and a ')}.${away ? ` ${away}.` : ''}` };
  }
  const n = ceil(cars.solid), unit = LOAD_UNIT[rt.mode];
  if (!n) return { short: '—', long: 'Nothing to carry.' };
  const one = unit.replace(/s$/, '');
  if (rt.mode === 'drone') {
    const perTrip = d == null ? null : 4 + d / 500, perMin = perTrip == null ? null : (cars.solid / rt.trip_min) * perTrip;
    return { short: `${n} drone${n > 1 ? 's' : ''}${perMin == null ? '' : ` · ${fmt(perMin)} batteries/min`}`,
      long: `${n} drone${n > 1 ? 's' : ''} (${fmt(cars.solid)} busy) — one drone port pair each.${perMin == null
        ? ' Batteries: open both factories\' nodes on the map so the distance is known.'
        : ` About ${fmt(perTrip)} batteries a trip, ${fmt(perMin)}/min (${away}; an estimate — the port shows the exact figure).`}` };
  }
  return { short: `${n} ${n > 1 ? unit : one}`, long: `${n} ${n > 1 ? unit : one} (${fmt(cars.solid)} busy), a ${one} station at each stop.${away ? ` ${away}.` : ''}` };
}
const HOLDS = { train: '32 stacks a freight car, 1,600 m³ a fluid car', truck: '48 stacks', tractor: '25 stacks', drone: '9 stacks; fluids packaged' };

export function initBlackboard({ onOpenFactory: open }) {
  onOpenFactory = open;
  $('btn-close-bb').addEventListener('click', closeBlackboard);
  document.querySelectorAll('#bb-tabs button').forEach(b =>
    b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('bb-plan').addEventListener('click', planNetwork);
  $('bb-join').addEventListener('click', joinAll);
  $('bb-trades').addEventListener('click', compareTrades);
  $('bb-items-q').addEventListener('input', renderItems);
  window.addEventListener('resize', () => { if (isOpen()) drawRoutes(); });
}

const isOpen = () => $('bb-modal').classList.contains('show');

export function openBlackboard() {
  $('bb-modal').classList.add('show');
  fetch('/api/blackboard').then(r => r.json()).then(d => {
    DATA = d;
    FLUIDS = new Set(d.fluids || []);
    LAYOUT = { positions: {}, routes: [], geysers: [], ...(d.layout || {}) };
    // a factory gone leaves its paths; a path left with one stop goes
    LAYOUT.routes = (LAYOUT.routes || []).map(r => ({ ...r, stops: stopsOf(r).filter(k => factory(k)) }))
      .filter(r => r.stops.length > 1).map(r => ({ ...r, loop: looped(r) }));
    // A factory's "From factories" imports join it to where they come from
    let added = false;
    d.factories.forEach(f => (f.sources || []).forEach(src => {
      if (factory(src.factory) && pathOn(src.factory, f.key) < 0) {
        LAYOUT.routes.push({ stops: [src.factory, f.key], loop: false, mode: 'train', trip_min: 4 });
        added = true;
      }
    }));
    if (added) save();
    renderFactories();
    if (TAB !== 'factories') showTab(TAB);
  });
}

export function closeBlackboard() { $('bb-modal').classList.remove('show'); }

let TAB = 'factories';
/** Open the Blackboard on a tab (and, for Items, an item). */
export function goBlackboard(tab, item) {
  if (item !== undefined) $('bb-items-q').value = itemName(item);
  showTab(tab);
  if (!isOpen()) openBlackboard();
}
function showTab(tab) {
  TAB = tab;
  document.querySelectorAll('#bb-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  BB_TABS.forEach(([t]) => { $('bb-' + t).style.display = t === tab ? '' : 'none'; });
  if (tab === 'factories') drawRoutes();
  if (tab === 'power') renderPower();
  if (tab === 'map') renderMapTab();
  if (tab === 'items') renderItems();
}

function saveNow() {
  clearTimeout(saveTimer);
  return fetch('/api/blackboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(LAYOUT) });
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fetch('/api/blackboard', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(LAYOUT),
  }), 400);
}

// ══════════════════════════════════════════════════════════
// BETWEEN FACTORIES
// ══════════════════════════════════════════════════════════

const factory = key => DATA?.factories.find(f => f.key === key);

function renderFactories() {
  const board = $('bb-board');
  board.querySelectorAll('.bb-card').forEach(c => c.remove());
  if (!DATA.factories.length) {
    board.insertAdjacentHTML('beforeend',
      '<div class="bb-card" style="left:20px;top:20px;padding:10px">No saved factories yet — save a scenario first.</div>');
    return;
  }
  // not placed yet: a grid laid out like the map — rows north to south, west to east in each
  const cols = Math.ceil(Math.sqrt(DATA.factories.length)), slot = {};
  const byY = [...DATA.factories].sort((a, b) => (a.at?.[1] ?? 0) - (b.at?.[1] ?? 0));
  for (let r = 0; r * cols < byY.length; r++)
    byY.slice(r * cols, (r + 1) * cols).sort((a, b) => (a.at?.[0] ?? 0) - (b.at?.[0] ?? 0)).forEach((f, c) => { slot[f.key] = [c, r]; });
  DATA.factories.forEach(f => {
    const [c, r] = slot[f.key];
    const pos = LAYOUT.positions[f.key] || { x: 30 + c * 420, y: 30 + r * 340 };   // room for the bands
    const card = document.createElement('div');
    card.className = 'bb-card';
    card.dataset.key = f.key;
    card.style.left = pos.x + 'px';
    card.style.top = pos.y + 'px';
    // In: where it comes from (its "From factories"). Out: how much others take.
    const from = it => (f.sources || []).filter(x => x.item === it).map(x => factory(x.factory)?.name || x.factory);
    const note = (it, r, out) => {
      if (!out) return from(it).length ? `<div class="bb-sub">from ${from(it).join(', ')}</div>` : '';
      const by = f.taken_by?.[it] || {};
      const t = Object.values(by).reduce((a, v) => a + v, 0);
      if (!t) return '';
      const over = r != null && t > r + 1e-6;
      const who = Object.entries(by).map(([k, v]) => `${fmt(v)} ${k === '@storage' ? 'stored' : `to ${factory(k)?.name || k}`}`).join(', ');
      return `<div class="bb-sub ${over ? 'bb-warn' : ''}">${who}${over ? ` — ${fmt(t - r)} more than it makes` : r != null && r - t > 1e-3 ? `; ${fmt(r - t)} left` : ''}</div>`;
    };
    const rows = (title, obj, cls = '', out = false) => {
      const e = Object.entries(obj);
      return e.length ? `<div class="bb-sec">${title}</div>` + e.map(([it, r]) => `
        <div class="bb-row ${cls}"><span class="bb-item">${itemName(it)}${FLUIDS.has(it) ? ' 💧' : ''}</span>
        <span class="bb-rate">${r == null ? 'max' : fmt(r) + '/min'}</span></div>${note(it, r, out)}`).join('') : '';
    };
    card.innerHTML = `
      <div class="bb-head-row">
        <span class="bb-name" title="Open in the solver">${f.name}</span>
        ${f.solved ? '' : '<span class="bb-tag" title="No current plan — showing the scenario\'s own numbers. Solve it for exact rates.">not solved</span>'}
        <span class="bb-route-h" title="Drag onto another factory for a path between them, or onto a path's box to add a stop">⇄</span>
      </div>
      ${rows('In', f.imports)}${rows('Out', f.exports, '', true)}${rows('Surplus', f.surplus, 'bb-dim', true)}
      ${!Object.keys({ ...f.imports, ...f.exports, ...f.surplus }).length ? '<div class="bb-sec">Self-contained</div>' : ''}`;
    card.querySelector('.bb-name').addEventListener('click', () => onOpenFactory(f.key));
    card.querySelector('.bb-route-h').addEventListener('mousedown', e => startRoute(e, f.key));
    dragCard(card, card.querySelector('.bb-head-row'));
    board.appendChild(card);
  });
  drawRoutes();
}

function dragCard(card, handle) {
  handle.addEventListener('mousedown', e => {
    if (e.target.closest('.bb-name, .bb-route-h')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = card.offsetLeft, oy = card.offsetTop;
    const move = ev => {
      card.style.left = Math.max(0, ox + ev.clientX - sx) + 'px';
      card.style.top = Math.max(0, oy + ev.clientY - sy) + 'px';
      drawRoutes();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      LAYOUT.positions[card.dataset.key] = { x: card.offsetLeft, y: card.offsetTop };
      save();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

function boardXY(ev) {
  const b = $('bb-board').getBoundingClientRect();
  return [ev.clientX - b.left + $('bb-board').scrollLeft, ev.clientY - b.top + $('bb-board').scrollTop];
}

const centre = key => {
  const c = $('bb-board').querySelector(`.bb-card[data-key="${key}"]`);
  return c ? [c.offsetLeft + c.offsetWidth / 2, c.offsetTop + Math.min(c.offsetHeight / 2, 60)] : null;
};

function startRoute(e, from) {
  e.preventDefault();
  e.stopPropagation();
  const svg = $('bb-links');
  const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  tmp.setAttribute('class', 'bb-link-tmp');
  svg.appendChild(tmp);
  const [x1, y1] = centre(from);
  tmp.setAttribute('x1', x1); tmp.setAttribute('y1', y1);
  const move = ev => { const [x, y] = boardXY(ev); tmp.setAttribute('x2', x); tmp.setAttribute('y2', y); };
  move(e);
  const up = ev => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    tmp.remove();
    const hit = document.elementFromPoint(ev.clientX, ev.clientY);
    const to = hit?.closest('.bb-card')?.dataset.key, onPath = hit?.closest('.bb-link-label')?.dataset.path;
    if (onPath != null) {                       // onto a path: one more stop on it
      const rt = LAYOUT.routes[+onPath];
      if (!stopsOf(rt).includes(from)) { rt.stops = [...stopsOf(rt), from]; NET = null; save(); }
    } else if (to && to !== from && pathOn(from, to) < 0) {
      LAYOUT.routes.push({ stops: [from, to], loop: false, mode: 'train', trip_min: 4 });
      NET = null; save();
    }
    drawRoutes();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

// What a path carries: the network plan's items when it has one, else what
// its stops import from each other ("From factories") — on the first path
// that has both
function routeFlows(rt, i) {
  const plan = NET?.routes?.[i];
  if (plan) return plan.items.map(x => ({ from: x.from, to: x.to, item: x.item, rate: x.rate }));
  const out = [], st = stopsOf(rt);
  st.forEach(dst => (factory(dst)?.sources || []).forEach(f => {
    if (f.factory !== dst && st.includes(f.factory) && f.rate > 0 && pathOn(f.factory, dst) === i)
      out.push({ from: f.factory, to: dst, item: f.item, rate: +f.rate });
  }));
  return out;
}

const SVG = 'http://www.w3.org/2000/svg';
const nameOf = k => (k === STORE ? 'Storage' : factory(k)?.name || k);
const flowTitle = f => `${nameOf(f.from)} → ${nameOf(f.to)}: ${itemName(f.item)} ${fmt(f.rate)}/min`;

// A path's stretches, stop to stop (and the last back to the first, round a
// loop), each with what rides it, either way
function stretchesOf(rt, flows) {
  const st = stopsOf(rt), n = st.length - 1;
  const segs = st.slice(1).map((b, k) => ({ a: st[k], b, legs: looped(rt) ? [k] : [k, 2 * n - 1 - k] }));
  if (looped(rt)) segs.push({ a: st[n], b: st[0], legs: [n] });
  segs.forEach(sg => {
    sg.items = flows.filter(f => hopsOf(rt, f.from, f.to).some(h => sg.legs.includes(h)))
      .sort((x, y) => y.rate - x.rate || x.item.localeCompare(y.item));
    sg.rate = sg.items.reduce((t, f) => t + f.rate, 0);
  });
  return segs;
}

function drawRoutes() {
  if (!DATA || !isOpen()) return;
  const board = $('bb-board'), svg = $('bb-links');
  svg.setAttribute('width', board.scrollWidth);
  svg.setAttribute('height', board.scrollHeight);
  svg.innerHTML = '';
  // a label's box losing focus as it goes can redraw first: take only what's still there
  board.querySelectorAll('.bb-link-label').forEach(x => { if (x.isConnected) x.remove(); });
  // A band per stretch between two stops, made of what rides it either way; one scale for every band
  const flows = LAYOUT.routes.map((rt, i) => routeFlows(rt, i));
  const stretches = LAYOUT.routes.map((rt, i) => stretchesOf(rt, flows[i]));
  const scale = bandScale(stretches.flat().map(sg => ({ total: sg.rate })), 28), placed = [];
  LAYOUT.routes.forEach((rt, i) => {
    const pts = stopsOf(rt).map(centre);
    if (pts.some(p => !p)) return;
    let half = 0;
    stretches[i].forEach((sg, k) => {
      const a = centre(sg.a), b = centre(sg.b);
      if (sg.items.length) {
        const g = document.createElementNS(SVG, 'g');
        g.setAttribute('class', 'bb-band');
        const band = bandStripes(a, b, sg.items, scale);
        if (!k) half = band.width / 2;
        band.stripes.forEach(st => {
          const line = document.createElementNS(SVG, 'line');
          line.setAttribute('x1', st.x1); line.setAttribute('y1', st.y1);
          line.setAttribute('x2', st.x2); line.setAttribute('y2', st.y2);
          line.setAttribute('stroke', colorOf(st.flow.item, FLUIDS.has(st.flow.item)));
          line.setAttribute('stroke-width', st.w);
          line.setAttribute('class', 'bb-stripe');
          line.innerHTML = `<title>${flowTitle(st.flow)}</title>`;
          g.appendChild(line);
        });
        svg.appendChild(g);
      } else {   // a stretch with nothing on it yet
        const line = document.createElementNS(SVG, 'line');
        line.setAttribute('x1', a[0]); line.setAttribute('y1', a[1]);
        line.setAttribute('x2', b[0]); line.setAttribute('y2', b[1]);
        line.setAttribute('class', 'bb-link');
        svg.appendChild(line);
      }
    });
    const items = flows[i], total = items.reduce((t, f) => t + f.rate, 0), st = stopsOf(rt);
    const lab = document.createElement('div');
    lab.className = 'bb-link-label';
    lab.dataset.path = i;
    // two stops: just below the band's middle, so the band stays in view; more: in the middle of them
    const at = st.length === 2 ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2 + half + 6]
      : [pts.reduce((t, p) => t + p[0], 0) / pts.length, pts.reduce((t, p) => t + p[1], 0) / pts.length];
    lab.style.left = at[0] + 'px';
    lab.style.top = at[1] + 'px';
    const plan = NET?.routes?.[i] || (items.length ? declaredLoad(rt, items) : null);
    const hv = plan && heavy(plan, items);
    lab.innerHTML = `
      ${st.length > 2 ? `<div class="bb-stops">${st.map((k, j) => `<span class="bb-stop" data-stop="${j}" title="Take ${nameOf(k)} off this path">${nameOf(k)}</span>`).join(looped(rt) ? ' → ' : ' ⇄ ')}${looped(rt) ? ' →' : ''}</div>` : ''}
      <select class="bb-mode">${Object.entries(MODES).map(([m, t]) =>
        `<option value="${m}" ${m === rt.mode ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <input class="bb-trip" type="number" min="0.1" step="0.5" value="${rt.trip_min}"
        title="One ${MODES[rt.mode].toLowerCase()}'s ${st.length > 2 ? 'whole run — every stop and back' : 'round trip'}, minutes — it holds ${HOLDS[rt.mode]}"/> min ${st.length > 2 ? 'run' : 'trip'}
      ${st.length > 2 ? `<button class="bsm bb-loop ${looped(rt) ? 'act' : ''}" title="${looped(rt) ? 'A loop: round every stop and back to the first. Click: out and back along the line instead' : 'Out and back along the line. Click: a loop, from the last stop on to the first'}">⟲</button>` : ''}
      <span class="bb-x" title="Remove this path">✕</span>
      ${items.length ? `<div class="bb-route-sum" title="${items.map(flowTitle).join('\n')}">${items.length} item${items.length > 1 ? 's' : ''} · ${fmt(total)}/min</div>` : ''}
      ${plan ? `<div class="bb-route-load ${hv ? 'heavy' : ''}" title="${(hv ? hv.long + '\n\n' : '') + vehicles(plan).long.replace(/\s+/g, ' ').replace(/"/g, '&quot;')}">${hv ? hv.short : vehicles(plan).short}</div>` : ''}`;
    const changed = () => { NET = null; save(); drawRoutes(); renderNet(); };
    lab.querySelector('.bb-mode').addEventListener('change', e => { rt.mode = e.target.value; changed(); });
    lab.querySelector('.bb-trip')?.addEventListener('change', e => {
      const v = Math.max(0.1, parseFloat(e.target.value) || 4);
      if (v === rt.trip_min) return;
      rt.trip_min = v; changed();
    });
    lab.querySelector('.bb-loop')?.addEventListener('click', () => { rt.loop = !looped(rt); changed(); });
    lab.querySelectorAll('.bb-stop').forEach(x => x.addEventListener('click', () => {
      rt.stops = st.filter((_, j) => j !== +x.dataset.stop);
      rt.loop = looped(rt);
      changed();
    }));
    lab.querySelector('.bb-x').addEventListener('click', () => { LAYOUT.routes.splice(i, 1); changed(); });
    board.appendChild(lab);
    // clear of the boxes already down: moved below any it would cover
    for (let moved = true, n = 0; moved && n < 20; n++) {
      moved = false;
      for (const q of placed) {
        const x1 = lab.offsetLeft - lab.offsetWidth / 2, y1 = lab.offsetTop;
        if (x1 < q.x + q.w && q.x < x1 + lab.offsetWidth && y1 < q.y + q.h && q.y < y1 + lab.offsetHeight) {
          lab.style.top = q.y + q.h + 4 + 'px'; moved = true;
        }
      }
    }
    placed.push({ x: lab.offsetLeft - lab.offsetWidth / 2, y: lab.offsetTop, w: lab.offsetWidth, h: lab.offsetHeight });
  });
}

// Routes for every factory to its nearest (all of them, when there are four or
// fewer): by train, the round trip guessed from the distance — a train covers
// about 2 km a minute, and a minute at the stations
function joinAll() {
  const fs = DATA?.factories || [];
  const d = (a, b) => (a.at && b.at ? Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]) : null);
  const has = (a, b) => pathOn(a, b) >= 0;
  let added = 0;
  fs.forEach(a => {
    const others = fs.filter(b => b.key !== a.key).sort((x, y) => (d(a, x) ?? 1e9) - (d(a, y) ?? 1e9));
    (fs.length <= 4 ? others : others.slice(0, 2)).forEach(b => {
      if (has(a.key, b.key)) return;
      const m = d(a, b);
      LAYOUT.routes.push({ stops: [a.key, b.key], loop: false, mode: 'train', trip_min: m == null ? 4 : Math.max(1, Math.round((1 + 2 * m / 2000) * 2) / 2) });
      added++;
    });
  });
  NET = null; save(); drawRoutes(); renderNet();
  const panel = $('bb-net');
  panel.style.display = '';
  panel.innerHTML = `<p class="bb-hint">${added ? `${added} path${added > 1 ? 's' : ''} added, by train — set each one's vehicle and round trip on its box; drag a factory's ⇄ onto a box for one more stop.
    Then Plan network (the same outputs for the least ore and transport) or ⚖ Compare trades (what each trade would add).` : 'Every factory is already joined to its nearest.'}</p>`;
}

function planNetwork() {
  const panel = $('bb-net');
  if (!LAYOUT.routes.length) {
    panel.style.display = '';
    panel.innerHTML = NO_ROUTES;
    return;
  }
  panel.style.display = '';
  panel.innerHTML = '<p class="bb-hint">Planning…</p>';
  fetch('/api/network', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routes: LAYOUT.routes }),
  }).then(r => r.json()).then(out => { NET = out; drawRoutes(); renderNet(); })
    .catch(e => { panel.innerHTML = `<p class="bb-warn">Planning failed: ${e.message}</p>`; });
}

function renderNet() {
  const panel = $('bb-net');
  if (!NET) { panel.style.display = 'none'; return; }
  if (!NET.ok) { panel.innerHTML = `<p class="bb-warn">${NET.error}</p>`; return; }
  const name = k => factory(k)?.name || k;
  let h = `<div class="bb-net-t">Network plan <span class="bb-x" id="bb-net-close" title="Close">✕</span></div>
    <p class="bb-hint">Fractional machines — a planning view. Solve each factory on its own for its exact build.</p>`;
  if (NET.unsolved?.length) h += `<p class="bb-warn">Not solved, so held at their declared outputs: ${NET.unsolved.join(', ')}.</p>`;
  // what the whole network mines, against each factory's own plan
  const tot = {};
  NET.factories.forEach(f => Object.entries(f.resources).forEach(([it, x]) => { tot[it] = (tot[it] || 0) + x.used - x.before; }));
  const dres = Object.entries(tot).filter(([, d]) => Math.abs(d) > 0.5).sort((a, b) => a[1] - b[1])
    .map(([it, d]) => `<span class="${d < 0 ? 'bb-ok' : 'bb-warn'}">${itemName(it)} ${d < 0 ? '' : '+'}${fmt(Math.round(d))}</span>`).join(' · ');
  h += `<div class="bb-kpi"><b>${fmt(NET.throughput)}/min</b> moving between factories · <b>${fmt(NET.stacks)}</b> stacks/min</div>
    <div class="bb-hint">${dres ? `Mined, against the factories' own plans: ${dres} /min` : 'Mines what the factories\' own plans do.'}</div>
    <button class="bsm act" id="bb-apply" style="margin-top:6px" title="Write this plan into the factories, then re-solve them in order">Apply to the factories…</button>
    <div id="bb-chain"></div>`;
  const idle = NET.routes.filter(rt => !rt.items.length);
  NET.routes.filter(rt => rt.items.length).forEach(rt => {
    const vh = vehicles(rt), hv = heavy(rt, rt.items);
    if (hv) h += `<p class="bb-warn">${hv.long}</p>`;
    // the legs it runs loaded: the heaviest decides the vehicles, the rest ride along
    const busy = (rt.legs || []).filter(l => l.load > 1e-6);
    const top = busy.reduce((m, l) => (l.load > (m?.load ?? -1) ? l : m), null);
    h += `<div class="bb-net-s">${pathName(rt)} · ${MODES[rt.mode]}, ${rt.trip_min} min ${stopsOf(rt).length > 2 ? 'run' : 'round trip'}
      — <b>${vh.short}</b></div><div class="bb-hint">${vh.long}${busy.length > 1
        ? ` Loaded on ${busy.length} legs (${busy.map(l => `${name(l.from)} → ${name(l.to)} ${fmt(l.load)}`).join(', ')}): ${name(top.from)} → ${name(top.to)} decides; the rest ride along.` : ''}</div>`;
    h += rt.items.length ? '<table class="bb-tab"><tr><th></th><th>/min</th><th>stacks/min</th><th>' + LOAD_UNIT[rt.mode] + '</th></tr>' +
      rt.items.map(i => `<tr><td>${name(i.from)} → ${name(i.to)}: ${itemName(i.item)}</td><td>${fmt(i.rate)}</td>
        <td>${i.stacks == null ? '—' : fmt(i.stacks)}</td><td>${fmt(i.load)}</td></tr>`).join('') + '</table>'
      : '';
  });
  if (idle.length) h += `<p class="bb-hint">Nothing to carry: ${idle.map(pathName).join(' · ')}</p>`;
  NET.factories.forEach(f => {
    const r = f.recipes, list = (o, fmtv) => Object.entries(o).map(([k, v]) => `${recipeName(k)} ${fmtv(v)}`).join(', ');
    const lines = [];
    if (Object.keys(r.added).length) lines.push(`<b>Now runs</b> ${list(r.added, v => `(${fmt(v)})`)}`);
    if (Object.keys(r.dropped).length) lines.push(`<b>No longer runs</b> ${list(r.dropped, () => '')}`);
    if (Object.keys(r.changed).length) lines.push(`<b>Changes</b> ${list(r.changed, v => `${fmt(v[0])} → ${fmt(v[1])}`)}`);
    const res = Object.entries(f.resources).filter(([, x]) => x.used > 0.01 || x.before > 0.01).map(([it, x]) => {
      const d = x.used - x.before;
      return `${itemName(it)} ${fmt(x.used)} of ${fmt(x.supply)}${Math.abs(d) > 0.01 ? ` <span class="${d < 0 ? 'bb-ok' : 'bb-warn'}">(${d < 0 ? '' : '+'}${fmt(d)})</span>` : ''}`;
    });
    const hr = NET.headroom?.[f.key];
    h += `<div class="bb-net-s">${f.name}</div>
      <div class="bb-net-b">${lines.join('<br>') || 'Same recipes as its own plan.'}</div>
      ${res.length ? `<div class="bb-net-b">Draws: ${res.join(' · ')}</div>` : ''}
      ${hr ? `<div class="bb-net-b">With the network's leftovers: up to <b>${fmt(hr.most)}</b>
        ${hr.unit === 'per_min' ? `${itemName(hr.items[0])}/min` : `goal score (${hr.items.map(itemName).join(' + ')})`}
        — now ${fmt(hr.now)}</div>` : ''}`;
  });
  panel.innerHTML = h;
  $('bb-net-close').addEventListener('click', () => { panel.style.display = 'none'; });
  $('bb-apply').addEventListener('click', applyNet);
}

// ══════════════════════════════════════════════════════════
// ITEMS — every item across the factories: made, taken, stored, free
// ══════════════════════════════════════════════════════════

function renderItems() {
  if (!DATA) return;
  const all = new Set();
  DATA.factories.forEach(f => [f.exports, f.surplus, f.inside, f.imports, f.storage].forEach(o => Object.keys(o || {}).forEach(it => all.add(it))));
  $('bb-items-list').innerHTML = [...all].sort().map(it => `<option value="${itemName(it)}">`).join('');
  const out = $('bb-items-out');
  const want = $('bb-items-q').value.trim().toLowerCase().replace(/_/g, ' ');
  // nothing typed: what moves — stored or taken by another factory, most first
  const moved = it => DATA.factories.reduce((s, f) => s + Object.values(f.taken_by?.[it] || {}).reduce((a, r) => a + r, 0), 0);
  const exact = want ? [...all].filter(it => itemName(it).toLowerCase() === want) : [];
  const items = !want ? [...all].filter(it => moved(it) > 1e-6).sort((a, b) => moved(b) - moved(a))
    : exact.length ? exact : [...all].filter(it => itemName(it).toLowerCase().includes(want)).sort().slice(0, 12);
  if (!items.length) {
    out.innerHTML = `<p class="bb-hint">${want ? 'No factory makes or takes that.' : 'Nothing stored or moved between factories yet — type an item to see who makes it.'}</p>`;
    return;
  }
  const unit = it => (FLUIDS.has(it) ? ' m³' : '') + '/min';
  const nm = k => `<span class="bb-name" data-key="${k}" style="font-weight:400">${factory(k)?.name || k}</span>`;
  out.innerHTML = items.map(it => {
    const makers = DATA.factories.map(f => {
      const made = it in (f.exports || {}) ? f.exports[it] : f.surplus?.[it];   // null: a goal not solved yet
      const by = f.taken_by?.[it] || {};
      const stored = by[STORE] || 0;
      const others = Object.entries(by).filter(([k]) => k !== STORE && k !== f.key);
      const taken = others.reduce((s, [, r]) => s + r, 0);
      return { f, made, stored, others, left: made == null ? null : made - taken - stored, inside: f.inside?.[it] || 0 };
    }).filter(m => m.made !== undefined || m.inside > 0 || m.stored > 0)
      .sort((a, b) => (b.left ?? -1) - (a.left ?? -1) || (b.made || 0) - (a.made || 0));
    const takers = DATA.factories.filter(f => (f.sources || []).some(s => s.item === it && !factory(s.factory)));
    const free = makers.reduce((s, m) => s + Math.max(0, m.left || 0), 0);
    const stored = makers.reduce((s, m) => s + m.stored, 0);
    const rows = makers.map(m => {
      const sends = m.made !== undefined;
      return `<tr><td>${nm(m.f.key)}${m.f.solved ? '' : ' <span class="bb-hint">(not solved)</span>'}</td>
        <td class="num">${sends ? (m.made == null ? 'max' : fmt(m.made)) : '—'}</td>
        <td class="st-by">${m.others.length ? m.others.map(([k, r]) => `${nm(k)} ${fmt(r)}`).join(' · ') : ''}</td>
        <td class="num"><input class="st-in" data-sto="${m.f.key}" data-item="${it}" inputmode="decimal" value="${m.stored ? fmt(m.stored).replace(/,/g, '') : ''}" placeholder="0"
          title="Sent to storage by ${m.f.name} — change it here; that factory is saved with it"/></td>
        <td class="num ${m.left != null && m.left < -1e-6 ? 'bb-warn' : m.left > 1e-6 ? 'bb-ok' : ''}">${m.left == null ? '—' : fmt(m.left)}</td>
        <td class="bb-hint">${m.inside > 0 && !sends ? `makes ${fmt(m.inside)} inside and uses it all` : m.inside > (m.made || 0) + 1e-6 ? `${fmt(m.inside)} made, ${fmt(m.inside - (m.made || 0))} used inside` : ''}</td></tr>`;
    }).join('');
    return `<div class="fd-item"><h4>${itemName(it)}${FLUIDS.has(it) ? ' 💧' : ''} <span class="bb-hint" style="font-weight:400">· ${fmt(free)}${unit(it)} free${stored ? ` · ${fmt(stored)} stored` : ''}</span></h4>
      ${makers.length ? `<table class="st-tab"><tr><th>Factory</th><th style="text-align:right">Sends out</th><th>Taken by</th>
        <th style="text-align:right">Stored</th><th style="text-align:right">Free</th><th></th></tr>${rows}</table>` : '<p class="bb-hint">No saved factory makes it.</p>'}
      ${takers.length ? `<p class="bb-hint">Also brought in from outside the planner by ${takers.map(f => nm(f.key)).join(', ')}.</p>` : ''}</div>`;
  }).join('') + '<p class="bb-hint">Importing more than a factory has free takes the rest out of its storage. Stored items are held out of every import.</p>';
  out.querySelectorAll('.bb-name[data-key]').forEach(t => t.addEventListener('click', () => onOpenFactory(t.dataset.key)));
  out.querySelectorAll('[data-sto]').forEach(inp => {
    const set = () => {
      const v = Math.max(0, parseFloat(inp.value) || 0);
      setStored(inp.dataset.sto, inp.dataset.item, v).then(d => {
        if (d.error) { inp.classList.add('bb-warn'); inp.title = d.error; return; }
        document.dispatchEvent(new CustomEvent('factory-edited', { detail: { key: inp.dataset.sto, item: inp.dataset.item, storage: d.rate } }));
        openBlackboard();
      });
    };
    inp.addEventListener('change', set);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  });
}

// ══════════════════════════════════════════════════════════
// POWER — what each factory draws and makes, and the grid
// ══════════════════════════════════════════════════════════

const GEO_MW = { impure: 100, normal: 200, pure: 400 };

function renderPower() {
  const el = $('bb-power');
  if (!DATA) return;
  loadMap().then(() => {
    let made = 0, used = 0, geoFactories = 0;
    const anyGeo = DATA.factories.some(f => (f.power?.geothermal || 0) > 0);   // geysers inside a factory (older saves)
    const rows = DATA.factories.map(f => {
      const p = f.power || {};
      const draw = (p.machines || 0) + (p.extractors || 0), make = (p.generators || 0) + (p.geothermal || 0);
      used += draw; made += make; geoFactories += p.geothermal || 0;
      // the plan's own net against its cap (the cap counts machines and generators; geysers raise it)
      const net = (p.machines || 0) - (p.generators || 0);
      const capped = p.cap != null && p.solved && net >= 0.99 * (p.cap + (p.geothermal || 0)) - 1e-6;
      const plan = v => (p.solved ? fmt(v || 0) : '—');   // machines and generators need a current plan
      return `<tr><td><span class="bb-name" data-key="${f.key}" style="font-weight:400">${f.name}</span>${p.solved ? '' : ' <span class="bb-hint">(not solved)</span>'}</td>
        <td class="num">${plan(p.machines)}</td><td class="num">${fmt(p.extractors || 0)}</td>
        <td class="num">${plan(p.generators)}</td>${anyGeo ? `<td class="num">${fmt(p.geothermal || 0)}</td>` : ''}
        <td class="num ${make - draw < -1e-6 ? 'bb-warn' : 'bb-ok'}">${make - draw >= 0 ? '+' : ''}${fmt(make - draw)}</td>
        <td class="num">${p.cap == null ? '—' : fmt(p.cap)}</td>
        <td>${capped ? '<span class="bb-warn" title="Its plan uses all its power cap: more power would let it make more">cap limits it</span>' : ''}</td></tr>`;
    }).join('');
    // The grid's own geothermal generators (placed on the Map tab)
    const geys = (LAYOUT.geysers || []).map(mapNode).filter(Boolean);
    const geo = geys.reduce((a, n) => a + (GEO_MW[n.p] || 0), 0);
    const purity = ['pure', 'normal', 'impure'].map(p => [p, geys.filter(n => n.p === p).length]).filter(([, c]) => c)
      .map(([p, c]) => `${c} ${p}`).join(', ');
    made += geo;
    const gridRow = `<tr class="pw-grid"><td>⚡ Power grid <span class="bb-hint">${geys.length ? `geothermal × ${geys.length} (${purity})` : 'no geothermal yet — place them on the Map tab'}</span></td>
      <td class="num"></td><td class="num"></td><td class="num">${geys.length ? fmt(geo) : '—'}</td>${anyGeo ? '<td class="num"></td>' : ''}
      <td class="num bb-ok">${geo ? '+' + fmt(geo) : ''}</td><td class="num"></td><td></td></tr>`;
    const bal = made - used;
    // every geyser at the low of its swing (½×) at once: the grid's worst moment
    const low = bal - (geo + geoFactories) / 2;
    el.innerHTML = `<div class="bb-kpi" style="margin-bottom:4px">Grid: <b>${fmt(made)} MW</b> made · <b>${fmt(used)} MW</b> used ·
        <span class="${bal < 0 ? 'bb-warn' : 'bb-ok'}"><b>${bal >= 0 ? fmt(bal) + ' MW spare' : fmt(-bal) + ' MW short'}</b></span></div>
      ${geo + geoFactories ? `<div class="bb-kpi" style="margin-bottom:10px">With every geyser at its low: <span class="${low < 0 ? 'bb-warn' : 'bb-ok'}"><b>${low >= 0 ? fmt(low) + ' MW spare' : fmt(-low) + ' MW short'}</b></span>
        <span class="bb-hint">· at its high: ${fmt(bal + (geo + geoFactories) / 2)} MW spare</span></div>` : '<div style="height:6px"></div>'}
      <table class="st-tab"><tr><th>Factory</th><th style="text-align:right">Machines</th><th style="text-align:right">Extractors</th>
        <th style="text-align:right">Generators</th>${anyGeo ? '<th style="text-align:right">Geothermal</th>' : ''}<th style="text-align:right">Net MW</th><th style="text-align:right">Cap</th><th></th></tr>${rows}${gridRow}</table>
      <p class="bb-hint" style="margin-top:10px">Machines and generators come from each factory's plan, extractors from its nodes.
        Geothermal generators sit on geysers on the grid (Map tab → ⚡ Geothermal); a geyser swings between ½× and 1½× its average, so the
        grid is shown at the average and with every geyser at its low. A factory's power cap is what the grid gives it.</p>`;
    el.querySelectorAll('.bb-name[data-key]').forEach(t => t.addEventListener('click', () => onOpenFactory(t.dataset.key)));
  });
}

// ══════════════════════════════════════════════════════════
// MAP — every factory's nodes, what your save mines, what's free
// ══════════════════════════════════════════════════════════

function renderMapTab() {
  const el = $('bb-map');
  el.innerHTML = '<p class="bb-hint" style="padding:14px">Loading the map…</p>';
  fetchFactoryOutputs().then(o => mountMapView(el, {
    owners: o.nodes || {}, factories: o.factories.map(f => ({ key: f.key, name: f.name })),
    pins: o.pins || [], onOpen: onOpenFactory,
    // what each factory's nodes give that its plan doesn't use, less what others already take of it
    spare: o.factories.flatMap(f => Object.entries(f.spare || {}).map(([item, v]) => {
      const taken = Object.entries(o.claims[f.key]?.[item] || {}).reduce((a, [k, r]) => a + (k === f.key ? 0 : r), 0);
      return { factory: f.key, name: f.name, item, left: Math.max(0, Math.min(v, f.made[item] ?? v) - taken), stale: f.stale,
               ids: Object.entries(o.nodes || {}).filter(([, k]) => k === f.key).map(([id]) => id) };
    })),
    // the grid's geothermal generators: saved with the board, at once
    grid: LAYOUT.geysers || [],
    network: mapNetwork(),
    onGrid: ids => { LAYOUT.geysers = ids; saveNow(); },
  }));
}

// The network for the map: factories where their nodes are, and each path —
// its stretches, what rides each (the network plan's, else what the
// factories' imports declare) and the vehicles it keeps busy
const ICON = { train: '🚆', truck: '🚚', tractor: '🚜', drone: '🛸' };
function mapNetwork() {
  if (!DATA) return null;
  const hubs = DATA.factories.filter(f => f.at).map(f => ({ key: f.key, name: f.name, x: f.at[0], y: f.at[1] }));
  if (!hubs.length) return null;
  const paths = LAYOUT.routes.map((rt, i) => {
    const fl = routeFlows(rt, i), plan = NET?.ok ? NET.routes[i] : fl.length ? declaredLoad(rt, fl) : null;
    return { mode: rt.mode, icon: ICON[rt.mode], name: pathName(rt), what: MODES[rt.mode],
      run: `${rt.trip_min} min ${stopsOf(rt).length > 2 ? (looped(rt) ? 'loop' : 'run') : 'round trip'}`,
      vehicles: plan ? vehicles(plan).short : '',
      segs: stretchesOf(rt, fl).map(sg => ({ a: sg.a, b: sg.b, an: nameOf(sg.a), bn: nameOf(sg.b), rate: sg.rate, lines: sg.items.map(flowTitle) })) };
  });
  return { hubs, paths };
}

// Write the plan into the factories: what each takes from the others becomes
// its imports, the alternates it now runs are switched on; then re-solve them
// in order, so each gets its exact build.
function applyNet() {
  const flows = NET.routes.flatMap(rt => rt.items.map(i => ({ from: i.from, to: i.to, item: i.item, rate: i.rate })));
  const alts = {};
  NET.factories.forEach(f => {
    const a = Object.keys(f.recipes.added).filter(k => RECIPES[k]?.alternate);
    if (a.length) alts[f.key] = a;
  });
  applyFlows(flows, alts);
}
// Write what crosses into the factories' imports (and switch on alternates), then re-solve them in order
function applyFlows(flows, alts = {}) {
  const name = k => factory(k)?.name || k;
  const lines = [];
  flows.forEach(f => lines.push(`${name(f.to)} takes ${fmt(f.rate)}/min ${itemName(f.item)} from ${name(f.from)}`));
  Object.entries(alts).forEach(([k, a]) => lines.push(`${name(k)} switches on ${a.map(recipeName).join(', ')}`));
  if (!lines.length) { alert('Nothing to change.'); return; }
  if (!confirm(`Apply the network plan?\n\n${lines.join('\n')}\n\nEach factory's imports from the others are replaced by these; then they're re-solved, sources first. Each save keeps the version it replaces (Saved → ⟲).`)) return;
  fetch('/api/apply-network', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flows, alts }) })
    .then(r => r.json()).then(d => {
      if (d.error) { $('bb-chain').innerHTML = `<p class="bb-warn">${d.error}</p>`; return; }
      document.dispatchEvent(new CustomEvent('resolve-chain-watch'));
      let seen = false;     // this run, not an earlier one
      const off = onChain(st => {
        const el = $('bb-chain');
        if (!el) { off(); return; }
        if (st.running) seen = true;
        if (!seen) return;
        el.innerHTML = chainHTML(st);
        if (!st.running) { off(); openBlackboard(); }
      });
    });
}


// ══════════════════════════════════════════════════════════
// COMPARING TRADES
// ══════════════════════════════════════════════════════════
// "Bring Quickwire in, or send the Plastic over?" — each thing one factory on a
// route could send another, tried on its own on top of what they already send
// (network.compare_trades): how much more of each goal (none goes down for it),
// what it frees with the goals held, and the vehicles it keeps busy. All of
// them together is the network plan. Free nodes nearby can count as more to mine.
let TRADES = null;
const NO_ROUTES = `<p class="bb-hint">No paths yet: the planner only moves things between factories you've joined.
  Click <b>＋ Join them all</b> (each to its nearest, by train), or drag a factory's ⇄ onto another.</p>`;
function compareTrades() {
  const panel = $('bb-net');
  panel.style.display = '';
  if (!LAYOUT.routes.length) { panel.innerHTML = NO_ROUTES; return; }
  panel.innerHTML = '<p class="bb-hint">Trying each trade on its own…</p>';
  fetch('/api/trades', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routes: LAYOUT.routes, nearby_km: +$('bb-near-km').value || 0 }) })
    .then(r => r.json()).then(d => { TRADES = d; renderTrades(); })
    .catch(e => { panel.innerHTML = `<p class="bb-warn">Comparing failed: ${e.message}</p>`; });
}
function renderTrades() {
  const panel = $('bb-net'), d = TRADES;
  if (!d?.ok) { panel.innerHTML = `<p class="bb-warn">${d?.error || 'Nothing to compare.'}</p>`; return; }
  const nm = k => d.names?.[k] || k;
  const pc = v => `${v > 0 ? '+' : ''}${Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;
  const gains = t => Object.entries(t.gain || {}).flatMap(([k, gs]) => Object.entries(gs).map(([it, p]) =>
    t.new?.[k]?.[it] != null ? `<span class="tr-g">${fmt(t.new[k][it])}/min</span> ${itemName(it)} <span class="n-hint">at ${nm(k)}, from none</span>`
      : `<span class="tr-g">${pc(p)}</span> ${itemName(it)} <span class="n-hint">at ${nm(k)}</span>`)).join(' · ');
  const freed = t => Object.entries(t.freed || {}).flatMap(([k, fr]) => Object.entries(fr).map(([it, v]) =>
    `${fmt(v)}/min ${itemName(it)} <span class="n-hint">at ${nm(k)}</span>`)).join(' · ');
  const moves = t => (t.routes || []).map(r => vehicles({ ...r, cars: r.cars }).short).join(' · ');
  // what it takes from free nodes nearby, per factory, biggest first (the node counts on hover)
  const near = t => Object.entries(t.nearby || {}).map(([k, res]) => `<div class="bb-net-b"><b>Near ${nm(k)}</b>: ${
    Object.entries(res).sort((a, b) => b[1] - a[1]).map(([it, v]) => {
      const n = (d.nearby_nodes?.[k]?.[it] || []).length;
      return `<span title="of ${n} free node${n === 1 ? '' : 's'} nearby">${itemName(it)} ${fmt(Math.round(v))}</span>`;
    }).join(' · ')}</div>`).join('');
  // the shipments, largest first: a few, then how many more
  const shipments = (fl, most = 5) => {
    const f = [...(fl || [])].sort((a, b) => b.rate - a.rate);
    return f.slice(0, most).map(x => `${itemName(x.item)} ${fmt(Math.round(x.rate))}/min ${nm(x.from)} → ${nm(x.to)}`).join(' · ')
      + (f.length > most ? ` <span class="n-hint">+${f.length - most} smaller</span>` : '');
  };
  const row = (t, i) => `<div class="tr-row">
      <div class="tr-h"><span>${i + 1}. ${itemName(t.item)}: ${nm(t.from)} → ${nm(t.to)}</span>
        <button class="bsm" data-tr="${i}" title="Write this into the factories' imports, then re-solve them">Apply</button></div>
      ${t.score > 0.05 ? `<div>${gains(t)}</div>` : ''}
      ${t.frees > 0.25 ? `<div><span class="tr-f">frees ${t.frees.toFixed(1)}%</span>${freed(t) ? `: ${freed(t)}` : ''} <span class="n-hint">goals held</span></div>` : ''}
      <div class="n-hint">${(t.flows || []).filter(f => f.item === t.item).map(f => `${fmt(f.rate)}/min`).join(', ')}${moves(t) ? ` · ${moves(t)}` : ''}</div>
    </div>`;
  const all = d.all, nowNear = near(d.now);
  // today's trades at the rates the network would run them — against the saved plans
  const vsSaved = Object.entries(d.now.goals || {}).flatMap(([k, gs]) => Object.entries(gs)
    .filter(([, g]) => g.then - g.now > Math.max(0.01, 0.01 * g.now))
    .map(([it, g]) => `<span class="tr-g">${g.now > 1e-6 ? pc(100 * (g.then - g.now) / g.now) : `${fmt(g.then)}/min`}</span> ${itemName(it)} <span class="n-hint">at ${nm(k)}, ${fmt(g.now)} → ${fmt(g.then)}/min</span>`)).join(' · ');
  const declared = (d.now.flows || []).filter(f => f.rate > 0.05);
  panel.innerHTML = `<div class="bb-net-t">Compare trades <span class="bb-x" id="bb-net-close" title="Close">✕</span></div>
    <p class="bb-hint">Each trade below on its own, on top of today's trades at the right rates — no goal goes down for it.
      ${d.tried} tried${d.unsolved?.length ? `; not solved, so held at their declared outputs: ${d.unsolved.join(', ')}` : ''}.</p>
    ${nowNear ? `<div class="bb-hint" style="margin-top:4px">From free nodes nearby, as things are — mined in every option below:</div>${nowNear}` : ''}
    ${vsSaved ? `<div class="tr-row"><div class="tr-h"><span>Your trades now, at the right rates</span><button class="bsm act" id="tr-now" title="Write these rates into the factories' imports, then re-solve">Apply</button></div>
      <div>${vsSaved}</div><div class="n-hint">${shipments(declared)}</div></div>` : ''}
    <div class="tr-row"><div class="tr-h"><span>All of them together</span><button class="bsm act" id="tr-all" title="The network plan: write it in, then re-solve">Apply</button></div>
      ${all.score > 0.05 ? `<div>${gains(all)}</div>` : ''}${all.frees > 0.25 ? `<div><span class="tr-f">frees ${all.frees.toFixed(1)}%</span>${freed(all) ? `: ${freed(all)}` : ''}</div>` : ''}
      <div class="n-hint">${shipments(all.flows) || 'nothing more to send'}</div></div>
    ${d.trades.length ? d.trades.map(row).join('') : '<p class="bb-hint">No single trade adds to a goal or frees anything.</p>'}
    ${d.no_effect?.length ? `<details class="bb-hint" style="margin-top:8px"><summary>${d.no_effect.length} change nothing</summary>
      ${d.no_effect.map(([a, b, it]) => `${itemName(it)} ${nm(a)} → ${nm(b)}`).join(' · ')}</details>` : ''}
    <div id="bb-chain"></div>`;
  $('bb-net-close').addEventListener('click', () => { panel.style.display = 'none'; });
  $('tr-all').addEventListener('click', () => applyFlows(all.flows || []));
  $('tr-now')?.addEventListener('click', () => applyFlows(declared));
  panel.querySelectorAll('[data-tr]').forEach(b => b.addEventListener('click', () => applyFlows(d.trades[+b.dataset.tr].flows || [])));
}


// ══════════════════════════════════════════════════════════
// THE WORLD MAP
// ══════════════════════════════════════════════════════════
/**
 * The 1.0 world map: every resource node, resource-well
 * satellite and geyser (data/game.json), drawn by position; bigger and
 * brighter is purer.
 *
 * Two uses of one map:
 *   openMapPicker  pick the nodes a factory mines. Click a node, or drag a box
 *                  round a region (Shift+drag takes them out); pan with the
 *                  right button, Space+drag or the arrows; scroll to zoom. Nodes another factory
 *                  mines are crossed out. Geysers take geothermal generators.
 *                  Water extractors go anywhere there's water: drop pins.
 *                  The list on the right sets each extractor's shards.
 *   mountMapView   the Blackboard's map: whose node is whose, what your save
 *                  already mines, and what's still free.
 * Leftover (a green ring) and In your save (yellow) are views of their own:
 * every node a factory leaves some of unused, and every node your save mines
 * that no factory has — those the picker can add at once.
 * Load a save to mark the nodes your game already mines (yellow rings), and
 * your own map picture to draw them on (it's lined up with the in-game map's
 * edges; nudge it if it's off).
 */

// The full picture takes seconds to decode, so once it's here the browser cuts
// it into the tiles the map shows from then on (server.py, _map_tiles): decoded
// once, each tile cropped and scaled off the main thread, kept by the server
let TILES_FOR = null;          // the picture being cut (a new one is cut afresh)
// (in a worker: nothing of it runs on the page's own thread)
const TILE_WORKER = `onmessage = async ({ data: { src, origin } }) => {
  try {
    const big = await createImageBitmap(await (await fetch(origin + src)).blob()), w = big.width, h = big.height;
    for (let z = 0; z < 3 && (z === 0 || w / 2 ** z >= 1600); z++) {
      const n = 2 ** z, tw = w / n, th = h / n, out = Math.min(2048, Math.round(tw));
      for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
        const bmp = await createImageBitmap(big, Math.round(x * tw), Math.round(y * th), Math.round(tw), Math.round(th),
          { resizeWidth: out, resizeHeight: Math.round(out * th / tw), resizeQuality: 'high' });
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        c.getContext('2d').drawImage(bmp, 0, 0); bmp.close();
        let b = await c.convertToBlob({ type: 'image/webp', quality: 0.85 });
        if (b.type !== 'image/webp') b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
        await fetch(origin + '/api/map-tile?z=' + z + '&x=' + x + '&y=' + y, { method: 'POST', headers: { 'Content-Type': b.type }, body: b });
      }
      postMessage({ level: z });          // a level done: the map can show it
    }
    big.close();
    postMessage({ ok: true });
  } catch (e) { postMessage({ ok: false, error: String(e) }); }
};`;
const canTile = () => !!(window.Worker && window.OffscreenCanvas && window.createImageBitmap);
function makeTiles(src) {
  if (TILES_FOR === src || !canTile()) return;
  TILES_FOR = src;
  const url = URL.createObjectURL(new Blob([TILE_WORKER], { type: 'text/javascript' }));
  const wk = new Worker(url);
  wk.onmessage = async ({ data }) => {
    if ('level' in data) {           // show what's there so far
      MAPD.img = { ...MAPD.img, ...await (await fetch('/api/map-settings')).json() };
      document.dispatchEvent(new Event('map-picture'));
      return;
    }
    wk.terminate(); URL.revokeObjectURL(url);
    if (!data.ok) { console.warn('map tiles:', data.error); TILES_FOR = null; }
  };
  wk.postMessage({ src, origin: location.origin });
}
const fmtM = v => (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : +v.toFixed(1)).toLocaleString();
const COLORS = {
  Iron_Ore: '#9aa6b8', Copper_Ore: '#e07a3f', Limestone: '#d9cfb0', Coal: '#5b5f6b', Caterium_Ore: '#e8c547',
  Raw_Quartz: '#d77bd8', Sulfur: '#d6e04a', Bauxite: '#c8553d', Uranium_Ore: '#6ee06e', SAM: '#9b6cf0',
  Crude_Oil: '#3a3a52', Nitrogen_Gas: '#7fb7d9', Water: '#3fa7f5', Geyser: '#ff6b9a',
};
const CAP = { Miner: 1200, Oil_Extractor: 600, Water_Extractor: 600 };
const FACTORY_COLORS = ['#f59e0b', '#22c55e', '#38bdf8', '#f472b6', '#a78bfa', '#ef4444', '#14b8a6', '#eab308', '#fb923c', '#84cc16'];
// Labels up close: the bubble already says the purity, so just a short name (none
// when only one resource is shown) and whose it is
const SHORT = { Iron_Ore: 'Iron', Copper_Ore: 'Copper', Caterium_Ore: 'Caterium', Raw_Quartz: 'Quartz', Uranium_Ore: 'Uranium',
  Crude_Oil: 'Oil', Nitrogen_Gas: 'Nitrogen', Limestone: 'Lime' };
const shortOf = r => SHORT[r] || resName(r);
const DARK = new Set(['Coal', 'Crude_Oil', 'Bauxite', 'SAM', 'Copper_Ore']);   // purity letters in white on these
const resName = r => (r === 'Geyser' ? 'Geyser' : itemName(r));
// What a factory mines; geysers' generators go on the grid (the Blackboard's map)
const PICKABLE = Object.keys(COLORS).filter(r => r !== 'Geyser');


// The game's map is fetched once, in the background: draw it when it's here
let _waiting = false;
function waitForPicture(tries = 0) {
  if (MAPD.img?.ext || MAPD.img?.game !== 'downloading' || (_waiting && !tries)) return;
  _waiting = true;
  setTimeout(() => fetch('/api/map-settings').then(r => r.json()).then(ms => {
    MAPD.img = ms;
    if (ms.ext) { _waiting = false; document.dispatchEvent(new Event('map-picture')); document.querySelectorAll('.mp-tools').forEach(t => t._redo?.()); }
    else if (ms.game === 'downloading' && tries < 90) waitForPicture(tries + 1);
    else { _waiting = false; document.querySelectorAll('.mp-tools').forEach(t => t._redo?.()); }
  }).catch(() => { _waiting = false; }), 2000);
}

// ══════════════════════════════════════════════════════════
// One map in a container
// ══════════════════════════════════════════════════════════

// ── The ground, for the network's paths ─────────────────────────────────────
// Read from the map picture's whole-map tile, a cell per 1/GN of it: the game's
// map is shaded by height (lighter is higher), water is blue, off the map black.
// A truck keeps to gentle ground round hills and water; a train runs straight,
// turning only for a cliff or the map's edge (bridges are fine); a drone flies.
const GN = 256;
let GROUND = null;
function ground() {
  const img = MAPD.img;
  if (!img?.ext || !img.tiles) return Promise.resolve(null);
  const key = `${img.source}|${img.tiles_v}|${img.dx}|${img.dy}|${img.scale}`;
  if (GROUND?.key === key) return GROUND.p;
  const p = new Promise(res => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = GN;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(im, 0, 0, GN, GN);
      const d = cx.getImageData(0, 0, GN, GN).data, h = new Float32Array(GN * GN), kind = new Uint8Array(GN * GN);
      for (let i = 0; i < GN * GN; i++) {
        const r = d[4 * i], g = d[4 * i + 1], b = d[4 * i + 2];
        h[i] = (r + g + b) / 765;
        kind[i] = r + g + b < 90 ? 2 : b > r + 20 ? 1 : 0;      // 0 land, 1 water, 2 off the map
      }
      // where the picture sits on the map (m): yours nudged, the game's on the map's edges
      const bw = (MAPD.bounds.x[1] - MAPD.bounds.x[0]) * img.scale, bh = (MAPD.bounds.y[1] - MAPD.bounds.y[0]) * img.scale;
      const x0 = (MAPD.bounds.x[0] + MAPD.bounds.x[1]) / 2 + img.dx - bw / 2, y0 = (MAPD.bounds.y[0] + MAPD.bounds.y[1]) / 2 + img.dy - bh / 2;
      res({ h, kind, x0, y0, cw: bw / GN, ch: bh / GN, memo: new Map() });
    };
    im.onerror = () => res(null);
    im.src = `/api/map-tile?z=0&x=0&y=0&v=${img.tiles_v || 0}`;
  });
  GROUND = { key, p };
  return p;
}
const CLIFF = 0.07;     // a step in shade this big from one cell to the next is a cliff
// The way from a to b ({x, y} in m) by this vehicle: points in m, or null (go straight)
function trace(G, mode, a, b) {
  if (!G || mode === 'drone') return null;
  const k = `${mode}|${a.x},${a.y}|${b.x},${b.y}`;
  if (G.memo.has(k)) return G.memo.get(k);
  const cell = p => [Math.min(GN - 1, Math.max(0, Math.floor((p.x - G.x0) / G.cw))), Math.min(GN - 1, Math.max(0, Math.floor((p.y - G.y0) / G.ch)))];
  const [sx0, sy0] = cell(a), [tx, ty] = cell(b), S = sy0 * GN + sx0, T = ty * GN + tx;
  const train = mode === 'train';
  const step = (i, j, dist) => {
    if (G.kind[j] === 2 && j !== T && j !== S) return Infinity;
    const dh = Math.abs(G.h[j] - G.h[i]);
    if (train) return dist * (1 + (dh > CLIFF ? 300 * dh : 0) + (G.kind[j] === 1 ? 1 : 0));
    return dist * (1 + 60 * dh + (G.kind[j] === 1 ? 30 : 0));
  };
  // A* on the grid, eight ways
  const cost = new Float32Array(GN * GN).fill(Infinity), from = new Int32Array(GN * GN).fill(-1);
  const heap = [[0, S]];
  const push = (f, i) => { heap.push([f, i]); let c = heap.length - 1; while (c) { const q = (c - 1) >> 1; if (heap[q][0] <= heap[c][0]) break; [heap[q], heap[c]] = [heap[c], heap[q]]; c = q; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
  const hx = i => Math.hypot(i % GN - tx, ((i / GN) | 0) - ty);
  cost[S] = 0;
  let found = false, guard = 0;
  while (heap.length && guard++ < 400000) {
    const [, i] = pop();
    if (i === T) { found = true; break; }
    const x = i % GN, y = (i / GN) | 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GN || ny >= GN) continue;
      const j = ny * GN + nx, c = cost[i] + step(i, j, dx && dy ? Math.SQRT2 : 1);
      if (c < cost[j]) { cost[j] = c; from[j] = i; push(c + hx(j), j); }
    }
  }
  let out = null;
  if (found) {
    const cells = [];
    for (let i = T; i !== -1; i = from[i]) cells.push(i);
    cells.reverse();
    // pulled tight: from each point, straight on to the farthest one the way
    // there stays as easy (a train: no cliff, off the map nowhere)
    const ok = (i, j) => {
      const x1 = i % GN, y1 = (i / GN) | 0, x2 = j % GN, y2 = (j / GN) | 0, n = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
      let prev = i, c = 0;
      for (let t = 1; t <= n; t++) {
        const q = Math.round(y1 + (y2 - y1) * t / n) * GN + Math.round(x1 + (x2 - x1) * t / n);
        if (G.kind[q] === 2 && q !== T) return false;
        if (train && Math.abs(G.h[q] - G.h[prev]) > CLIFF) return false;
        c += step(prev, q, Math.hypot((q % GN) - (prev % GN), ((q / GN) | 0) - ((prev / GN) | 0)));
        prev = q;
      }
      return train || c <= (cost[j] - cost[i]) * 1.08 + 1;
    };
    const keep = [cells[0]];
    for (let k2 = 0; k2 < cells.length - 1;) {
      let far = k2 + 1;
      for (let m = cells.length - 1; m > far; m--) if (ok(cells[k2], cells[m])) { far = m; break; }
      keep.push(cells[far]);
      k2 = far;
    }
    let pts = keep.map(i => ({ x: G.x0 + (i % GN + 0.5) * G.cw, y: G.y0 + (((i / GN) | 0) + 0.5) * G.ch }));
    pts[0] = { x: a.x, y: a.y }; pts[pts.length - 1] = { x: b.x, y: b.y };
    if (!train) for (let r = 0; r < 2 && pts.length > 2; r++)     // a road's bends rounded off
      pts = [pts[0], ...pts.slice(0, -1).flatMap((p, i) => { const q = pts[i + 1];
        return [{ x: 0.75 * p.x + 0.25 * q.x, y: 0.75 * p.y + 0.25 * q.y }, { x: 0.25 * p.x + 0.75 * q.x, y: 0.25 * p.y + 0.75 * q.y }]; }), pts[pts.length - 1]];
    out = pts.length > 2 ? pts : null;
  }
  G.memo.set(k, out);
  return out;
}

function makeMap(el, M) {
  // M: { filter:Set, picked?:Set, taken?, owner?, ownerColor?, pins?, onClick(id), onBox(ids, remove), onPin?(x,y) }
  el._mapOff?.abort();                    // a map remade in the same place drops the old one's listeners
  const off = new AbortController(), on = { signal: off.signal };
  el._mapOff = off;
  el.classList.add('mp-map');
  el.innerHTML = `<div class="mp-bg"></div><svg></svg><div class="mp-tip"></div>
    <div class="mp-zoom"><button class="bsm" data-z="in" title="Zoom in (+)">+</button><button class="bsm" data-z="out" title="Zoom out (−)">−</button>
      <button class="bsm" data-z="fit" title="The whole map (0)">⤢</button></div>
    <div class="mp-level"></div>`;
  const svg = el.querySelector('svg'), tip = el.querySelector('.mp-tip'), bg = el.querySelector('.mp-bg');
  const fit = () => {
    const w = el.clientWidth, h = el.clientHeight;
    const bw = MAPD.bounds.x[1] - MAPD.bounds.x[0], bh = MAPD.bounds.y[1] - MAPD.bounds.y[0];
    const scale = Math.min(w / bw, h / bh) * 0.96;
    M.fitScale = scale;
    M.view = { scale, ox: (w - bw * scale) / 2 - MAPD.bounds.x[0] * scale, oy: (h - bh * scale) / 2 - MAPD.bounds.y[0] * scale };
  };
  const sx = x => x * M.view.scale + M.view.ox, sy = y => y * M.view.scale + M.view.oy;
  const wx = px => (px - M.view.ox) / M.view.scale, wy = py => (py - M.view.oy) / M.view.scale;
  // How much each node shows: dots from afar; its purity when you're closer or
  // have picked one or two resources; its name and whose it is up close
  const level = () => {
    const rel = M.view.scale / (M.fitScale || M.view.scale);
    return rel >= 4.5 ? 2 : rel >= 2 || (!M.only && M.filter.size <= 2) ? 1 : 0;
  };
  const SIZE = [{ impure: 2.5, normal: 3.5, pure: 4.5 }, { impure: 5, normal: 6.5, pure: 8 }, { impure: 6, normal: 7.5, pure: 9.5 }];
  const LETTER = { impure: 'I', normal: 'N', pure: 'P' };

  // What's on the map: the resources picked above — or, in a view of its own,
  // every node some factory leaves unused, or every node your save mines that
  // no factory has yet (to rebuild those factories on)
  const spareIds = () => new Set((M.spare || []).filter(sp => sp.left > 0.05).flatMap(sp => sp.ids));
  const inSave = n => MAPD.save.has(n.id) && !M.taken?.[n.id] && !M.owner?.[n.id];
  M.shows = (n, spare = spareIds()) => M.only === 'spare' ? spare.has(n.id) : M.only === 'save' ? inSave(n) : M.filter.has(n.r);

  // The picture as tiles (or, until they're made, the full picture): the whole
  // map's tile always underneath, so nothing goes blank while a closer one loads
  const tileOf = new Map();
  function tile(key, src, css) {
    let im = tileOf.get(key);
    if (!im) {
      im = new Image(); im.alt = ''; im.draggable = false; im.decoding = 'async';
      im.style.cssText = `position:absolute;${css}`; im.src = src;
      tileOf.set(key, im); bg.appendChild(im);
    }
    return im;
  }
  function drawPicture() {
    if (!MAPD.img?.ext) { bg.style.display = 'none'; return; }
    // yours nudged by dx, dy, scale; the game's exactly on the map's edges
    const bw = (MAPD.bounds.x[1] - MAPD.bounds.x[0]) * MAPD.img.scale, bh = (MAPD.bounds.y[1] - MAPD.bounds.y[0]) * MAPD.img.scale;
    const cx = (MAPD.bounds.x[0] + MAPD.bounds.x[1]) / 2 + MAPD.img.dx, cy = (MAPD.bounds.y[0] + MAPD.bounds.y[1]) / 2 + MAPD.img.dy;
    const L = MAPD.img.tiles || 0, keep = new Set();
    const src = `/api/map-image?v=${MAPD.img.v || 0}&s=${MAPD.img.source || ''}`;
    if (!L && canTile()) {
      // no tiles yet (the first time, or a new picture): cut in the background,
      // shown level by level — the full picture would hold the page up for seconds
      makeTiles(src);
    } else if (!L) {      // a browser that can't cut them: the full picture
      tile('full:' + src, src, 'left:0;top:0;width:100%;height:100%');
      keep.add('full:' + src);
    } else {
      // the level whose tiles are sharp at this zoom (each 2048 across), and those in view
      const px = bw * M.view.scale * (window.devicePixelRatio || 1);
      let z = 0;
      while (z < L - 1 && 2048 * 2 ** z < px * 0.9) z++;
      const v = MAPD.img.tiles_v || 0;
      const want = (zz, x, y) => {
        const n = 2 ** zz, k = `${zz}-${x}-${y}`;
        tile(k, `/api/map-tile?z=${zz}&x=${x}&y=${y}&v=${v}`, `left:${100 * x / n}%;top:${100 * y / n}%;width:${100 / n + 0.01}%;height:${100 / n + 0.01}%;z-index:${zz}`);
        keep.add(k);
      };
      want(0, 0, 0);
      if (z > 0) {
        const n = 2 ** z, left = sx(cx - bw / 2), top = sy(cy - bh / 2), W = bw * M.view.scale, H = bh * M.view.scale;
        const x0 = Math.max(0, Math.floor(-left / W * n)), x1 = Math.min(n - 1, Math.floor((el.clientWidth - left) / W * n));
        const y0 = Math.max(0, Math.floor(-top / H * n)), y1 = Math.min(n - 1, Math.floor((el.clientHeight - top) / H * n));
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) want(z, x, y);
      }
    }
    // what's out of view goes; the full picture once the whole-map tile is in
    const base = tileOf.get('0-0-0');
    tileOf.forEach((im, k) => {
      if (keep.has(k) || (k.startsWith('full:') && base && !base.complete)) return;
      im.remove(); tileOf.delete(k);
    });
    if (base && !base.complete) base.addEventListener('load', () => drawPicture(), { once: true });
    Object.assign(bg.style, { display: 'block', left: `${sx(cx - bw / 2)}px`, top: `${sy(cy - bh / 2)}px`,
      width: `${bw * M.view.scale}px`, height: `${bh * M.view.scale}px`, opacity: MAPD.img.opacity });
  }

  // What a factory's nodes give that its plan doesn't use: a tag on its nodes
  // of that resource ("+230 unused"); in the picker, click it to bring it here
  function spareTags(lv) {
    let out = '';
    if (M.only === 'save' || !(lv === 2 || (M.only === 'spare' && lv >= 1))) return out;   // from afar, the rings say it
    (M.spare || []).forEach((sp, i) => {
      if ((M.only !== 'spare' && !M.filter.has(sp.item)) || !(sp.left > 0.05)) return;
      const ns = sp.ids.map(id => MAPD.by[id]).filter(Boolean);
      if (!ns.length) return;
      const x = sx(ns.reduce((a, n) => a + n.x, 0) / ns.length), y = sy(Math.min(...ns.map(n => n.y))) - 16;
      if (x < -80 || y < -30 || x > el.clientWidth + 80 || y > el.clientHeight + 30) return;
      const t = sp.bring > 0 ? `→ ${fmtM(sp.bring)} of ${fmtM(sp.left)} here` : `+${fmtM(sp.left)}${sp.fluid ? ' m³' : ''} unused`;
      const w = t.length * 6.3 + 14;
      out += `<g data-spare="${i}" class="mp-spare ${sp.bring > 0 ? 'on' : ''} ${M.onSpare ? 'act' : ''}">
        <rect x="${x - w / 2}" y="${y - 9}" width="${w}" height="18" rx="9"/><text x="${x}" y="${y + 4}">${t}</text></g>`;
    });
    return out;
  }

  function draw() {
    if (!M.view) fit();
    const w = el.clientWidth, h = el.clientHeight;
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    drawPicture();
    const lv = level();
    let g = '';
    if (!MAPD.img?.ext) {
      const step = M.view.scale > 0.4 ? 100 : 500;
      for (let x = Math.ceil(MAPD.bounds.x[0] / step) * step; x <= MAPD.bounds.x[1]; x += step)
        g += `<line class="mp-grid" x1="${sx(x)}" y1="${sy(MAPD.bounds.y[0])}" x2="${sx(x)}" y2="${sy(MAPD.bounds.y[1])}"/>`;
      for (let y = Math.ceil(MAPD.bounds.y[0] / step) * step; y <= MAPD.bounds.y[1]; y += step)
        g += `<line class="mp-grid" x1="${sx(MAPD.bounds.x[0])}" y1="${sy(y)}" x2="${sx(MAPD.bounds.x[1])}" y2="${sy(y)}"/>`;
    }
    let labels = '';
    // the network: factories where they are, joined by their routes — styled by
    // what runs them, as thick as what they carry
    if (M.network) {
      const { hubs, paths } = M.network, at = Object.fromEntries(hubs.map(h => [h.key, h]));
      const most = Math.max(1, ...paths.flatMap(p => p.segs.map(sg => sg.rate)));
      paths.forEach((p, pi) => {
        let mid = null, longest = -1;
        p.segs.forEach((sg, k) => {
          const a = at[sg.a], b = at[sg.b];
          if (!a || !b) return;
          const wpx = 2 + 6 * Math.sqrt(sg.rate / most);
          let pts;
          if (p.mode === 'drone') {      // flown: an arc, bowed to the right of the way
            const dx = b.x - a.x, dy = b.y - a.y, c = { x: (a.x + b.x) / 2 - dy * 0.22, y: (a.y + b.y) / 2 + dx * 0.22 };
            pts = Array.from({ length: 17 }, (_, t) => { const u = t / 16;
              return { x: (1 - u) ** 2 * a.x + 2 * u * (1 - u) * c.x + u * u * b.x, y: (1 - u) ** 2 * a.y + 2 * u * (1 - u) * c.y + u * u * b.y }; });
          } else pts = M.ways?.get(`${p.mode}|${a.x},${a.y}|${b.x},${b.y}`) || [a, b];
          const d = 'M' + pts.map(q => `${sx(q.x).toFixed(1)} ${sy(q.y).toFixed(1)}`).join('L');
          if (p.mode === 'train') g += `<path class="mp-rt-ties" d="${d}" style="stroke-width:${(wpx + 6).toFixed(1)}px"/>`;
          g += `<path class="mp-rt ${p.mode}${sg.rate ? '' : ' idle'}" d="${d}" style="stroke-width:${wpx.toFixed(1)}px"/>
            <path class="mp-rt-hit" data-rt="${pi}:${k}" d="${d}"/>`;
          const len = pts.reduce((t, q, i) => t + (i ? Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y) : 0), 0);
          if (len > longest) { longest = len; mid = pts[Math.floor(pts.length / 2)]; if (pts.length === 2) mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
        });
        // one sign per path, on its longest stretch: hover any stretch for what rides it
        if (mid) labels += `<g class="mp-rt-sign" data-rt="${pi}:-1"><circle cx="${sx(mid.x)}" cy="${sy(mid.y)}" r="10"/><text x="${sx(mid.x)}" y="${sy(mid.y) + 4}" text-anchor="middle">${p.icon}</text></g>`;
      });
      // small from afar, so the nodes round them stay in sight; full size up close
      const rel = M.view.scale / (M.fitScale || M.view.scale), r = rel >= 4.5 ? 8 : rel >= 2 ? 6 : 4;
      hubs.forEach(h => {
        const x = sx(h.x), y = sy(h.y);
        labels += `<g class="mp-hub${rel < 2 ? ' afar' : ''}" data-hub="${h.key}"><rect x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" rx="${r / 2.5}" style="fill:${h.color}"/>
          <text class="mp-hub-n" x="${x + r + 4}" y="${y + 4}">${h.name}</text></g>`;
      });
    }
    const wells = {}, spare = spareIds(), vis = [];
    MAPD.all.forEach(n => { if (n.w && M.shows(n, spare)) (wells[n.w] = wells[n.w] || []).push(n); });
    Object.values(wells).forEach(list => {
      const cx = list.reduce((s, n) => s + n.x, 0) / list.length, cy = list.reduce((s, n) => s + n.y, 0) / list.length;
      const rad = Math.max(...list.map(n => Math.hypot(n.x - cx, n.y - cy))) * M.view.scale + 10;
      g += `<circle class="mp-well" cx="${sx(cx)}" cy="${sy(cy)}" r="${rad}"/>`;
      if (lv === 2) labels += `<text class="mp-lbl" x="${sx(cx)}" y="${sy(cy) - rad - 5}" text-anchor="middle">${M.only || M.filter.size > 1 ? shortOf(list[0].r) + ' ' : ''}well ×${list.length}</text>`;
    });
    const order = { impure: 0, normal: 1, pure: 2 };
    const placed = [];
    [...MAPD.all].filter(n => M.shows(n, spare)).sort((a, b) => order[a.p] - order[b.p]).forEach(n => {
      const x = sx(n.x), y = sy(n.y);
      if (x < -40 || y < -40 || x > w + 40 || y > h + 40) return;
      if (x >= 0 && y >= 0 && x <= w && y <= h) vis.push(n.id);
      const r = SIZE[lv][n.p] * (n.w ? 0.8 : 1);
      const taken = M.taken?.[n.id], picked = M.picked?.has(n.id), own = M.owner?.[n.id];
      // the leftover ring outside the node, so a taken (faded) node's still shows
      if (spare.has(n.id)) g += `<circle cx="${x}" cy="${y}" r="${r + 5.5}" class="mp-spare-r"/>`;
      g += `<g data-id="${n.id}" class="mp-n ${taken ? 'taken' : ''} ${picked ? 'on' : ''}">
        ${MAPD.save.has(n.id) ? `<circle cx="${x}" cy="${y}" r="${r + 3.5}" class="mp-save"/>` : ''}
        ${own ? `<circle cx="${x}" cy="${y}" r="${r + 2}" fill="none" stroke="${M.ownerColor(own)}" stroke-width="2.5"/>` : ''}
        ${M.grid?.has(n.id) ? `<circle cx="${x}" cy="${y}" r="${r + 6}" class="mp-grid-g"/>` : ''}
        <circle cx="${x}" cy="${y}" r="${r}" fill="${COLORS[n.r]}" fill-opacity="${lv ? 1 : { impure: 0.55, normal: 0.8, pure: 1 }[n.p]}"/>
        ${lv && !M.grid?.has(n.id) ? `<text x="${x}" y="${y + r * 0.42}" class="mp-pur ${DARK.has(n.r) ? 'lt' : ''}" style="font-size:${(r * 1.15).toFixed(1)}px">${LETTER[n.p]}</text>` : ''}
        ${M.grid?.has(n.id) ? `<text x="${x}" y="${y + 3.5}" class="mp-bolt">⚡</text>` : ''}
        ${taken ? `<path d="M${x - r} ${y - r}L${x + r} ${y + r}M${x + r} ${y - r}L${x - r} ${y + r}" class="mp-x"/>` : ''}</g>`;
      if (lv === 2 && !n.w) {
        let who = taken || (own ? M.ownerName(own) : M.grid?.has(n.id) ? '⚡ grid' : MAPD.save.has(n.id) ? 'in save' : '');
        // whose it is, once per cluster: not again for a node of the same one close by
        if (who && placed.some(q => q.who === who && Math.hypot(q.x - x, q.y - y) < 70)) who = '';
        else if (who) placed.push({ who, x, y });
        const what = [M.only || M.filter.size > 1 ? shortOf(n.r) : '', n.r === 'Geyser' ? `${GEO_MW[n.p]} MW` : ''].filter(Boolean).join(' ');
        if (what) labels += `<text class="mp-lbl" x="${x + r + 3}" y="${y - (who ? 1 : -3.5)}">${what}</text>`;
        if (who) labels += `<text class="mp-lbl sub" x="${x + r + 3}" y="${what ? y + 10 : y + 3.5}">${who}</text>`;
      }
    });
    (M.pins || []).forEach((p, i) => {
      const x = sx(p.x), y = sy(p.y), c = p.color || COLORS.Water;
      g += `<g data-pin="${i}" class="mp-pin"><rect x="${x - 7}" y="${y - 7}" width="14" height="14" rx="3" fill="${c}" stroke="${p.mine === false ? 'none' : '#fff'}" stroke-width="1.5"/>
        <text x="${x}" y="${y + 3.5}" text-anchor="middle">${p.count}</text></g>`;
      if (lv === 2 && p.label) labels += `<text class="mp-lbl" x="${x + 10}" y="${y + 3.5}">${p.label}</text>`;
    });
    svg.innerHTML = g + labels + spareTags(lv);
    el.querySelector('.mp-level').textContent = M.only === 'spare' && !lv ? 'Zoom in for how much each leaves'
      : ['Zoom in or pick one resource for purity', 'Zoom in more for names and owners', ''][lv];
    M.visible = vis;
    M.afterDraw?.();
  }

  // One redraw a frame, however many wheel or drag events come in
  let queued = false;
  const soon = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); } };
  const zoomAt = (k, px = el.clientWidth / 2, py = el.clientHeight / 2, now = true) => {
    const v = M.view, ns = Math.min(Math.max(v.scale * k, (M.fitScale || 0.05) * 0.6), 3);
    v.ox = px - (px - v.ox) * ns / v.scale; v.oy = py - (py - v.oy) * ns / v.scale; v.scale = ns;
    now ? draw() : soon();
  };
  // The wheel zooms where the pointer is: a notch is a quarter, whatever the
  // mouse reports (pixels, lines or pages); a touchpad's small steps add up
  el.addEventListener('wheel', e => {
    e.preventDefault();
    if (!M.view) return;
    const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
    const r = el.getBoundingClientRect();
    zoomAt(Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.0023), e.clientX - r.left, e.clientY - r.top, false);
  }, { passive: false, ...on });
  el.addEventListener('dblclick', e => {
    if (e.target.closest('[data-id],[data-pin],[data-spare],.mp-zoom')) return;
    const r = el.getBoundingClientRect();
    zoomAt(e.shiftKey ? 0.5 : 2, e.clientX - r.left, e.clientY - r.top);
  }, on);
  el.querySelector('.mp-zoom').addEventListener('click', e => {
    const z = e.target.closest('[data-z]')?.dataset.z;
    if (z === 'in') zoomAt(1.6); else if (z === 'out') zoomAt(1 / 1.6); else if (z === 'fit') { M.view = null; draw(); }
  }, on);
  el.querySelector('.mp-zoom').addEventListener('mousedown', e => e.stopPropagation(), on);
  // Keys while this map is on screen: + − zoom, 0 the whole map, arrows pan
  window.addEventListener('keydown', e => {
    if (!el.isConnected || !el.offsetParent || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    if (document.querySelector('#nav-pal.show, #nav-help.show')) return;
    const pan = 120, k = e.key;
    if (k === '+' || k === '=') zoomAt(1.4);
    else if (k === '-' || k === '_') zoomAt(1 / 1.4);
    else if (k === '0') { M.view = null; draw(); }
    else if (k === 'ArrowLeft') { M.view.ox += pan; draw(); }
    else if (k === 'ArrowRight') { M.view.ox -= pan; draw(); }
    else if (k === 'ArrowUp') { M.view.oy += pan; draw(); }
    else if (k === 'ArrowDown') { M.view.oy -= pan; draw(); }
    else return;
    e.preventDefault();
  }, on);
  // Picking nodes: drag a box and everything shown inside it is picked (Shift:
  // taken out instead); a click picks one. The map pans with the right or
  // middle button, Space + drag, the arrows — or, where nothing is picked
  // (the Blackboard's map), any drag.
  let space = false;
  window.addEventListener('keydown', e => { if (e.code === 'Space' && el.isConnected && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) space = true; });
  window.addEventListener('keyup', e => { if (e.code === 'Space') space = false; });
  el.addEventListener('contextmenu', e => { if (M.onBox) e.preventDefault(); }, on);
  el.addEventListener('mousedown', e => {
    if (e.button > 2) return;
    const panning = !M.onBox || e.button !== 0 || space;
    if (e.button === 0 && !M.onBox && e.target.closest('[data-id],[data-pin],[data-spare]')) return;   // clicks handled on click
    e.preventDefault();
    const r = el.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    const v0 = { ...M.view }, box = !panning;
    let rect = null, moved = false;
    const move = ev => {
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      moved = moved || Math.hypot(x - x0, y - y0) > 4;
      if (!moved) return;
      if (box) {
        if (!rect) {
          rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('class', `mp-sel${e.shiftKey ? ' out' : ''}`);
          svg.appendChild(rect);
        }
        rect.setAttribute('x', Math.min(x0, x)); rect.setAttribute('y', Math.min(y0, y));
        rect.setAttribute('width', Math.abs(x - x0)); rect.setAttribute('height', Math.abs(y - y0));
      } else { M.view.ox = v0.ox + x - x0; M.view.oy = v0.oy + y - y0; soon(); }
    };
    const up = ev => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      if (box && moved) {
        const [ax, bx, ay, by] = [Math.min(x0, x), Math.max(x0, x), Math.min(y0, y), Math.max(y0, y)];
        M.onBox(MAPD.all.filter(n => M.shows(n) && !M.taken?.[n.id]
          && sx(n.x) >= ax && sx(n.x) <= bx && sy(n.y) >= ay && sy(n.y) <= by).map(n => n.id), e.shiftKey);
        rect?.remove();
        M.boxed = true;            // the click that follows isn't a pick
      } else if (!moved && e.button === 0 && M.onPin && !e.target.closest('[data-id],[data-pin],[data-spare]'))
        M.onPin(Math.round(wx(x)), Math.round(wy(y)));      // a water extractor, where clicked (when placing them)
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, on);
  el.addEventListener('click', e => {
    if (M.boxed) { M.boxed = false; return; }
    if (e.shiftKey && M.onBox) return;
    const tag = e.target.closest('[data-spare]');
    if (tag) { M.onSpare?.(+tag.dataset.spare); return; }
    const hub = e.target.closest('[data-hub]');
    if (hub) { M.onHub?.(hub.dataset.hub); return; }
    const pin = e.target.closest('[data-pin]');
    if (pin && M.onPinClick) { M.onPinClick(+pin.dataset.pin); return; }
    const hit = e.target.closest('[data-id]');
    if (hit && M.onClick && !M.taken?.[hit.dataset.id]) M.onClick(hit.dataset.id);
  }, on);
  el.addEventListener('mousemove', e => {
    const hit = e.target.closest('[data-id]'), pin = e.target.closest('[data-pin]'), tag = e.target.closest('[data-spare]');
    const way = e.target.closest('[data-rt]');
    if (!hit && !pin && !tag && !way) { tip.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    if (way) {           // a path: what rides this stretch — who loads it, for whom
      const [pi, k] = way.dataset.rt.split(':').map(Number), p = M.network.paths[pi];
      const segs = k < 0 ? p.segs : [p.segs[k]];
      tip.innerHTML = `<b>${p.icon} ${p.what} · ${p.name}</b><br><span>${p.run}${p.vehicles ? ` · ${p.vehicles}` : ''}</span>`
        + segs.map(sg => `<div class="mp-tip-s">${segs.length > 1 || p.segs.length > 1 ? `<b>${sg.an} — ${sg.bn}</b><br>` : ''}${sg.lines.length
          ? sg.lines.join('<br>') : '<span>Nothing on it yet</span>'}</div>`).join('');
    } else if (tag) {
      const sp = M.spare[+tag.dataset.spare];
      tip.innerHTML = `<b>${sp.name}</b> leaves ${fmtM(sp.left)}/min of ${resName(sp.item)} unused${sp.stale ? '<br><span class="n-warn">its plan is out of date</span>' : ''}
        ${M.onSpare ? `<br><span>${sp.bring > 0 ? 'Click to leave it there' : 'Click to bring it here — as an import'}</span>` : ''}`;
    } else if (pin) {
      const p = M.pins[+pin.dataset.pin];
      tip.innerHTML = `<b>${p.count} water extractor${p.count > 1 ? 's' : ''}</b>${p.label ? `<br><span>${p.label}</span>` : ''}`;
    } else {
      const n = MAPD.by[hit.dataset.id];
      tip.innerHTML = `<b>${resName(n.r)}</b> · ${n.p}${n.w ? ' · well satellite' : ''}${n.r === 'Geyser' ? ` · ~${GEO_MW[n.p]} MW` : ''}<br>
        <span>${fmtM(n.x)}, ${fmtM(n.y)} m</span>${MAPD.save.has(n.id) ? '<br><span class="mp-save-t">mined in your save</span>' : ''}
        ${M.taken?.[n.id] ? `<br><span class="n-warn">mined by ${M.taken[n.id]}</span>` : ''}
        ${(M.spare || []).filter(sp => sp.item === n.r && sp.ids.includes(n.id) && sp.left > 0.05)
          .map(sp => `<br><span class="mp-spare-t">${fmtM(sp.left)}/min of it unused there</span>`).join('')}
        ${M.owner?.[n.id] ? `<br><span>${M.ownerName(M.owner[n.id])}</span>` : ''}
        ${M.grid?.has(n.id) ? '<br><span class="mp-save-t">⚡ geothermal generator on the grid</span>' : ''}`;
    }
    tip.style.display = 'block';
    tip.style.left = (e.clientX - r.left + 12) + 'px';
    tip.style.top = (e.clientY - r.top + 12) + 'px';
  }, on);
  // the game's map arrives in the background the first time
  document.addEventListener('map-picture', () => draw(), on);
  // Fit the view to points (m), at least `min` metres across, with a margin
  const fitTo = (pts, min = 900) => {
    M.fitReq = pts; M.touched = false;     // refit as the map settles in size, until it's moved
    if (!pts.length) { M.view = null; draw(); return; }
    if (!M.view) fit();
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const bw = Math.max(min, Math.max(...xs) - Math.min(...xs)) * 1.35, bh = Math.max(min, Math.max(...ys) - Math.min(...ys)) * 1.35;
    const w = el.clientWidth, h = el.clientHeight;
    const scale = Math.min(3, Math.max(M.fitScale, Math.min(w / bw, h / bh)));
    M.view = { scale, ox: w / 2 - cx * scale, oy: h / 2 - cy * scale };
    draw();
  };
  new ResizeObserver(() => { if (M.fitReq && !M.touched && el.clientWidth) fitTo(M.fitReq); }).observe(el);
  ['wheel', 'mousedown', 'dblclick'].forEach(t => el.addEventListener(t, () => { M.touched = true; }, on));
  window.addEventListener('keydown', () => { if (el.offsetParent) M.touched = true; }, on);
  return { draw, fitTo, refit: () => { M.view = null; draw(); } };
}

// Filter chips for a map: the resources, All — and two views across every
// resource: Leftover (what factories' nodes give that their plans don't use)
// and In your save (mined in the game, in no factory yet). In the picker, the
// save's view can add what's on screen at once.
function chips(el, M, redraw, kinds = Object.keys(COLORS)) {
  const draw = () => {
    const nSpare = new Set((M.spare || []).filter(sp => sp.left > 0.05).flatMap(sp => sp.ids)).size;
    const nSave = MAPD.all.filter(n => MAPD.save.has(n.id) && !M.taken?.[n.id] && !M.owner?.[n.id]).length;
    el.innerHTML = kinds.map(r =>
      `<button class="mp-f ${!M.only && M.filter.has(r) ? 'on' : ''}" data-r="${r}"><i style="background:${COLORS[r]}"></i>${resName(r)}</button>`).join('')
      + '<button class="mp-f" data-r="*" title="Shift- or Ctrl-click a resource to add it">All</button>'
      + `<span class="mp-f-sep"></span>
      <button class="mp-f ${M.only === 'spare' ? 'on' : ''}" data-only="spare" ${nSpare ? '' : 'disabled'}
        title="${nSpare ? 'Every node a factory has that its plan leaves some of unused' : 'No factory leaves any of its nodes unused'}"><i class="ring sp"></i>Leftover${nSpare ? ` ${nSpare}` : ''}</button>
      <button class="mp-f ${M.only === 'save' ? 'on' : ''}" data-only="save" ${nSave ? '' : 'disabled'}
        title="${nSave ? 'Every node your save mines that no factory here has yet' : MAPD.save.size ? 'Every node your save mines is in a factory' : 'Load a save to see what you already mine'}"><i class="ring sv"></i>In your save${nSave ? ` ${nSave}` : ''}</button>
      ${M.only === 'save' && M.onBox ? '<button class="bsm act mp-addview" title="Add the save\'s nodes on screen to this factory — zoom or pan to choose; drag a box for fewer"></button>' : ''}`;
    el.querySelectorAll('.mp-f').forEach(b => b.addEventListener('click', e => {
      const r = b.dataset.r, only = b.dataset.only;
      if (only) M.only = M.only === only ? null : only;
      else {
        M.only = null;
        if (r === '*') M.filter = new Set(kinds);
        else if (e.shiftKey || e.ctrlKey || e.metaKey) M.filter.has(r) ? M.filter.delete(r) : M.filter.add(r);
        else M.filter = new Set([r]);
      }
      draw(); redraw();
      // a view of its own: the map fits what's in it
      if (only && M.only && M.map) M.map.fitTo(MAPD.all.filter(n => M.shows(n)).map(n => [n.x, n.y]), 400);
    }));
    el.querySelector('.mp-addview')?.addEventListener('click', () => {
      const ids = (M.visible || []).filter(id => !M.picked?.has(id));
      if (ids.length) M.onBox(ids);
    });
  };
  // the add button follows the map: what's on screen and not picked yet
  M.afterDraw = () => {
    const b = el.querySelector('.mp-addview');
    if (!b) return;
    const n = (M.visible || []).filter(id => !M.picked?.has(id)).length;
    b.textContent = n ? `+ Add the ${n} on screen` : 'All on screen added';
    b.disabled = !n;
  };
  el._chips = draw;
  draw();
}

// Save and map-picture tools, shared by both maps
function tools(el, redraw) {
  el._redo = () => { tools(el, redraw); redraw(); };
  const own = MAPD.img?.source === 'own';
  const pic = own ? '' : MAPD.img?.source === 'game' ? '<span class="mp-hint">The game\'s map</span>'
    : MAPD.img?.game === 'downloading' ? '<span class="mp-hint">Fetching the game\'s map…</span>'
    : MAPD.img?.game === 'failed' ? `<span class="mp-hint n-warn" title="${(MAPD.img.game_error || '').replace(/"/g, '&quot;')}">Couldn't fetch the game's map</span> <button class="bsm" id="mp-game-retry">Try again</button>` : '';
  el.innerHTML = `
    <label class="bsm" title="Read a .sav to mark the nodes your game already mines">📂 Load save<input type="file" accept=".sav" hidden></label>
    <span class="mp-hint mp-save-info">${MAPD.saveInfo ? `${MAPD.save.size} nodes mined in ${MAPD.saveInfo.file || 'your save'}` : ''}</span>
    <span class="mp-unl"></span>
    ${pic}
    <label class="bsm" title="Your own picture of the whole in-game map, instead of the game's">🖼 ${own ? 'Another picture' : 'My own picture'}<input type="file" accept="image/png,image/jpeg,image/webp" hidden></label>
    ${own ? '<button class="bsm" id="mp-game-use" title="Drop your picture and draw the game\'s map">Use the game map</button>' : ''}
    ${MAPD.img?.ext ? `<span class="mp-align">${own ? `nudge <button class="bsm" data-a="left">←</button><button class="bsm" data-a="right">→</button>
      <button class="bsm" data-a="up">↑</button><button class="bsm" data-a="down">↓</button>
      <button class="bsm" data-a="in">+</button><button class="bsm" data-a="out">−</button>
      <button class="bsm" data-a="reset" title="Back to the map's edges">reset</button>` : ''}<button class="bsm" data-a="fade" title="Fade the picture">Fade</button></span>` : ''}`;
  if (el._keep) el.prepend(el._keep);   // a button of the map's own (the Blackboard's ⚡ Geothermal)
  el.querySelector('#mp-game-retry')?.addEventListener('click', () =>
    fetch('/api/map-game', { method: 'POST' }).then(r => r.json()).then(ms => { MAPD.img = ms; waitForPicture(); el._redo(); }));
  el.querySelector('#mp-game-use')?.addEventListener('click', () =>
    fetch('/api/map-image', { method: 'DELETE' }).then(r => r.json()).then(ms => { MAPD.img = { ...ms, v: Date.now() }; waitForPicture(); el._redo(); }));
  const [saveIn, imgIn] = el.querySelectorAll('input[type=file]');
  saveIn.addEventListener('change', () => {
    const f = saveIn.files[0];
    if (!f) return;
    el.querySelector('.mp-save-info').textContent = 'Reading the save…';
    uploadSave(f).then(d => {
      MAPD.save = new Set(d.nodes); MAPD.saveInfo = d;
      el.querySelector('.mp-save-info').textContent = `${MAPD.save.size} nodes mined in ${d.file}`;
      document.querySelectorAll('.mp-filters').forEach(f => f._chips?.());
      const u = el.querySelector('.mp-unl');
      u.innerHTML = changesHTML(d);
      wireChanges(u, () => { u.innerHTML = '<span class="mp-hint">Unlocks now match the save.</span>'; });
      redraw();
    }).catch(e => { el.querySelector('.mp-save-info').textContent = `Couldn't read it: ${e.message}`; });
  });
  imgIn.addEventListener('change', () => {
    const f = imgIn.files[0];
    if (!f) return;
    fetch('/api/map-image', { method: 'POST', headers: { 'Content-Type': f.type }, body: f })
      .then(r => r.json()).then(d => { if (!d.error) { MAPD.img = { ...d, v: Date.now() }; tools(el, redraw); redraw(); } });
  });
  el.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => {
    const step = 20 / MAPD.img.scale, a = b.dataset.a;
    const ch = { left: { dx: MAPD.img.dx - step }, right: { dx: MAPD.img.dx + step }, up: { dy: MAPD.img.dy - step }, down: { dy: MAPD.img.dy + step },
      in: { scale: MAPD.img.scale * 1.005 }, out: { scale: MAPD.img.scale / 1.005 }, fade: { opacity: MAPD.img.opacity >= 0.95 ? 0.7 : MAPD.img.opacity >= 0.65 ? 0.4 : 1 },
      reset: { dx: 0, dy: 0, scale: 1 } }[a];
    Object.assign(MAPD.img, ch);
    redraw();
    fetch('/api/map-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ch) });
  }));
}

// ══════════════════════════════════════════════════════════
// PICKER — the nodes one factory mines
// ══════════════════════════════════════════════════════════

// A save read anywhere (Unlocks too) marks its nodes on the maps

let S = null;   // the open picker

/** opts: { resource, picked: Set, shards: {id|well: n}, pins: [{x, y, count, shards}],
 *  taken: {id: factory name}, minerRate, onApply(picked, shards, pins) } */
export function openMapPicker(opts) {
  loadMap().then(() => {
    waitForPicture();
    S = { ...opts, picked: new Set(opts.picked), shards: { ...opts.shards }, pins: (opts.pins || []).map(p => ({ ...p })),
          spare: (opts.spare || []).map(sp => ({ ...sp, bring: sp.mine || 0, ids: sp.ids.filter(id => MAPD.by[id]?.r === sp.item) })),
          filter: opts.resource && PICKABLE.includes(opts.resource) ? new Set([opts.resource]) : new Set(PICKABLE),
          pinMode: false };
    let m = $('map-modal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'map-modal';
      m.innerHTML = `
        <div class="mp-box">
          <div class="mp-top">
            <b>Pick nodes</b>
            <span class="mp-hint">Drag a box round a region · Shift+drag takes out · click a node · right-drag or Space+drag pans · scroll zooms</span>
            <button class="bsm" id="mp-pin" title="Click on the map where water extractors go">💧 Place water extractors</button>
            <span style="flex:1"></span>
            <button class="bsm" id="mp-cancel">Cancel</button>
            <button class="bsm act" id="mp-apply">Use these nodes</button>
          </div>
          <div class="mp-filters" id="mp-filters"></div>
          <div class="mp-tools" id="mp-tools"></div>
          <div class="mp-main">
            <div id="mp-map"></div>
            <div class="mp-side">
              <div class="mp-spread">⚡ Spread <input type="number" id="mp-spread-n" min="0" step="1" placeholder="0"/>
                shards <button class="bsm" id="mp-spread">spread</button></div>
              <div id="mp-list"></div>
              <div id="mp-spare"></div>
            </div>
          </div>
        </div>`;
      document.body.appendChild(m);
      $('mp-cancel').addEventListener('click', close);
      $('mp-apply').addEventListener('click', () => {
        S.onApply(S.picked, S.shards, S.pins, S.spare.map(sp => ({ factory: sp.factory, item: sp.item, rate: sp.bring || 0 })));
        close();
      });
      $('mp-spread').addEventListener('click', () => { spread(parseInt($('mp-spread-n').value, 10) || 0); S.map.draw(); renderList(); });
      $('mp-pin').addEventListener('click', () => {
        S.pinMode = !S.pinMode;
        $('mp-pin').classList.toggle('act', S.pinMode);
      });
      m.addEventListener('mousedown', e => { if (e.target === m) close(); });
    }
    m.classList.add('show');
    $('mp-pin').classList.remove('act');
    const M = S;
    M.onClick = id => { M.picked.has(id) ? M.picked.delete(id) : M.picked.add(id); M.map.draw(); renderList(); };
    M.onBox = (ids, remove) => { ids.forEach(id => (remove ? M.picked.delete(id) : M.picked.add(id))); M.map.draw(); renderList(); };
    M.onPin = (x, y) => { if (!M.pinMode) return; M.pins.push({ x, y, count: 1, shards: 0 }); M.map.draw(); renderList(); };
    M.onPinClick = i => { if (M.pinMode) { M.pins.splice(i, 1); M.map.draw(); renderList(); } };
    // a tag on another factory's nodes: bring what it leaves unused here, or leave it
    M.onSpare = i => { const sp = M.spare[i]; sp.bring = sp.bring > 0 ? 0 : sp.left; M.map.draw(); renderList(); };
    M.map = makeMap($('mp-map'), M);
    const redraw = () => { M.map.draw(); renderSpare(); };
    chips($('mp-filters'), M, redraw, PICKABLE);
    tools($('mp-tools'), redraw);
    // A factory with nodes already: open on them, not the whole map
    requestAnimationFrame(() => {
      const pts = [...[...M.picked].map(id => MAPD.by[id]).filter(Boolean).map(n => [n.x, n.y]), ...M.pins.map(p => [p.x, p.y])];
      M.map.fitTo(pts);
      renderList();
    });
  });
}

function close() { $('map-modal')?.classList.remove('show'); S = null; }

// The picked extractors: one per node, one per well, one generator per geyser, the water pins
function units() {
  const out = [], wells = {};
  [...S.picked].map(id => MAPD.by[id]).filter(Boolean).forEach(n => {
    if (n.w) (wells[n.w] = wells[n.w] || { key: n.w, r: n.r, kind: 'well', nodes: [] }).nodes.push(n);
    else out.push({ key: n.id, r: n.r, kind: n.r === 'Geyser' ? 'geo' : 'node', nodes: [n] });
  });
  out.push(...Object.values(wells));
  out.forEach(u => {
    const ex = u.kind === 'well' ? 'Resource_Well' : u.r === 'Crude_Oil' ? 'Oil_Extractor' : 'Miner';
    const base = ex === 'Miner' ? S.minerRate : ex === 'Oil_Extractor' ? 120 : 60;
    u.top = u.kind === 'geo' ? GEO_MW[u.nodes[0].p] : u.nodes.reduce((s, n) => s + base * (PURITY[n.p] ?? 1), 0);
    u.cap = CAP[ex] || null;
    u.rate = s => { if (u.kind === 'geo') return u.top; const r = u.top * (1 + 0.5 * s); return u.cap ? Math.min(u.cap, r) : r; };
  });
  S.pins.forEach((p, i) => out.push({ key: `pin${i}`, r: 'Water', kind: 'pin', pin: p, nodes: [], top: 120 * p.count, cap: 600,
    rate: s => Math.min(600, 120 * (1 + 0.5 * s)) * p.count }));
  return out.sort((a, b) => resName(a.r).localeCompare(resName(b.r)) || b.top - a.top);
}
const shardOf = u => (u.kind === 'pin' ? u.pin.shards || 0 : S.shards[u.key] || 0);
const setShard = (u, v) => { if (u.kind === 'pin') u.pin.shards = v; else S.shards[u.key] = v; };
const cost = u => (u.kind === 'pin' ? u.pin.count : 1);

// Biggest gain per shard first, three per extractor at most (geysers take none)
function spread(budget) {
  const us = units().filter(u => u.kind !== 'geo');
  us.forEach(u => setShard(u, 0));
  let left = budget;
  for (;;) {
    let best = null, gain = 1e-9;
    us.forEach(u => {
      const s = shardOf(u);
      const g = (u.rate(s + 1) - u.rate(s)) / cost(u);
      if (s < MAX_SHARDS && cost(u) <= left && g > gain) { best = u; gain = g; }
    });
    if (!best) break;
    setShard(best, shardOf(best) + 1); left -= cost(best);
  }
}

// Where this factory is: the middle of the nodes and pins it has picked
function here() {
  const pts = [...[...S.picked].map(id => MAPD.by[id]).filter(Boolean).map(n => [n.x, n.y]), ...S.pins.map(p => [p.x, p.y])];
  return pts.length ? [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length] : null;
}

// What other factories' nodes give that their plans don't use: bring some here
function renderSpare() {
  const el = $('mp-spare');
  const list = S.spare.filter(sp => sp.left > 0.05 || sp.bring > 0);
  if (!list.length) { el.innerHTML = ''; return; }
  const at = here();
  const dist = sp => {
    const ns = sp.ids.map(id => MAPD.by[id]).filter(Boolean);
    if (!at || !ns.length) return null;
    return Math.hypot(ns.reduce((a, n) => a + n.x, 0) / ns.length - at[0], ns.reduce((a, n) => a + n.y, 0) / ns.length - at[1]);
  };
  const rows = list.map((sp, k) => ({ sp, i: S.spare.indexOf(sp), d: dist(sp) }))
    .sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9) || b.sp.left - a.sp.left);
  el.innerHTML = `<div class="n-sent-t">Unused nearby</div>
    <p class="n-hint">What other factories' nodes give that their plans don't use. Bring some here as an import; what you leave stays theirs.</p>`
    + rows.map(({ sp, i, d }) => `<div class="mp-u mp-su ${S.filter.has(sp.item) ? '' : 'dim'}" data-s="${i}">
        <i style="background:${COLORS[sp.item] || '#888'}"></i>
        <span>${resName(sp.item)} · ${sp.name}<br><span class="n-hint">${fmtM(sp.left)}/min unused${d != null ? ` · ${d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m'} away` : ''}${sp.stale ? ' · its plan is out of date' : ''}</span></span>
        <input type="number" class="mp-bring" min="0" max="${sp.left}" step="any" value="${sp.bring > 0 ? +sp.bring.toFixed(3) : ''}" placeholder="0" title="How much to bring here, per minute"/>
        <button class="bsm ${sp.bring > 0 ? 'act' : ''}" title="${sp.bring > 0 ? 'Leave it there' : 'Bring all of it'}">${sp.bring > 0 ? '✓' : 'all'}</button></div>`).join('');
  el.querySelectorAll('.mp-su').forEach(row => {
    const sp = S.spare[+row.dataset.s];
    const inp = row.querySelector('.mp-bring');
    inp.addEventListener('change', () => { sp.bring = Math.min(sp.left, Math.max(0, parseFloat(inp.value) || 0)); S.map.draw(); renderSpare(); });
    row.querySelector('button').addEventListener('click', () => { sp.bring = sp.bring > 0 ? 0 : sp.left; S.map.draw(); renderSpare(); });
    row.addEventListener('mouseenter', () => sp.ids.forEach(id => $('mp-map').querySelector(`[data-id="${id}"]`)?.classList.add('hl')));
    row.addEventListener('mouseleave', () => $('mp-map').querySelectorAll('.hl').forEach(x => x.classList.remove('hl')));
  });
}

function renderList() {
  renderSpare();
  const us = units(), el = $('mp-list');
  if (!us.length) { el.innerHTML = '<p class="n-hint">No nodes picked yet.</p>'; return; }
  const tot = {};
  us.forEach(u => { tot[u.r] = (tot[u.r] || 0) + u.rate(shardOf(u)); });
  const shards = us.reduce((s, u) => s + shardOf(u) * cost(u), 0);
  el.innerHTML = `<div class="mp-tot">${Object.entries(tot).map(([r, v]) =>
      `<div><i style="background:${COLORS[r]}"></i>${resName(r)} <b>${fmtM(v)}${r === 'Geyser' ? ' MW' : '/min'}</b></div>`).join('')}
      <div class="n-hint">${us.length} extractor${us.length > 1 ? 's' : ''} · ⚡${shards} shards</div></div>`
    + us.map(u => `<div class="mp-u" data-k="${u.key}">
        <i style="background:${COLORS[u.r]}"></i>
        <span>${resName(u.r)} · ${u.kind === 'well' ? `well, ${u.nodes.length} satellites` : u.kind === 'pin'
          ? `<input type="number" class="mp-cnt" min="1" step="1" value="${u.pin.count}"/> extractors` : u.nodes[0].p}</span>
        ${u.kind === 'geo' ? '<span class="n-hint">avg</span>' : `<select>${[...Array(MAX_SHARDS + 1).keys()].map(k =>
          `<option value="${k}" ${k === shardOf(u) ? 'selected' : ''}>⚡${k}</option>`).join('')}</select>`}
        <b>${fmtM(u.rate(shardOf(u)))}${u.kind === 'geo' ? ' MW' : ''}</b>
        <span class="bi mp-rm" title="Drop">✕</span></div>`).join('');
  el.querySelectorAll('.mp-u').forEach(row => {
    const u = us.find(x => x.key === row.dataset.k);
    row.querySelector('select')?.addEventListener('change', e => { setShard(u, +e.target.value); renderList(); });
    row.querySelector('.mp-cnt')?.addEventListener('change', e => { u.pin.count = Math.max(1, parseInt(e.target.value, 10) || 1); S.map.draw(); renderList(); });
    row.querySelector('.mp-rm').addEventListener('click', () => {
      if (u.kind === 'pin') S.pins.splice(S.pins.indexOf(u.pin), 1);
      else u.nodes.forEach(n => S.picked.delete(n.id));
      S.map.draw(); renderList();
    });
    row.addEventListener('mouseenter', () => u.nodes.forEach(n => $('mp-map').querySelector(`[data-id="${n.id}"]`)?.classList.add('hl')));
    row.addEventListener('mouseleave', () => $('mp-map').querySelectorAll('.hl').forEach(x => x.classList.remove('hl')));
  });
}

// ══════════════════════════════════════════════════════════
// VIEW — the Blackboard's map of every factory's nodes
// ══════════════════════════════════════════════════════════

/** el: the container. owners: {node id: factory key}; factories: [{key, name}];
 *  pins: [{x, y, count, factory}]; grid: geyser ids with the grid's geothermal
 *  generators; onGrid(ids) when they change; onOpen(key). */
export function mountMapView(el, { owners, factories, pins, grid = [], spare = [], network = null, onGrid = () => {}, onOpen }) {
  return loadMap().then(() => {
    waitForPicture();
    const color = {};
    factories.forEach((f, i) => { color[f.key] = FACTORY_COLORS[i % FACTORY_COLORS.length]; });
    const name = k => factories.find(f => f.key === k)?.name || k;
    el.innerHTML = `<div class="mp-tools"></div>
      <div class="mp-main"><div class="mp-view"></div><div class="mp-side mp-legend"></div></div>`;
    const M = { filter: new Set(Object.keys(COLORS)), owner: owners, ownerColor: k => color[k] || '#fff', ownerName: name,
                pins: pins.map(p => ({ ...p, color: color[p.factory], label: name(p.factory), mine: true })),
                grid: new Set(grid), geoMode: false,
                spare: spare.map(sp => ({ ...sp, ids: sp.ids.filter(id => MAPD.by[id]?.r === sp.item) })),
                network: network && { hubs: network.hubs.map(h => ({ ...h, color: color[h.key] || '#fff' })), paths: network.paths },
                onHub: onOpen };
    const setGrid = ids => { M.grid = new Set(ids); onGrid([...M.grid].sort()); redraw(); };
    // In geothermal mode a click on a geyser puts a generator on it (or takes it off)
    M.onClick = id => {
      if (!M.geoMode || MAPD.by[id]?.r !== 'Geyser' || owners[id]) return;
      const g = new Set(M.grid);
      g.has(id) ? g.delete(id) : g.add(id);
      setGrid(g);
    };
    M.map = makeMap(el.querySelector('.mp-view'), M);
    const legend = () => {
      const lg = el.querySelector('.mp-legend');
      if (!lg) return;                      // redrawn meanwhile (a newer render is under way)
      const count = {}, free = {}, inSave = {}, saveIds = [];
      MAPD.all.forEach(n => {
        if (owners[n.id]) { if (M.shows(n)) count[owners[n.id]] = (count[owners[n.id]] || 0) + 1; }
        else if (MAPD.save.has(n.id)) { inSave[n.r] = (inSave[n.r] || 0) + 1; saveIds.push(n.id); }
        else if (!M.grid.has(n.id)) { const f = free[n.r] = free[n.r] || { pure: 0, normal: 0, impure: 0 }; f[n.p]++; }
      });
      const nSpare = new Set(M.spare.filter(sp => sp.left > 0.05).flatMap(sp => sp.ids)).size;
      const on = r => !M.only && M.filter.has(r), allOn = !M.only && Object.keys(COLORS).every(r => M.filter.has(r));
      const mw = [...M.grid].reduce((a, id) => a + (GEO_MW[MAPD.by[id]?.p] || 0), 0);
      // geysers your save already has generators on, not yet on the grid
      const saved = MAPD.all.filter(n => n.r === 'Geyser' && MAPD.save.has(n.id) && !M.grid.has(n.id) && !owners[n.id]).map(n => n.id);
      lg.innerHTML = `
        <div class="n-sent-t">Resources <span class="n-hint">free nodes: pure · normal · impure</span>
          <button class="bsm mp-all ${allOn ? 'act' : ''}" data-r="*" title="Every resource">All</button></div>
        ${Object.keys(COLORS).map(r => { const f = free[r] || { pure: 0, normal: 0, impure: 0 };
          return `<button class="mp-lg mp-res ${on(r) ? 'on' : ''}" data-r="${r}" title="Show only ${resName(r)} — Shift or Ctrl: add it to what's shown">
            <i style="background:${COLORS[r]};border:none"></i>${resName(r)}<b>P ${f.pure} · N ${f.normal} · I ${f.impure}</b></button>`; }).join('')}
        <button class="mp-lg mp-res ${M.only === 'spare' ? 'on' : ''}" data-only="spare" ${nSpare ? '' : 'disabled'}
          title="Every node a factory has that its plan leaves some of unused"><i class="ring sp"></i>Leftover<b>${nSpare}</b></button>
        <div class="n-sent-t" style="margin-top:10px">Power grid</div>
        ${M.grid.size ? `<div class="mp-lg"><i class="geo"></i>Geothermal × ${M.grid.size}<b>${fmtM(mw)} MW</b></div>
          <p class="n-hint">On average — a geyser swings between ½× and 1½×: ${fmtM(mw / 2)}–${fmtM(mw * 1.5)} MW.</p>`
          : '<p class="n-hint">No geothermal generators yet — ⚡ Geothermal, then click geysers.</p>'}
        ${saved.length ? `<button class="bsm" id="mp-geo-save">⚡ Add the ${saved.length} in your save</button>` : ''}
        ${M.spare.some(sp => sp.left > 0.05) ? `<div class="n-sent-t" style="margin-top:10px">Unused at factories</div>
          ${M.spare.filter(sp => sp.left > 0.05).sort((a, b) => b.left - a.left).map(sp => `<div class="mp-lg"><i style="background:${COLORS[sp.item] || '#888'};border:none"></i>
            <span>${resName(sp.item)} · <span class="bb-name" data-key="${sp.factory}" style="font-weight:400">${sp.name}</span></span><b>+${fmtM(sp.left)}</b></div>`).join('')}
          <p class="n-hint">Bring it to a factory nearby: Pick on map there, or import it.</p>` : ''}
        <div class="n-sent-t" style="margin-top:10px">Factories</div>
        ${factories.filter(f => count[f.key]).map(f => `<div class="mp-lg"><i style="border-color:${color[f.key]}"></i>
          <span class="bb-name" data-key="${f.key}" style="font-weight:400">${f.name}</span><b>${count[f.key]}</b></div>`).join('')
          || '<p class="n-hint">No factory has nodes picked yet.</p>'}
        <div class="n-sent-t" style="margin-top:10px">In your save, not in a factory</div>
        ${saveIds.length ? `<button class="mp-lg mp-res ${M.only === 'save' ? 'on' : ''}" data-only="save" title="Show just these: every node your save mines that no factory here has"><i class="ring sv"></i>On the map<b>${saveIds.length}</b></button>
          ${Object.entries(inSave).map(([r, c]) => `<div class="mp-lg sub"><i class="sv"></i>${resName(r)}<b>${c}</b></div>`).join('')}
          <button class="bsm" id="mp-save-forget" title="Unmark these ${saveIds.length} — the nodes your save mines that no factory here has (Load save again to bring them back)">✕ Forget these ${saveIds.length}</button>`
          : `<p class="n-hint">${MAPD.saveInfo ? 'None' : 'Load a save to see what you already mine.'}</p>`}`;
      el.querySelectorAll('.mp-legend .bb-name').forEach(t => t.addEventListener('click', () => onOpen(t.dataset.key)));
      // the resources: click one for just it, Shift or Ctrl to add it; All; or a view of its own
      lg.querySelectorAll('[data-r], [data-only]').forEach(b => b.addEventListener('click', ev => {
        const r = b.dataset.r, only = b.dataset.only;
        if (only) M.only = M.only === only ? null : only;
        else {
          M.only = null;
          if (r === '*') M.filter = new Set(Object.keys(COLORS));
          else if (ev.shiftKey || ev.ctrlKey || ev.metaKey) M.filter.has(r) ? M.filter.delete(r) : M.filter.add(r);
          else M.filter = new Set([r]);
        }
        if (M.geoMode && !(M.filter.size === 1 && M.filter.has('Geyser'))) { M.geoMode = false; geoBtn.classList.remove('act'); }
        redraw();
        if (only && M.only) M.map.fitTo(MAPD.all.filter(n => M.shows(n)).map(n => [n.x, n.y]), 400);
      }));
      lg.querySelector('#mp-save-forget')?.addEventListener('click', () => {
        if (!confirm(`Unmark the ${saveIds.length} nodes your save mines that no factory here has? Load the save again to bring them back.`)) return;
        fetch('/api/save-nodes', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: saveIds }) })
          .then(r => r.json()).then(d => {
            MAPD.save = new Set(d.nodes || []);
            if (M.only === 'save') M.only = null;
            redraw();
          });
      });
      el.querySelector('#mp-geo-save')?.addEventListener('click', () => setGrid([...M.grid, ...saved]));
    };
    function redraw() { M.map.draw(); legend(); }
    // the paths' ways over the ground, worked out a stretch at a time, then drawn
    if (M.network) ground().then(G => {
      if (!G) return;
      const todo = M.network.paths.flatMap(p => p.mode === 'drone' ? [] : p.segs.map(sg => [p.mode, sg]));
      const at = Object.fromEntries(M.network.hubs.map(h => [h.key, h]));
      M.ways = new Map();
      const next = () => {
        const job = todo.shift();
        if (!job) { if (el.isConnected) M.map.draw(); return; }
        const [mode, sg] = job, a = at[sg.a], b = at[sg.b];
        if (a && b) { const w = trace(G, mode, a, b); if (w) M.ways.set(`${mode}|${a.x},${a.y}|${b.x},${b.y}`, w); }
        setTimeout(next, 0);
      };
      next();
    });
    // the grid's geothermal: a mode, so ordinary clicks never place one by accident
    const geoBtn = document.createElement('button');
    Object.assign(geoBtn, { className: 'bsm', id: 'mp-geo', title: 'Click geysers to put geothermal generators on the power grid (G)', textContent: '⚡ Geothermal' });
    el.querySelector('.mp-tools')._keep = geoBtn;
    tools(el.querySelector('.mp-tools'), redraw);
    el._viewOff?.abort();
    el._viewOff = new AbortController();
    window.addEventListener('keydown', e => {   // G: geothermal mode, while this map is on screen
      if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey && !e.altKey && el.offsetParent
          && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) { e.preventDefault(); geoBtn.click(); }
    }, { signal: el._viewOff.signal });
    geoBtn.addEventListener('click', () => {
      M.geoMode = !M.geoMode;
      geoBtn.classList.toggle('act', M.geoMode);
      if (M.geoMode) { M.filter = new Set(['Geyser']); M.only = null; }
      redraw();
    });
    requestAnimationFrame(() => { M.map.refit(); legend(); });
  });
}
