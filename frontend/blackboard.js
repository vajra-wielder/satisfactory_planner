/**
 * blackboard.js — logistics planning, in two parts.
 *
 * Between factories: every saved scenario is a black box showing only what it
 * imports and exports (from its last plan). Drag an export onto another
 * factory's import to link them; each link shows its rate and the belts or
 * pipes it takes at your tiers. Clicking a factory's name opens it.
 *
 * Inside a factory: split one belt into exact shares — a splitter tree with
 * loop-back (splits.js), or a manifold when the outputs only take their share.
 */

import { itemName } from './state.js';
import { exactSplit, lanes, tierFor } from './splits.js';

let DATA = null;          // { factories, fluids, transport }
let LAYOUT = { positions: {}, links: [], belt: 'Mk5', pipe: 'Mk2' };
let FLUIDS = new Set();
let onOpenFactory = () => {};
let saveTimer = null;

const $ = id => document.getElementById(id);
const fmt = v => (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : +v.toFixed(2)).toLocaleString();

export function initBlackboard({ onOpenFactory: open }) {
  onOpenFactory = open;
  $('btn-close-bb').addEventListener('click', closeBlackboard);
  document.querySelectorAll('#bb-tabs button').forEach(b =>
    b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('bb-belt').addEventListener('change', e => { LAYOUT.belt = e.target.value; drawLinks(); renderSplit(); save(); });
  $('bb-pipe').addEventListener('change', e => { LAYOUT.pipe = e.target.value; drawLinks(); save(); });
  $('bb-autolink').addEventListener('click', autoLink);
  $('bb-split-in').addEventListener('input', renderSplit);
  $('bb-split-add').addEventListener('click', () => { addOutputRow(''); renderSplit(); });
  ['', ''].forEach(() => addOutputRow(''));
  window.addEventListener('resize', () => { if (isOpen()) drawLinks(); });
}

const isOpen = () => $('bb-modal').classList.contains('show');

export function openBlackboard() {
  $('bb-modal').classList.add('show');
  fetch('/api/blackboard').then(r => r.json()).then(d => {
    DATA = d;
    FLUIDS = new Set(d.fluids || []);
    LAYOUT = { positions: {}, links: [], belt: 'Mk5', pipe: 'Mk2', ...(d.layout || {}) };
    fillTierSelect('bb-belt', d.transport.belts, LAYOUT.belt);
    fillTierSelect('bb-pipe', d.transport.pipes, LAYOUT.pipe);
    renderFactories();
    renderSplit();
  });
}

export function closeBlackboard() { $('bb-modal').classList.remove('show'); }

function showTab(tab) {
  document.querySelectorAll('#bb-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('bb-factories').style.display = tab === 'factories' ? '' : 'none';
  $('bb-splits').style.display = tab === 'splits' ? '' : 'none';
  if (tab === 'factories') drawLinks();
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

const factory = key => DATA.factories.find(f => f.key === key);
const offered = (f, item) => (f.exports[item] || 0) + (f.surplus[item] || 0);

// Each link carries what its exporter has left, up to what its importer still
// needs, in the order the links were made.
function linkRates() {
  const left = {}, need = {};
  DATA.factories.forEach(f => {
    Object.keys({ ...f.exports, ...f.surplus }).forEach(it => { left[f.key + '|' + it] = offered(f, it); });
    Object.entries(f.imports).forEach(([it, r]) => { need[f.key + '|' + it] = r; });
  });
  return LAYOUT.links.map(l => {
    const a = l.from + '|' + l.item, b = l.to + '|' + l.item;
    const rate = Math.max(0, Math.min(left[a] ?? 0, need[b] ?? 0));
    if (a in left) left[a] -= rate;
    if (b in need) need[b] -= rate;
    return rate;
  });
}

// What a link takes: lanes at your tiers (fluids: pipes, or packaged on belts)
function transport(item, rate) {
  const belts = DATA.transport.belts, pipes = DATA.transport.pipes;
  const bCap = belts[LAYOUT.belt], pCap = pipes[LAYOUT.pipe];
  if (FLUIDS.has(item)) {
    const p = lanes(rate, pCap), b = lanes(rate, bCap);
    return `${p}× ${LAYOUT.pipe} pipe` + (b < p
      ? ` · or ${b}× ${LAYOUT.belt} belt packaged (+${b} back for empties)` : '');
  }
  const n = lanes(rate, bCap);
  return n === 1 ? `1 belt (${tierFor(rate, belts) || LAYOUT.belt} is enough)` : `${n}× ${LAYOUT.belt} belt`;
}

function renderFactories() {
  const board = $('bb-board');
  board.querySelectorAll('.bb-card').forEach(c => c.remove());
  if (!DATA.factories.length) {
    board.insertAdjacentHTML('beforeend',
      '<div class="bb-card" style="left:20px;top:20px">No saved factories yet — save a scenario first.</div>');
    return;
  }
  DATA.factories.forEach((f, i) => {
    const pos = LAYOUT.positions[f.key] || { x: 30 + (i % 4) * 300, y: 30 + Math.floor(i / 4) * 320 };
    const card = document.createElement('div');
    card.className = 'bb-card';
    card.dataset.key = f.key;
    card.style.left = pos.x + 'px';
    card.style.top = pos.y + 'px';
    const row = (it, r, side, cls = '') => `
      <div class="bb-row ${cls}" data-item="${it}" data-side="${side}">
        ${side === 'in' ? `<span class="bb-port in" data-key="${f.key}" data-item="${it}"></span>` : ''}
        <span class="bb-item">${itemName(it)}${FLUIDS.has(it) ? ' 💧' : ''}</span>
        <span class="bb-rate">${r == null ? 'max' : fmt(r) + '/min'}</span>
        ${side !== 'in' ? `<span class="bb-port out" data-key="${f.key}" data-item="${it}"></span>` : ''}
      </div>`;
    const ins = Object.entries(f.imports), outs = Object.entries(f.exports), sur = Object.entries(f.surplus);
    card.innerHTML = `
      <div class="bb-head-row">
        <span class="bb-name" title="Open in the solver">${f.name}</span>
        ${f.solved ? '' : '<span class="bb-tag" title="No current plan — showing the scenario\'s own numbers. Solve it for exact rates.">not solved</span>'}
      </div>
      ${ins.length ? '<div class="bb-sec">In</div>' + ins.map(([it, r]) => row(it, r, 'in')).join('') : ''}
      ${outs.length ? '<div class="bb-sec">Out</div>' + outs.map(([it, r]) => row(it, r, 'out')).join('') : ''}
      ${sur.length ? '<div class="bb-sec">Surplus</div>' + sur.map(([it, r]) => row(it, r, 'out', 'bb-dim')).join('') : ''}
      ${!ins.length && !outs.length && !sur.length ? '<div class="bb-sec">Self-contained</div>' : ''}`;
    card.querySelector('.bb-name').addEventListener('click', () => onOpenFactory(f.key));
    dragCard(card, card.querySelector('.bb-head-row'));
    card.querySelectorAll('.bb-port.out').forEach(p => p.addEventListener('mousedown', e => startLink(e, p)));
    board.appendChild(card);
  });
  drawLinks();
}

function dragCard(card, handle) {
  handle.addEventListener('mousedown', e => {
    if (e.target.classList.contains('bb-name')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = card.offsetLeft, oy = card.offsetTop;
    const move = ev => {
      card.style.left = Math.max(0, ox + ev.clientX - sx) + 'px';
      card.style.top = Math.max(0, oy + ev.clientY - sy) + 'px';
      drawLinks();
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

function portXY(el) {
  const b = $('bb-board').getBoundingClientRect(), r = el.getBoundingClientRect();
  return [r.left + r.width / 2 - b.left + $('bb-board').scrollLeft,
          r.top + r.height / 2 - b.top + $('bb-board').scrollTop];
}

const curve = ([x1, y1], [x2, y2]) => {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
};

function startLink(e, port) {
  e.preventDefault();
  const svg = $('bb-links');
  const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  tmp.setAttribute('class', 'bb-link-tmp');
  svg.appendChild(tmp);
  const from = portXY(port);
  const b = $('bb-board').getBoundingClientRect();
  const move = ev => tmp.setAttribute('d', curve(from,
    [ev.clientX - b.left + $('bb-board').scrollLeft, ev.clientY - b.top + $('bb-board').scrollTop]));
  const up = ev => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    tmp.remove();
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.bb-port.in');
    if (target && target.dataset.item === port.dataset.item && target.dataset.key !== port.dataset.key) {
      const l = { from: port.dataset.key, to: target.dataset.key, item: port.dataset.item };
      if (!LAYOUT.links.some(x => x.from === l.from && x.to === l.to && x.item === l.item)) {
        LAYOUT.links.push(l);
        save();
      }
    }
    drawLinks();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function autoLink() {
  DATA.factories.forEach(f => Object.keys(f.imports).forEach(item => {
    if (LAYOUT.links.some(l => l.to === f.key && l.item === item)) return;
    DATA.factories.filter(g => g.key !== f.key && offered(g, item) > 0)
      .forEach(g => LAYOUT.links.push({ from: g.key, to: f.key, item }));
  }));
  save();
  drawLinks();
}

function drawLinks() {
  if (!DATA || !isOpen()) return;
  const board = $('bb-board'), svg = $('bb-links');
  svg.setAttribute('width', board.scrollWidth);
  svg.setAttribute('height', board.scrollHeight);
  svg.innerHTML = '';
  board.querySelectorAll('.bb-link-label').forEach(x => x.remove());
  // Links whose factories or items are gone are dropped
  LAYOUT.links = LAYOUT.links.filter(l => factory(l.from) && factory(l.to)
    && offered(factory(l.from), l.item) > 0 && l.item in factory(l.to).imports);
  const rates = linkRates();
  const got = {}, sent = {};
  LAYOUT.links.forEach((l, i) => {
    got[l.to + '|' + l.item] = (got[l.to + '|' + l.item] || 0) + rates[i];
    sent[l.from + '|' + l.item] = (sent[l.from + '|' + l.item] || 0) + rates[i];
    const out = board.querySelector(`.bb-card[data-key="${l.from}"] .bb-port.out[data-item="${l.item}"]`);
    const inp = board.querySelector(`.bb-card[data-key="${l.to}"] .bb-port.in[data-item="${l.item}"]`);
    if (!out || !inp) return;
    const a = portXY(out), b = portXY(inp);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', curve(a, b));
    path.setAttribute('class', 'bb-link' + (FLUIDS.has(l.item) ? ' fluid' : ''));
    svg.appendChild(path);
    const lab = document.createElement('div');
    lab.className = 'bb-link-label';
    lab.style.left = (a[0] + b[0]) / 2 + 'px';
    lab.style.top = (a[1] + b[1]) / 2 + 'px';
    lab.innerHTML = `<b>${itemName(l.item)} ${fmt(rates[i])}/min</b><br>${transport(l.item, rates[i])}
      <span class="bb-x" title="Remove this link">✕</span>`;
    lab.querySelector('.bb-x').addEventListener('click', () => {
      LAYOUT.links.splice(i, 1); save(); drawLinks();
    });
    board.appendChild(lab);
  });
  // Imports: covered / short / unlinked; exports: what's shipped
  board.querySelectorAll('.bb-card').forEach(card => {
    const f = factory(card.dataset.key);
    if (!f) return;
    card.querySelectorAll('.bb-row[data-side="in"]').forEach(r => {
      const need = f.imports[r.dataset.item], have = got[f.key + '|' + r.dataset.item] || 0;
      r.classList.toggle('ok', have >= need - 1e-6);
      r.classList.toggle('short', have > 1e-6 && have < need - 1e-6);
      r.title = have >= need - 1e-6 ? 'Fully supplied by links'
        : have > 1e-6 ? `Links bring ${fmt(have)} of ${fmt(need)}/min` : 'Not linked — supplied from elsewhere';
    });
    card.querySelectorAll('.bb-row[data-side="out"]').forEach(r => {
      const s = sent[f.key + '|' + r.dataset.item] || 0;
      r.title = s > 1e-6 ? `${fmt(s)} of ${fmt(offered(f, r.dataset.item))}/min shipped` : '';
    });
  });
}

// ══════════════════════════════════════════════════════════
// INSIDE A FACTORY — exact splits
// ══════════════════════════════════════════════════════════

function addOutputRow(v) {
  const row = document.createElement('div');
  row.className = 'bb-out-row';
  row.innerHTML = `<input type="number" min="0" step="any" placeholder="/min" value="${v}"/>
    <button class="bsm" title="Remove">✕</button>`;
  row.querySelector('input').addEventListener('input', renderSplit);
  row.querySelector('button').addEventListener('click', () => { row.remove(); renderSplit(); });
  $('bb-split-outs').appendChild(row);
}

function renderSplit() {
  const el = $('bb-split-result');
  if (!el || !DATA) return;
  const input = parseFloat($('bb-split-in').value);
  const outs = [...document.querySelectorAll('#bb-split-outs input')]
    .map(i => parseFloat(i.value)).filter(v => v > 0);
  if (!(input > 0) || !outs.length) {
    el.innerHTML = '<p class="bb-hint">Enter the incoming rate and the outputs you want.</p>';
    return;
  }
  const total = outs.reduce((s, v) => s + v, 0);
  if (total > input + 1e-9) {
    el.innerHTML = `<p class="bb-warn">The outputs add up to ${fmt(total)}/min — more than the ${fmt(input)}/min coming in.</p>`;
    return;
  }
  const belts = DATA.transport.belts, cap = belts[LAYOUT.belt];
  const tierNote = r => r > cap + 1e-9
    ? `<span class="bb-warn">over a ${LAYOUT.belt} belt (${cap}/min)</span>`
    : `fits ${tierFor(r, belts) || LAYOUT.belt}`;
  const r = exactSplit(input, outs);
  let h = '';
  if (r) {
    const merges = o => o.pieces.length > 1
      ? `join ${o.pieces.length} branches (${o.pieces.map(p => fmt(p * r.perStream)).join(' + ')}) with ${o.mergers} merger${o.mergers > 1 ? 's' : ''}`
      : `one branch`;
    h += `<div class="bb-design">
      <div class="bb-design-t">Exact split</div>
      <div class="bb-sum">${r.splitters} splitter${r.splitters === 1 ? '' : 's'} · ${r.mergers} merger${r.mergers === 1 ? '' : 's'}
        · every branch a multiple of ${fmt(r.perStream)}/min</div>
      ${r.loopback.streams ? `<p>Merge ${fmt(r.loopback.rate)}/min back into the input first — the belt into the first splitter
        then carries <b>${fmt(r.inputLoad)}/min</b> (${tierNote(r.inputLoad)}).</p>` : ''}
      <ol>${r.steps.map(st => `<li>Split ${st.count > 1 ? `${st.count} branches of` : 'the'} ${fmt(st.rate)}/min
        ${st.ways} ways → ${fmt(st.into)}/min each</li>`).join('')}</ol>
      <ul>${r.outputs.map(o => `<li><b>${fmt(o.rate)}/min</b>${o.rest ? ' (the rest)' : ''}: ${merges(o)}</li>`).join('')}
        ${r.loopback.streams ? `<li><b>${fmt(r.loopback.rate)}/min</b> loops back: ${r.loopback.pieces.length > 1
          ? `join ${r.loopback.pieces.length} branches` : 'one branch'} into the input merger</li>` : ''}</ul>
    </div>`;
  } else {
    h += `<div class="bb-design"><div class="bb-design-t">Exact split</div>
      <p class="bb-hint">These shares need too many streams for a practical balancer — round the rates, or use a manifold.</p></div>`;
  }
  h += `<div class="bb-design">
    <div class="bb-design-t">Manifold</div>
    <p>If each output feeds machines that take only their share, skip the balancing: run the ${fmt(input)}/min belt
      (${tierNote(input)}) past them with one splitter per branch. It backs up until every machine is full, then each
      takes exactly its rate${total < input - 1e-9 ? ` — the last ${fmt(input - total)}/min needs somewhere to go (a sink or an overflow), or the line stalls` : ''}.</p>
  </div>`;
  el.innerHTML = h;
}
