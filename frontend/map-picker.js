/**
 * map-picker.js — pick the nodes a factory mines, on the 1.0 world map.
 *
 * Every resource node and resource-well satellite (data/map_nodes.json), by
 * position: bigger and brighter is purer. Click a node to take it, Shift+drag
 * to take every shown node in a box, drag to pan, scroll to zoom. Nodes another
 * factory mines are crossed out and can't be taken. The list on the right sets
 * each extractor's power shards (a well's pressurizer drives all its
 * satellites), or spreads a number of shards where they give the most.
 */

import { itemName, PURITY, MAX_SHARDS } from './state.js';
import { fetchMapNodes } from './api.js';

const $ = id => document.getElementById(id);
const fmt = v => (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : +v.toFixed(1)).toLocaleString();
const COLORS = {
  Iron_Ore: '#9aa6b8', Copper_Ore: '#e07a3f', Limestone: '#d9cfb0', Coal: '#5b5f6b', Caterium_Ore: '#e8c547',
  Raw_Quartz: '#d77bd8', Sulfur: '#d6e04a', Bauxite: '#c8553d', Uranium_Ore: '#6ee06e', SAM: '#9b6cf0',
  Crude_Oil: '#3a3a52', Nitrogen_Gas: '#7fb7d9', Water: '#3fa7f5',
};
const RADIUS = { impure: 4, normal: 6, pure: 8.5 };   // screen px
const CAP = { Miner: 1200, Oil_Extractor: 600 };

let MAP = null, BY = {}, BOUNDS = null;
export const mapNode = id => BY[id];
export function loadMap() {
  if (MAP) return Promise.resolve(MAP);
  return fetchMapNodes().then(d => {
    MAP = d.nodes; BOUNDS = d.bounds;
    BY = Object.fromEntries(MAP.map(n => [n.id, n]));
    return MAP;
  });
}

let S = null;   // the open picker: { picked, shards, taken, filter, view, minerRate, onApply }

export function openMapPicker(opts) {
  loadMap().then(() => {
    S = { ...opts, picked: new Set(opts.picked), shards: { ...opts.shards },
          filter: opts.resource && COLORS[opts.resource] ? new Set([opts.resource]) : new Set(Object.keys(COLORS)) };
    build();
    fitView();
    draw();
  });
}

