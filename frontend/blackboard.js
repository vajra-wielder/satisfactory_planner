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

import { itemName, RECIPES, PROGRESS } from './state.js';
import { saveProgress, fetchFactoryOutputs } from './api.js';
import { mountMapView, loadMap, mapNode } from './map-picker.js';
import { onChain, chainHTML } from './chain.js';
import { bundle, bandStripes, bandScale, sankeyLayout, itemColor as colorOf } from './bundles.js';
import { recommend, tierFor } from './splits.js';

let DATA = null;          // { factories, fluids, transport }
let LAYOUT = { positions: {}, routes: [], belt: 'Mk5', pipe: 'Mk2' };
let FLUIDS = new Set();
let NET = null;           // last network plan
let FLOW_SRC = 'declared';
const STORE = '@storage';
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
  // Belt and pipe tiers are unlocked once, for every factory
  $('bb-belt').addEventListener('change', e => { LAYOUT.belt = PROGRESS.belt = e.target.value; saveProgress({ belt: PROGRESS.belt }); NET = null; renderSplit(); });
  $('bb-pipe').addEventListener('change', e => { LAYOUT.pipe = PROGRESS.pipe = e.target.value; saveProgress({ pipe: PROGRESS.pipe }); NET = null; });
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
    BUILD = null;
    FLUIDS = new Set(d.fluids || []);
    LAYOUT = { positions: {}, routes: [], geysers: [], ...(d.layout || {}), belt: PROGRESS.belt, pipe: PROGRESS.pipe };
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
    if (TAB !== 'factories' && TAB !== 'splits') showTab(TAB);
  });
}

export function closeBlackboard() { $('bb-modal').classList.remove('show'); }

let TAB = 'factories';
// The Blackboard's tabs, in order — the systems you move between (nav.js)
export const BB_TABS = [['factories', 'Between factories'], ['flows', 'Flows'], ['storage', 'Storage'], ['power', 'Power'],
  ['build', 'Build list'], ['map', 'Map'], ['find', 'Who makes'], ['splits', 'Inside a factory']];
