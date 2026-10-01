/**
 * blackboard.js — logistics planning, in two parts.
 *
 * Between factories: every saved scenario is a black box showing only what it
 * imports and exports (from its last plan), where its imports come from and
 * how much of its outputs others take ("From factories" in each scenario —
 * those joins are drawn as routes). Join factories with routes — belt,
 * train, truck or drone, each with a trip time — and plan the network: which
 * recipe runs where, what crosses each route and what that takes, what each
 * factory draws, and what the leftovers could still make (network.py).
 * Clicking a factory's name opens it.
 *
 * Inside a factory: split one belt — a manifold where the outputs feed
 * machines, a balancer only where an exact rate is needed (splits.js).
 */

import { itemName, RECIPES } from './state.js';
import { recommend, tierFor } from './splits.js';

let DATA = null;          // { factories, fluids, transport }
let LAYOUT = { positions: {}, routes: [], belt: 'Mk5', pipe: 'Mk2' };
let FLUIDS = new Set();
let NET = null;           // last network plan
let FLOW_SRC = 'declared';
let onOpenFactory = () => {};
let saveTimer = null;

const $ = id => document.getElementById(id);
const fmt = v => (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : +v.toFixed(2)).toLocaleString();
const recipeName = k => (RECIPES[k]?.display || k.replace(/_/g, ' ')).replace(/^Alternate:\s*/, 'Alt: ');
const MODES = { train: 'Train', truck: 'Truck', drone: 'Drone', belt: 'Belt / pipe' };
const LOAD_UNIT = { train: 'cars', truck: 'trucks', drone: 'drones', belt: 'lanes' };