function build() {
  let m = $('map-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'map-modal';
    m.innerHTML = `
      <div class="mp-box">
        <div class="mp-top">
          <b>Pick nodes</b>
          <span class="mp-hint">Click a node · Shift+drag a box · drag to pan · scroll to zoom</span>
          <span style="flex:1"></span>
          <button class="bsm" id="mp-cancel">Cancel</button>
          <button class="bsm act" id="mp-apply">Use these nodes</button>
        </div>
        <div class="mp-filters" id="mp-filters"></div>
        <div class="mp-main">
          <div class="mp-map" id="mp-map"><svg id="mp-svg"></svg><div class="mp-tip" id="mp-tip"></div></div>
          <div class="mp-side">
            <div class="mp-spread">⚡ Spread <input type="number" id="mp-spread-n" min="0" step="1" placeholder="0"/>
              shards <button class="bsm" id="mp-spread">spread</button></div>
            <div id="mp-list"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(m);
    $('mp-cancel').addEventListener('click', close);
    $('mp-apply').addEventListener('click', () => { S.onApply(S.picked, S.shards); close(); });
    $('mp-spread').addEventListener('click', () => { spread(parseInt($('mp-spread-n').value, 10) || 0); draw(); });
    m.addEventListener('mousedown', e => { if (e.target === m) close(); });
    wireMap();
  }
  m.classList.add('show');
  $('mp-filters').innerHTML = Object.keys(COLORS).map(r =>
    `<button class="mp-f ${S.filter.has(r) ? 'on' : ''}" data-r="${r}"><i style="background:${COLORS[r]}"></i>${itemName(r)}</button>`).join('')
    + '<button class="mp-f" data-r="*">All</button>';
  $('mp-filters').querySelectorAll('.mp-f').forEach(b => b.addEventListener('click', e => {
    const r = b.dataset.r;
    if (r === '*') S.filter = new Set(Object.keys(COLORS));
    else if (e.shiftKey || e.ctrlKey || e.metaKey) S.filter.has(r) ? S.filter.delete(r) : S.filter.add(r);
    else S.filter = new Set([r]);
    $('mp-filters').querySelectorAll('.mp-f').forEach(x => x.classList.toggle('on', S.filter.has(x.dataset.r)));
    draw();
  }));
}

function close() { $('map-modal')?.classList.remove('show'); S = null; }

// ── View: world metres → screen px ────────────────────────
function fitView() {
  const el = $('mp-map'), w = el.clientWidth, h = el.clientHeight;
  const bw = BOUNDS.x[1] - BOUNDS.x[0], bh = BOUNDS.y[1] - BOUNDS.y[0];
  const scale = Math.min(w / bw, h / bh) * 0.96;
  S.view = { scale, ox: (w - bw * scale) / 2 - BOUNDS.x[0] * scale, oy: (h - bh * scale) / 2 - BOUNDS.y[0] * scale };
}
const sx = x => x * S.view.scale + S.view.ox;
const sy = y => y * S.view.scale + S.view.oy;

function wireMap() {
  const el = $('mp-map');
  el.addEventListener('wheel', e => {
    if (!S) return;
    e.preventDefault();
    const r = el.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const k = Math.exp(-e.deltaY * 0.0015), v = S.view;
    const ns = Math.min(Math.max(v.scale * k, 0.02), 3);
    v.ox = px - (px - v.ox) * ns / v.scale; v.oy = py - (py - v.oy) * ns / v.scale; v.scale = ns;
    draw();
  }, { passive: false });
  el.addEventListener('mousedown', e => {
    if (!S || e.button !== 0) return;
    const hit = e.target.closest('[data-id]');
    if (hit && !e.shiftKey) return;           // a click on a node: handled on click
    e.preventDefault();
    const r = el.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    const v0 = { ...S.view }, box = e.shiftKey;
    let rect = null;
    if (box) {
      rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('class', 'mp-sel');
      $('mp-svg').appendChild(rect);
    }
    const move = ev => {
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      if (box) {
        rect.setAttribute('x', Math.min(x0, x)); rect.setAttribute('y', Math.min(y0, y));
        rect.setAttribute('width', Math.abs(x - x0)); rect.setAttribute('height', Math.abs(y - y0));
      } else { S.view.ox = v0.ox + x - x0; S.view.oy = v0.oy + y - y0; draw(); }
    };
    const up = ev => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (box) {
        const x = ev.clientX - r.left, y = ev.clientY - r.top;
        const [ax, bx, ay, by] = [Math.min(x0, x), Math.max(x0, x), Math.min(y0, y), Math.max(y0, y)];
        MAP.forEach(n => {
          const px = sx(n.x), py = sy(n.y);
          if (S.filter.has(n.r) && !S.taken[n.id] && px >= ax && px <= bx && py >= ay && py <= by) S.picked.add(n.id);
        });
        rect.remove();
        draw();
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  el.addEventListener('click', e => {
    const hit = e.target.closest('[data-id]');
    if (!S || !hit || e.shiftKey) return;
    const id = hit.dataset.id;
    if (S.taken[id]) return;
    S.picked.has(id) ? S.picked.delete(id) : S.picked.add(id);
    draw();
  });
  el.addEventListener('mousemove', e => {
    const tip = $('mp-tip'), hit = e.target.closest('[data-id]');
    if (!S || !hit) { tip.style.display = 'none'; return; }
    const n = BY[hit.dataset.id], r = el.getBoundingClientRect();
    tip.innerHTML = `<b>${itemName(n.r)}</b> · ${n.p}${n.w ? ' · well satellite' : ''}<br>
      <span>${fmt(n.x)}, ${fmt(n.y)} m</span>${S.taken[n.id] ? `<br><span class="n-warn">mined by ${S.taken[n.id]}</span>` : ''}`;
    tip.style.display = 'block';
    tip.style.left = (e.clientX - r.left + 12) + 'px';
    tip.style.top = (e.clientY - r.top + 12) + 'px';
  });
}

// ── Drawing ───────────────────────────────────────────────
function draw() {
  if (!S) return;
  const el = $('mp-map'), svg = $('mp-svg'), w = el.clientWidth, h = el.clientHeight;
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  let g = '';
  // a 500 m grid, for finding your way back
  const step = S.view.scale > 0.4 ? 100 : 500;
  for (let x = Math.ceil(BOUNDS.x[0] / step) * step; x <= BOUNDS.x[1]; x += step)
    g += `<line class="mp-grid" x1="${sx(x)}" y1="${sy(BOUNDS.y[0])}" x2="${sx(x)}" y2="${sy(BOUNDS.y[1])}"/>`;
  for (let y = Math.ceil(BOUNDS.y[0] / step) * step; y <= BOUNDS.y[1]; y += step)
    g += `<line class="mp-grid" x1="${sx(BOUNDS.x[0])}" y1="${sy(y)}" x2="${sx(BOUNDS.x[1])}" y2="${sy(y)}"/>`;
  // wells: a ring round their satellites
  const wells = {};
  MAP.forEach(n => { if (n.w && S.filter.has(n.r)) (wells[n.w] = wells[n.w] || []).push(n); });
  Object.values(wells).forEach(list => {
    const cx = list.reduce((s, n) => s + n.x, 0) / list.length, cy = list.reduce((s, n) => s + n.y, 0) / list.length;
    const rad = Math.max(...list.map(n => Math.hypot(n.x - cx, n.y - cy))) * S.view.scale + 10;
    g += `<circle class="mp-well" cx="${sx(cx)}" cy="${sy(cy)}" r="${rad}"/>`;
  });
  const order = { impure: 0, normal: 1, pure: 2 };
  [...MAP].filter(n => S.filter.has(n.r)).sort((a, b) => order[a.p] - order[b.p]).forEach(n => {
    const x = sx(n.x), y = sy(n.y);
    if (x < -20 || y < -20 || x > w + 20 || y > h + 20) return;
    const r = RADIUS[n.p] * (n.w ? 0.75 : 1) * Math.min(1.6, Math.max(0.8, S.view.scale / 0.12));
    const taken = S.taken[n.id], on = S.picked.has(n.id);
    g += `<g data-id="${n.id}" class="mp-n ${taken ? 'taken' : ''} ${on ? 'on' : ''}">
      <circle cx="${x}" cy="${y}" r="${r}" fill="${COLORS[n.r]}" fill-opacity="${{ impure: 0.45, normal: 0.75, pure: 1 }[n.p]}"/>
      ${taken ? `<path d="M${x - r} ${y - r}L${x + r} ${y + r}M${x + r} ${y - r}L${x - r} ${y + r}" class="mp-x"/>` : ''}</g>`;
  });
  svg.innerHTML = g;
  renderList();
}

// The picked extractors: one per node, one per well; each with its shards and rate
function units() {
  const out = [], wells = {};
  [...S.picked].map(id => BY[id]).filter(Boolean).forEach(n => {
    if (n.w) (wells[n.w] = wells[n.w] || { key: n.w, r: n.r, well: true, nodes: [] }).nodes.push(n);
    else out.push({ key: n.id, r: n.r, well: false, nodes: [n] });
  });
  out.push(...Object.values(wells));
  out.forEach(u => {
    const ex = u.well ? 'Resource_Well' : u.r === 'Crude_Oil' ? 'Oil_Extractor' : 'Miner';
    const base = ex === 'Miner' ? S.minerRate : ex === 'Oil_Extractor' ? 120 : 60;
    u.top = u.nodes.reduce((s, n) => s + base * (PURITY[n.p] ?? 1), 0);
    u.cap = CAP[ex] || null;
    u.rate = s => { const r = u.top * (1 + 0.5 * s); return u.cap ? Math.min(u.cap, r) : r; };
  });
  return out.sort((a, b) => itemName(a.r).localeCompare(itemName(b.r)) || b.top - a.top);
}

// Biggest gain per shard first, three per extractor at most
function spread(budget) {
  const us = units();
  us.forEach(u => { S.shards[u.key] = 0; });
  let left = budget;
  while (left > 0) {
    let best = null, gain = 1e-9;
    us.forEach(u => {
      const s = S.shards[u.key];
      if (s < MAX_SHARDS && u.rate(s + 1) - u.rate(s) > gain) { best = u; gain = u.rate(s + 1) - u.rate(s); }
    });
    if (!best) break;
    S.shards[best.key]++; left--;
  }
}

function renderList() {
  const us = units(), el = $('mp-list');
  if (!us.length) { el.innerHTML = '<p class="n-hint">No nodes picked yet.</p>'; return; }
  const tot = {};
  us.forEach(u => { tot[u.r] = (tot[u.r] || 0) + u.rate(S.shards[u.key] || 0); });
  const shards = us.reduce((s, u) => s + (S.shards[u.key] || 0), 0);
  el.innerHTML = `<div class="mp-tot">${Object.entries(tot).map(([r, v]) =>
      `<div><i style="background:${COLORS[r]}"></i>${itemName(r)} <b>${fmt(v)}/min</b></div>`).join('')}
      <div class="n-hint">${us.length} extractor${us.length > 1 ? 's' : ''} · ⚡${shards} shards</div></div>`
    + us.map(u => `<div class="mp-u" data-k="${u.key}">
        <i style="background:${COLORS[u.r]}"></i>
        <span>${itemName(u.r)} · ${u.well ? `well, ${u.nodes.length} satellites` : u.nodes[0].p}</span>
        <select>${[...Array(MAX_SHARDS + 1).keys()].map(k => `<option value="${k}" ${k === (S.shards[u.key] || 0) ? 'selected' : ''}>⚡${k}</option>`).join('')}</select>
        <b>${fmt(u.rate(S.shards[u.key] || 0))}</b>
        <span class="bi mp-rm" title="Drop">✕</span></div>`).join('');
  el.querySelectorAll('.mp-u').forEach(row => {
    const u = us.find(x => x.key === row.dataset.k);
    row.querySelector('select').addEventListener('change', e => { S.shards[u.key] = +e.target.value; renderList(); });
    row.querySelector('.mp-rm').addEventListener('click', () => { u.nodes.forEach(n => S.picked.delete(n.id)); draw(); });
    row.addEventListener('mouseenter', () => u.nodes.forEach(n => $('mp-svg').querySelector(`[data-id="${n.id}"]`)?.classList.add('hl')));
    row.addEventListener('mouseleave', () => $('mp-svg').querySelectorAll('.hl').forEach(x => x.classList.remove('hl')));
  });
}