export const blackboardOpen = () => isOpen();
export const blackboardTab = () => TAB;
/** Open the Blackboard on a tab (and, for Who makes, an item). */
export function goBlackboard(tab, item) {
  if (item !== undefined) $('bb-find-q').value = itemName(item);
  showTab(tab);
  if (!isOpen()) openBlackboard();
}
function showTab(tab) {
  TAB = tab;
  document.querySelectorAll('#bb-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  ['factories', 'flows', 'storage', 'power', 'build', 'map', 'find', 'splits'].forEach(t => { $('bb-' + t).style.display = t === tab ? '' : 'none'; });
  if (tab === 'factories') drawRoutes();
  if (tab === 'power') renderPower();
  if (tab === 'build') renderBuild();
  if (tab === 'map') renderMapTab();
  if (tab === 'flows') renderFlows();
  if (tab === 'storage') renderStorage();
  if (tab === 'find') renderFind();
}

function fillTierSelect(id, tiers, chosen) {
  $(id).innerHTML = Object.entries(tiers)
    .map(([t, c]) => `<option value="${t}" ${t === chosen ? 'selected' : ''}>${t} · ${c}/min</option>`).join('');
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
    const pos = LAYOUT.positions[f.key] || { x: 30 + (i % 4) * 400, y: 30 + Math.floor(i / 4) * 360 };   // room for the bands
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

// What a route carries: the network plan's items when it has one, else what
// the factories at its ends import from each other ("From factories")
function routeFlows(rt, i) {
  const plan = NET?.routes?.[i];
  if (plan) return plan.items.map(x => ({ from: x.from, to: x.to, item: x.item, rate: x.rate }));
  const out = [];
  [[rt.a, rt.b], [rt.b, rt.a]].forEach(([src, dst]) => (factory(dst)?.sources || [])
    .forEach(f => { if (f.factory === src && f.rate > 0) out.push({ from: src, to: dst, item: f.item, rate: +f.rate }); }));
  return out;
}

const SVG = 'http://www.w3.org/2000/svg';
const nameOf = k => (k === STORE ? 'Storage' : factory(k)?.name || k);
const flowTitle = f => `${nameOf(f.from)} → ${nameOf(f.to)}: ${itemName(f.item)} ${fmt(f.rate)}/min`;

function drawRoutes() {
  if (!DATA || !isOpen()) return;
  const board = $('bb-board'), svg = $('bb-links');
  svg.setAttribute('width', board.scrollWidth);
  svg.setAttribute('height', board.scrollHeight);
  svg.innerHTML = '';
  board.querySelectorAll('.bb-link-label').forEach(x => x.remove());
  // One band per route, its items side by side; one scale for every band
  const flows = LAYOUT.routes.map((rt, i) => routeFlows(rt, i));
  const scale = bandScale(flows.map(fs => ({ total: fs.reduce((s, f) => s + f.rate, 0) })), 28);
  LAYOUT.routes.forEach((rt, i) => {
    const a = centre(rt.a), b = centre(rt.b);
    if (!a || !b) return;
    const items = bundle(flows[i])[0]?.items || [];
    if (items.length) {
      const g = document.createElementNS(SVG, 'g');
      g.setAttribute('class', 'bb-band');
      const band = bandStripes(a, b, items, scale);
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
    } else {   // a route with nothing on it yet
      const line = document.createElementNS(SVG, 'line');
      line.setAttribute('x1', a[0]); line.setAttribute('y1', a[1]);
      line.setAttribute('x2', b[0]); line.setAttribute('y2', b[1]);
      line.setAttribute('class', 'bb-link');
      svg.appendChild(line);
    }
    const total = items.reduce((s, f) => s + f.rate, 0);
    const lab = document.createElement('div');
    lab.className = 'bb-link-label';
    // just below the band's middle, so the band itself stays in view
    const half = items.length ? bandStripes(a, b, items, scale).width / 2 : 0;
    lab.style.left = (a[0] + b[0]) / 2 + 'px';
    lab.style.top = (a[1] + b[1]) / 2 + half + 6 + 'px';
    const plan = NET?.routes?.[i];
    lab.innerHTML = `
      <select class="bb-mode">${Object.entries(MODES).map(([m, t]) =>
        `<option value="${m}" ${m === rt.mode ? 'selected' : ''}>${t}</option>`).join('')}</select>
      ${rt.mode === 'belt' ? '' : `<input class="bb-trip" type="number" min="0.1" step="0.5" value="${rt.trip_min}"
        title="Round trip, minutes"/> min`}
      <span class="bb-x" title="Remove this route">✕</span>
      ${items.length ? `<div class="bb-route-sum" title="${items.map(flowTitle).join('\n')}">${items.length} item${items.length > 1 ? 's' : ''} · ${fmt(total)}/min</div>` : ''}
      ${plan ? `<div class="bb-route-load">${fmt(plan.load)} ${LOAD_UNIT[rt.mode]}</div>` : ''}`;
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
  h += `<div class="bb-kpi"><b>${fmt(NET.throughput)}/min</b> moving between factories · <b>${fmt(NET.stacks)}</b> stacks/min</div>
    <button class="bsm act" id="bb-apply" style="margin-top:6px" title="Write this plan into the factories, then re-solve them in order">Apply to the factories…</button>
    <div id="bb-chain"></div>`;
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
  $('bb-apply').addEventListener('click', applyNet);
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

const itemColor = it => colorOf(it, FLUIDS.has(it));

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
  const W = Math.max(el.clientWidth - 28, 640);
  const H = Math.max(Math.min(el.clientHeight - 28, 700), 360);
  const L = sankeyLayout(links, { W, H, store: STORE });
  let g = '';
  // One band per pair of factories: its items' stripes side by side, an
  // outline round the lot, and one label for the band
  L.bundles.forEach(b => {
    const a = L.nodes[b.from], c = L.nodes[b.to];
    const x1 = a.x + L.nodeW, x2 = c.x, mx = (x1 + x2) / 2;
    const path = (ya, yb, w) => `M${x1},${ya} C${mx},${ya} ${mx},${yb} ${x2},${yb} L${x2},${yb + w} C${mx},${yb + w} ${mx},${ya + w} ${x1},${ya + w} Z`;
    b.stripes.forEach(st => {
      g += `<path class="sk-link" fill="${itemColor(st.flow.item)}" d="${path(st.y1, st.y2, st.w)}"><title>${flowTitle(st.flow)}</title></path>`;
    });
    g += `<path class="sk-band" d="${path(b.y1, b.y2, b.w)}"/>`;
    if (b.w >= 12) {   // one label, in the middle of the band
      const label = b.items.length === 1 ? `${itemName(b.items[0].item)} ${fmt(b.total)}/min` : `${b.items.length} items · ${fmt(b.total)}/min`;
      g += `<text class="sk-lab" text-anchor="middle" x="${mx}" y="${(b.y1 + b.y2 + b.w) / 2 + 3.5}">${label}</text>`;
    }
  });
  Object.entries(L.nodes).forEach(([n, p]) => {
    const store = n === STORE;
    g += `<rect class="sk-node ${store ? 'store' : ''}" x="${p.x}" y="${p.y}" width="${L.nodeW}" height="${p.h}" rx="3"/>
      <text class="sk-name" data-key="${store ? '' : n}" x="${p.x + L.nodeW + 6}" y="${p.y + 12}">${nameOf(n)}</text>
      <text x="${p.x + L.nodeW + 6}" y="${p.y + 26}">${fmt(p.size)}/min</text>`;
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

// ══════════════════════════════════════════════════════════
// WHO MAKES — an item across every factory
// ══════════════════════════════════════════════════════════

function renderFind() {
  if (!DATA) return;
  const q = $('bb-find-q');
  const all = new Set();
  DATA.factories.forEach(f => [f.exports, f.surplus, f.inside, f.imports].forEach(o => Object.keys(o || {}).forEach(it => all.add(it))));
  $('bb-find-items').innerHTML = [...all].sort().map(it => `<option value="${itemName(it)}">`).join('');
  if (!q.dataset.wired) {
    q.dataset.wired = '1';
    q.addEventListener('input', renderFind);
  }
  const out = $('bb-find-out');
  const want = q.value.trim().toLowerCase().replace(/_/g, ' ');
  if (!want) { out.innerHTML = '<p class="bb-hint">Type an item.</p>'; return; }
  const exact = [...all].filter(it => itemName(it).toLowerCase() === want);
  const items = exact.length ? exact : [...all].filter(it => itemName(it).toLowerCase().includes(want)).sort().slice(0, 12);
  if (!items.length) { out.innerHTML = '<p class="bb-hint">No factory makes or takes that.</p>'; return; }
  const unit = it => (FLUIDS.has(it) ? ' m³' : '') + '/min';
  out.innerHTML = items.map(it => {
    const makers = DATA.factories.map(f => {
      const made = it in (f.exports || {}) ? f.exports[it] : f.surplus?.[it];   // null: a goal not solved yet
      const by = f.taken_by?.[it] || {};
      const stored = by['@storage'] || 0;
      const others = Object.entries(by).filter(([k]) => k !== '@storage');
      const taken = others.reduce((s, [, r]) => s + r, 0);
      return { f, made, stored, others, left: made == null ? null : made - taken - stored, inside: f.inside?.[it] || 0 };
    }).filter(m => m.made !== undefined || m.inside > 0)
      .sort((a, b) => (b.left ?? -1) - (a.left ?? -1) || (b.made || 0) - (a.made || 0));
    const takers = DATA.factories.filter(f => (f.sources || []).some(s => s.item === it && !factory(s.factory)));
    const free = makers.reduce((s, m) => s + Math.max(0, m.left || 0), 0);
    const nm = k => `<span class="bb-name" data-key="${k}" style="font-weight:400">${factory(k)?.name || k}</span>`;
    const rows = makers.map(m => {
      const sends = m.made !== undefined;
      return `<tr><td>${nm(m.f.key)}${m.f.solved ? '' : ' <span class="bb-hint">(not solved)</span>'}</td>
        <td class="num">${sends ? (m.made == null ? 'max' : fmt(m.made)) : '—'}</td>
        <td class="st-by">${m.others.length ? m.others.map(([k, r]) => `${nm(k)} ${fmt(r)}`).join(' · ') : ''}</td>
        <td class="num">${m.stored ? fmt(m.stored) : ''}</td>
        <td class="num ${m.left != null && m.left < -1e-6 ? 'bb-warn' : m.left > 1e-6 ? 'bb-ok' : ''}">${m.left == null ? '—' : fmt(m.left)}</td>
        <td class="bb-hint">${m.inside > 0 && !sends ? `makes ${fmt(m.inside)} inside and uses it all` : m.inside > (m.made || 0) + 1e-6 ? `${fmt(m.inside)} made, ${fmt(m.inside - (m.made || 0))} used inside` : ''}</td></tr>`;
    }).join('');
    return `<div class="fd-item"><h4>${itemName(it)}${FLUIDS.has(it) ? ' 💧' : ''} <span class="bb-hint" style="font-weight:400">· ${fmt(free)}${unit(it)} free to import</span></h4>
      ${makers.length ? `<table class="st-tab"><tr><th>Factory</th><th style="text-align:right">Sends out</th><th>Taken by</th>
        <th style="text-align:right">Stored</th><th style="text-align:right">Free</th><th></th></tr>${rows}</table>` : '<p class="bb-hint">No saved factory makes it.</p>'}
      ${takers.length ? `<p class="bb-hint">Also brought in from outside the planner by ${takers.map(f => nm(f.key)).join(', ')}.</p>` : ''}</div>`;
  }).join('');
  out.querySelectorAll('.bb-name[data-key]').forEach(t => t.addEventListener('click', () => onOpenFactory(t.dataset.key)));
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
// BUILD LIST — machines and materials to have ready
// ══════════════════════════════════════════════════════════

let BUILD = null, BUILD_PICK = null;
const BUILD_SEEN = new Set();
const machName = m => m.replace(/_/g, ' ').replace(/Mk(\d)/, 'Mk.$1');

function renderBuild() {
  const el = $('bb-build');
  if (!BUILD) {
    el.innerHTML = '<p class="bb-hint">Loading…</p>';
    fetch('/api/build-list').then(r => r.json()).then(d => { BUILD = d.factories; renderBuild(); });
    return;
  }
  // what you've ticked stays ticked; anything new (a factory, the grid) starts ticked
  BUILD_PICK = BUILD_PICK || new Set();
  BUILD.forEach(f => { if (f.solved && !BUILD_SEEN.has(f.key)) BUILD_PICK.add(f.key); BUILD_SEEN.add(f.key); });
  const pick = BUILD.filter(f => BUILD_PICK.has(f.key));
  const sum = field => {
    const out = {};
    pick.forEach(f => Object.entries(f[field] || {}).forEach(([k, v]) => {
      (out[k] = out[k] || { total: 0, by: [] }).total += v;
      out[k].by.push(`${f.name} ${fmt(v)}`);
    }));
    return Object.entries(out).sort((a, b) => b[1].total - a[1].total);
  };
  const machines = [...sum('machines'), ...sum('extractors')];
  const mats = sum('materials');
  const shards = pick.reduce((s, f) => s + f.shards, 0), sloops = pick.reduce((s, f) => s + f.sloops, 0);
  const table = (rows, name) => rows.map(([k, x]) => `<tr><td>${name(k)}</td><td class="num">${fmt(x.total)}</td>
    <td class="st-by">${pick.length > 1 ? x.by.join(' · ') : ''}</td></tr>`).join('');
  el.innerHTML = `
    <div class="bl-pick">${BUILD.map(f => `<label title="${f.solved ? (f.stale ? 'Its last plan — it changed since' : '') : 'Not solved: nothing to count yet'}">
      <input type="checkbox" data-key="${f.key}" ${BUILD_PICK.has(f.key) ? 'checked' : ''} ${f.solved ? '' : 'disabled'}/> ${f.name}${f.stale ? ' <span class="bb-hint">(old plan)</span>' : ''}</label>`).join('')}
      <button class="bsm" id="bl-copy" title="Copy the list as text">Copy</button></div>
    <div class="bl-cols">
      <table class="st-tab"><tr><th>Machines</th><th style="text-align:right">Count</th><th></th></tr>${table(machines, machName)}
        ${shards ? `<tr><td>💎 Power shards</td><td class="num">${shards}</td><td></td></tr>` : ''}
        ${sloops ? `<tr><td>🔮 Somersloops</td><td class="num">${sloops}</td><td></td></tr>` : ''}</table>
      <table class="st-tab"><tr><th>Materials</th><th style="text-align:right">Amount</th><th></th></tr>${table(mats, itemName)}</table>
    </div>
    <p class="bb-hint" style="margin-top:10px">Every machine its plan builds, with its extractors and generators — belts, pipes, splitters, stations and foundations aren't counted.</p>`;
  el.querySelectorAll('.bl-pick input').forEach(c => c.addEventListener('change', () => {
    c.checked ? BUILD_PICK.add(c.dataset.key) : BUILD_PICK.delete(c.dataset.key);
    renderBuild();
  }));
  $('bl-copy').addEventListener('click', () => {
    const lines = [`Build list: ${pick.map(f => f.name).join(', ')}`, '', 'Machines',
      ...machines.map(([k, x]) => `  ${machName(k)}: ${fmt(x.total)}`),
      ...(shards ? [`  Power shards: ${shards}`] : []), ...(sloops ? [`  Somersloops: ${sloops}`] : []),
      '', 'Materials', ...mats.map(([k, x]) => `  ${itemName(k)}: ${fmt(x.total)}`)];
    navigator.clipboard?.writeText(lines.join('\n'));
    $('bl-copy').textContent = 'Copied';
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
    onGrid: ids => { LAYOUT.geysers = ids; BUILD = null; saveNow(); },
  }));
}

// Write the plan into the factories: what each takes from the others becomes
// its imports, the alternates it now runs are switched on; then re-solve them
// in order, so each gets its exact build.
function applyNet() {
  const name = k => factory(k)?.name || k;
  const flows = NET.routes.flatMap(rt => rt.items.map(i => ({ from: i.from, to: i.to, item: i.item, rate: i.rate })));
  const alts = {};
  NET.factories.forEach(f => {
    const a = Object.keys(f.recipes.added).filter(k => RECIPES[k]?.alternate);
    if (a.length) alts[f.key] = a;
  });
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