export function initBlackboard({ onOpenFactory: open }) {
  onOpenFactory = open;
  $('btn-close-bb').addEventListener('click', closeBlackboard);
  document.querySelectorAll('#bb-tabs button').forEach(b =>
    b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('bb-belt').addEventListener('change', e => { LAYOUT.belt = e.target.value; renderSplit(); save(); });
  $('bb-pipe').addEventListener('change', e => { LAYOUT.pipe = e.target.value; save(); });
  $('bb-plan').addEventListener('click', planNetwork);
  document.querySelectorAll('#bb-flow-src button').forEach(b => b.addEventListener('click', () => {
    FLOW_SRC = b.dataset.src;
    document.querySelectorAll('#bb-flow-src button').forEach(x => x.classList.toggle('on', x === b));
    renderFlows();
  }));
  $('bb-split-in').addEventListener('input', renderSplit);
  $('bb-split-add').addEventListener('click', () => { addOutputRow('', true); renderSplit(); });
  addOutputRow('', false);
  addOutputRow('', true);
  window.addEventListener('resize', () => { if (isOpen()) drawRoutes(); });
}

const isOpen = () => $('bb-modal').classList.contains('show');

export function openBlackboard() {
  $('bb-modal').classList.add('show');
  fetch('/api/blackboard').then(r => r.json()).then(d => {
    DATA = d;
    FLUIDS = new Set(d.fluids || []);
    LAYOUT = { positions: {}, routes: [], belt: 'Mk5', pipe: 'Mk2', ...(d.layout || {}) };
    LAYOUT.routes = (LAYOUT.routes || []).filter(r => factory(r.a) && factory(r.b));
    // A factory's "From factories" imports join it to where they come from
    let added = false;
    d.factories.forEach(f => (f.sources || []).forEach(src => {
      if (factory(src.factory) && !routeBetween(src.factory, f.key)) {
        LAYOUT.routes.push({ a: src.factory, b: f.key, mode: 'train', trip_min: 4 });
        added = true;
      }
    }));
    if (added) save();
    fillTierSelect('bb-belt', d.transport.belts, LAYOUT.belt);
    fillTierSelect('bb-pipe', d.transport.pipes, LAYOUT.pipe);
    renderFactories();
    renderSplit();
    if (TAB === 'flows') renderFlows();
    if (TAB === 'storage') renderStorage();
  });
}

export function closeBlackboard() { $('bb-modal').classList.remove('show'); }

let TAB = 'factories';
function showTab(tab) {
  TAB = tab;
  document.querySelectorAll('#bb-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  ['factories', 'flows', 'storage', 'splits'].forEach(t => { $('bb-' + t).style.display = t === tab ? '' : 'none'; });
  if (tab === 'factories') drawRoutes();
  if (tab === 'flows') renderFlows();
  if (tab === 'storage') renderStorage();
}

function fillTierSelect(id, tiers, chosen) {
  $(id).innerHTML = Object.entries(tiers)
    .map(([t, c]) => `<option value="${t}" ${t === chosen ? 'selected' : ''}>${t} · ${c}/min</option>`).join('');
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
const routeBetween = (a, b) => LAYOUT.routes.some(r => (r.a === a && r.b === b) || (r.a === b && r.b === a));

function renderFactories() {
  const board = $('bb-board');
  board.querySelectorAll('.bb-card').forEach(c => c.remove());
  if (!DATA.factories.length) {
    board.insertAdjacentHTML('beforeend',
      '<div class="bb-card" style="left:20px;top:20px;padding:10px">No saved factories yet — save a scenario first.</div>');
    return;
  }
  DATA.factories.forEach((f, i) => {
    const pos = LAYOUT.positions[f.key] || { x: 30 + (i % 4) * 300, y: 30 + Math.floor(i / 4) * 320 };
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
        <span class="bb-route-h" title="Drag onto another factory to add a route">⇄</span>
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
    const to = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.bb-card')?.dataset.key;
    if (to && to !== from && !LAYOUT.routes.some(r => (r.a === from && r.b === to) || (r.a === to && r.b === from))) {
      LAYOUT.routes.push({ a: from, b: to, mode: 'train', trip_min: 4 });
      save();
    }
    drawRoutes();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function drawRoutes() {
  if (!DATA || !isOpen()) return;
  const board = $('bb-board'), svg = $('bb-links');
  svg.setAttribute('width', board.scrollWidth);
  svg.setAttribute('height', board.scrollHeight);
  svg.innerHTML = '';
  board.querySelectorAll('.bb-link-label').forEach(x => x.remove());
  LAYOUT.routes.forEach((rt, i) => {
    const a = centre(rt.a), b = centre(rt.b);
    if (!a || !b) return;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', a[0]); line.setAttribute('y1', a[1]);
    line.setAttribute('x2', b[0]); line.setAttribute('y2', b[1]);
    line.setAttribute('class', 'bb-link');
    svg.appendChild(line);
    const lab = document.createElement('div');
    lab.className = 'bb-link-label';
    lab.style.left = (a[0] + b[0]) / 2 + 'px';
    lab.style.top = (a[1] + b[1]) / 2 + 'px';
    const plan = NET?.routes?.[i];
    lab.innerHTML = `
      <select class="bb-mode">${Object.entries(MODES).map(([m, t]) =>
        `<option value="${m}" ${m === rt.mode ? 'selected' : ''}>${t}</option>`).join('')}</select>
      ${rt.mode === 'belt' ? '' : `<input class="bb-trip" type="number" min="0.1" step="0.5" value="${rt.trip_min}"
        title="Round trip, minutes"/> min`}
      <span class="bb-x" title="Remove this route">✕</span>
      ${plan ? `<div class="bb-route-load">${fmt(plan.load)} ${LOAD_UNIT[rt.mode]} · ${fmt(plan.throughput)}/min</div>` : ''}`;
    lab.querySelector('.bb-mode').addEventListener('change', e => { rt.mode = e.target.value; NET = null; save(); drawRoutes(); });
    lab.querySelector('.bb-trip')?.addEventListener('change', e => {
      rt.trip_min = Math.max(0.1, parseFloat(e.target.value) || 4); NET = null; save(); drawRoutes();
    });
    lab.querySelector('.bb-x').addEventListener('click', () => {
      LAYOUT.routes.splice(i, 1); NET = null; save(); drawRoutes(); renderNet();
    });
    board.appendChild(lab);
  });
}

function planNetwork() {
  const panel = $('bb-net');
  if (!LAYOUT.routes.length) {
    panel.style.display = '';
    panel.innerHTML = '<p class="bb-hint">Add a route first: drag a factory\'s ⇄ onto another.</p>';
    return;
  }
  panel.style.display = '';
  panel.innerHTML = '<p class="bb-hint">Planning…</p>';
  fetch('/api/network', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routes: LAYOUT.routes, belt: LAYOUT.belt, pipe: LAYOUT.pipe }),
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
  h += `<div class="bb-kpi"><b>${fmt(NET.throughput)}/min</b> moving between factories · <b>${fmt(NET.stacks)}</b> stacks/min</div>`;
  NET.routes.forEach(rt => {
    h += `<div class="bb-net-s">${name(rt.a)} ⇄ ${name(rt.b)} · ${MODES[rt.mode]}${rt.mode === 'belt' ? '' : `, ${rt.trip_min} min trip`}
      — <b>${fmt(rt.load)} ${LOAD_UNIT[rt.mode]}</b></div>`;
    h += rt.items.length ? '<table class="bb-tab"><tr><th></th><th>/min</th><th>stacks/min</th><th>' + LOAD_UNIT[rt.mode] + '</th></tr>' +
      rt.items.map(i => `<tr><td>${name(i.from)} → ${name(i.to)}: ${itemName(i.item)}</td><td>${fmt(i.rate)}</td>
        <td>${i.stacks == null ? '—' : fmt(i.stacks)}</td><td>${fmt(i.load)}</td></tr>`).join('') + '</table>'
      : '<p class="bb-hint">Nothing needs to cross.</p>';
  });
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
}

// ══════════════════════════════════════════════════════════
// INSIDE A FACTORY — splits
// ══════════════════════════════════════════════════════════

function addOutputRow(v, machines) {
  const row = document.createElement('div');
  row.className = 'bb-out-row';
  row.innerHTML = `<input type="number" min="0" step="any" placeholder="/min" value="${v}"/>
    <label title="Feeds machines that take only their share — no balancing needed">
      <input type="checkbox" ${machines ? 'checked' : ''}/> machines</label>
    <button class="bsm" title="Remove">✕</button>`;
  row.querySelectorAll('input').forEach(i => i.addEventListener('input', renderSplit));
  row.querySelector('button').addEventListener('click', () => { row.remove(); renderSplit(); });
  $('bb-split-outs').appendChild(row);
}

function renderSplit() {
  const el = $('bb-split-result');
  if (!el || !DATA) return;
  const input = parseFloat($('bb-split-in').value);
  const outs = [...document.querySelectorAll('#bb-split-outs .bb-out-row')].map(r => ({
    rate: parseFloat(r.querySelector('input[type=number]').value),
    machines: r.querySelector('input[type=checkbox]').checked,
  })).filter(o => o.rate > 0);
  if (!(input > 0) || !outs.length) {
    el.innerHTML = '<p class="bb-hint">Enter the incoming rate and the outputs. Tick "machines" for outputs that feed machines (they take only their share); leave it off for ones that need an exact rate (a belt to elsewhere, a station, storage).</p>';
    return;
  }
  const total = outs.reduce((s, o) => s + o.rate, 0);
  if (total > input + 1e-9) {
    el.innerHTML = `<p class="bb-warn">The outputs add up to ${fmt(total)}/min — more than the ${fmt(input)}/min coming in.</p>`;
    return;
  }
  const belts = DATA.transport.belts, cap = belts[LAYOUT.belt];
  const tierNote = r => r > cap + 1e-9
    ? `<span class="bb-warn">over a ${LAYOUT.belt} belt (${cap}/min)</span>` : `fits ${tierFor(r, belts) || LAYOUT.belt}`;
  const rec = recommend(input, outs);
  if (!rec) { el.innerHTML = '<p class="bb-warn">No design for these numbers.</p>'; return; }
  let h = `<div class="bb-design"><div class="bb-design-t">Recommended</div>
    <div class="bb-sum">${rec.splitters} splitter${rec.splitters === 1 ? '' : 's'} · ${rec.mergers} merger${rec.mergers === 1 ? '' : 's'}</div><ol>`;
  if (rec.manifold.length) {
    h += `<li><b>Manifold</b> the machine-fed outputs off the ${fmt(input)}/min belt (${tierNote(input)}):
      one splitter per branch (${rec.manifold.map(fmt).join(', ')}/min)${rec.exact || rec.mainLine > 1e-9 ? '' : ', the belt ending in the last'}.
      Each branch backs up and takes only its share.</li>`;
  }
  if (rec.exact) {
    const r = rec.exact;
    h += `<li><b>Balance</b> the ${fmt(rec.mainLine)}/min left on the main line into exact shares:
      ${r.loopback.streams ? `merge ${fmt(r.loopback.rate)}/min back into it first (the belt then carries <b>${fmt(r.inputLoad)}/min</b>, ${tierNote(r.inputLoad)});` : ''}
      <ol>${r.steps.map(st => `<li>split ${st.count > 1 ? `${st.count} branches of` : 'the'} ${fmt(st.rate)}/min ${st.ways} ways → ${fmt(st.into)}/min each</li>`).join('')}</ol>
      <ul>${r.outputs.map(o => `<li><b>${fmt(o.rate)}/min</b>${o.rest ? ' (left over)' : ''}: ${o.pieces.length > 1
        ? `join ${o.pieces.length} branches (${o.pieces.map(p => fmt(p * r.perStream)).join(' + ')}) with ${o.mergers} merger${o.mergers > 1 ? 's' : ''}`
        : 'one branch'}</li>`).join('')}
      ${r.loopback.streams ? `<li><b>${fmt(r.loopback.rate)}/min</b> loops back into the input merger</li>` : ''}</ul></li>`;
  } else if (rec.impractical) {
    h += `<li class="bb-warn">The exact shares need too many streams for a practical balancer — round the rates.</li>`;
  } else if (outs.some(o => !o.machines)) {
    h += `<li>The ${fmt(rec.mainLine)}/min left on the main line is the exact output.</li>`;
  }
  h += `</ol>${rec.notes.map(n => `<p class="bb-hint">${n}</p>`).join('')}</div>`;
  el.innerHTML = h;
}

// ══════════════════════════════════════════════════════════
// FLOWS — a Sankey of what moves between factories
// ══════════════════════════════════════════════════════════

const STORE = '@storage';
const hue = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const itemColor = it => (FLUIDS.has(it) ? `hsl(${200 + hue(it) % 30} 70% 55%)` : `hsl(${hue(it)} 55% 55%)`);

// [{from, to, item, rate}]: each factory's From factories and To storage —
// or what the network plan sends over each route
function flowLinks() {
  const out = [];
  if (FLOW_SRC === 'plan') {
    (NET?.routes || []).forEach(rt => rt.items.forEach(i => out.push({ from: i.from, to: i.to, item: i.item, rate: i.rate })));
    DATA.factories.forEach(f => Object.entries(f.storage || {}).forEach(([it, r]) => r > 0 && out.push({ from: f.key, to: STORE, item: it, rate: r })));
    return out;
  }
  DATA.factories.forEach(f => {
    (f.sources || []).forEach(src => { if (src.rate > 0 && factory(src.factory)) out.push({ from: src.factory, to: f.key, item: src.item, rate: +src.rate }); });
    Object.entries(f.storage || {}).forEach(([it, r]) => r > 0 && out.push({ from: f.key, to: STORE, item: it, rate: r }));
  });
  return out;
}

function renderFlows() {
  const el = $('bb-sankey');
  if (!DATA) return;
  if (FLOW_SRC === 'plan' && !NET?.ok) {
    el.innerHTML = '<p class="bb-hint">Plan the network first (Between factories → Plan network).</p>';
    return;
  }
  const links = flowLinks();
  if (!links.length) {
    el.innerHTML = '<p class="bb-hint">Nothing moves yet — add "From factories" imports or "To storage" in a factory.</p>';
    return;
  }
  // Columns: each factory one right of everything it takes from (cycles stop after a pass per node)
  const keys = [...new Set(links.flatMap(l => [l.from, l.to]))];
  const col = Object.fromEntries(keys.map(k => [k, 0]));
  for (let pass = 0; pass < keys.length; pass++)
    links.forEach(l => { if (l.to !== STORE && col[l.to] < col[l.from] + 1) col[l.to] = col[l.from] + 1; });
  const last = Math.max(0, ...keys.filter(k => k !== STORE).map(k => col[k]));
  if (STORE in col) col[STORE] = last + 1;
  const cols = [];
  keys.forEach(k => (cols[col[k]] = cols[col[k]] || []).push(k));
  const inSum = k => links.filter(l => l.to === k).reduce((s, l) => s + l.rate, 0);
  const outSum = k => links.filter(l => l.from === k).reduce((s, l) => s + l.rate, 0);
  const size = k => Math.max(inSum(k), outSum(k));
  const W = Math.max(el.clientWidth - 28, 220 * cols.length), H = Math.max(Math.min(el.clientHeight - 28, 700), 360);
  const NW = 14, GAP = 26, padL = 8, padR = 150;
  // one scale for every band: the fullest column fits, and no node takes more than ~40% of the height
  const big = Math.max(...keys.map(size));
  const k = Math.min(0.4 * H / big, ...cols.map(c => (H - GAP * (c.length - 1)) / c.reduce((s, n) => s + size(n), 0)));
  const pos = {};
  cols.forEach((c, ci) => {
    let y = 0;
    const x = padL + (cols.length === 1 ? 0 : ci * (W - padL - padR - NW) / (cols.length - 1));
    c.forEach(n => { const h = Math.max(4, size(n) * k); pos[n] = { x, y, h, inY: y, outY: y }; y += h + GAP; });
  });
  let g = '';
  // bands, widest first so the narrow ones stay on top
  [...links].sort((a, b) => pos[a.from].y - pos[b.from].y || pos[a.to].y - pos[b.to].y).forEach(l => {
    const a = pos[l.from], b = pos[l.to], w = Math.max(1, l.rate * k);
    const x1 = a.x + NW, x2 = b.x, y1 = a.outY, y2 = b.inY, mx = (x1 + x2) / 2;
    a.outY += w; b.inY += w;
    const nm = n => (n === STORE ? 'Storage' : factory(n)?.name || n);
    g += `<path class="sk-link" fill="${itemColor(l.item)}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}
      L${x2},${y2 + w} C${mx},${y2 + w} ${mx},${y1 + w} ${x1},${y1 + w} Z"><title>${nm(l.from)} → ${nm(l.to)}: ${itemName(l.item)} ${fmt(l.rate)}/min</title></path>`;
    if (w >= 11) g += `<text class="sk-lab" x="${x1 + 6}" y="${y1 + w / 2 + 3.5}">${itemName(l.item)} ${fmt(l.rate)}/min</text>`;
  });
  keys.forEach(n => {
    const p = pos[n], store = n === STORE;
    g += `<rect class="sk-node ${store ? 'store' : ''}" x="${p.x}" y="${p.y}" width="${NW}" height="${p.h}" rx="3"/>
      <text class="sk-name" data-key="${store ? '' : n}" x="${p.x + NW + 6}" y="${p.y + 12}">${store ? 'Storage' : factory(n)?.name || n}</text>
      <text x="${p.x + NW + 6}" y="${p.y + 26}">${fmt(size(n))}/min</text>`;
  });
  el.innerHTML = `<svg width="${W}" height="${H + 30}">${g}</svg>`;
  el.querySelectorAll('.sk-name[data-key]').forEach(t => {
    if (t.dataset.key) t.addEventListener('click', () => onOpenFactory(t.dataset.key));
  });
}

// ══════════════════════════════════════════════════════════
// STORAGE — what every factory sends to storage, per item
// ══════════════════════════════════════════════════════════

function renderStorage() {
  const el = $('bb-storage');
  if (!DATA) return;
  const items = {};
  DATA.factories.forEach(f => Object.entries(f.storage || {}).forEach(([it, r]) => {
    if (!(r > 0)) return;
    const made = f.exports?.[it] ?? f.surplus?.[it];
    (items[it] = items[it] || { total: 0, by: [] }).total += r;
    items[it].by.push({ key: f.key, name: f.name, rate: r, short: made != null && r > made + 1e-6 ? r - made : 0 });
  }));
  const rows = Object.entries(items).sort((a, b) => b[1].total - a[1].total);
  if (!rows.length) {
    el.innerHTML = '<p class="bb-hint">Nothing is stored yet — add "To storage" in a factory (Resources section).</p>';
    return;
  }
  const max = rows[0][1].total;
  el.innerHTML = `<table class="st-tab"><tr><th>Item</th><th style="text-align:right">Stored /min</th><th style="text-align:right">per hour</th><th>From</th></tr>
    ${rows.map(([it, x]) => `<tr><td>${itemName(it)}${FLUIDS.has(it) ? ' 💧' : ''}<div class="st-bar" style="width:${Math.max(4, 100 * x.total / max)}%"></div></td>
      <td class="num">${fmt(x.total)}</td><td class="num">${fmt(x.total * 60)}</td>
      <td class="st-by">${x.by.map(b => `<span class="bb-name" data-key="${b.key}" style="font-weight:400">${b.name}</span> ${fmt(b.rate)}${
        b.short ? ` <span class="bb-warn">(makes ${fmt(b.rate - b.short)} now)</span>` : ''}`).join(' · ')}</td></tr>`).join('')}
    </table>
    <p class="bb-hint" style="margin-top:10px">Stored items are held out of every factory's "From factories" — solving a factory makes at least what it stores.</p>`;
  el.querySelectorAll('.bb-name[data-key]').forEach(t => t.addEventListener('click', () => onOpenFactory(t.dataset.key)));
}
