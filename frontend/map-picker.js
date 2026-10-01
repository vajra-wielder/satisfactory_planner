/**
 * map-picker.js — the 1.0 world map: every resource node, resource-well
 * satellite and geyser (data/map_nodes.json), drawn by position; bigger and
 * brighter is purer.
 *
 * Two uses of one map:
 *   openMapPicker  pick the nodes a factory mines. Click a node, Shift+drag a
 *                  box, drag to pan, scroll to zoom. Nodes another factory
 *                  mines are crossed out. Geysers take geothermal generators.
 *                  Water extractors go anywhere there's water: drop pins.
 *                  The list on the right sets each extractor's shards.
 *   mountMapView   the Blackboard's map: whose node is whose, what your save
 *                  already mines, and what's still free.
 * Load a save to mark the nodes your game already mines (yellow rings), and
 * your own map picture to draw them on (it's lined up with the in-game map's
 * edges; nudge it if it's off).
 */

import { itemName, PURITY, MAX_SHARDS } from './state.js';
import { fetchMapNodes } from './api.js';

const $ = id => document.getElementById(id);
const fmt = v => (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : +v.toFixed(1)).toLocaleString();
const COLORS = {
  Iron_Ore: '#9aa6b8', Copper_Ore: '#e07a3f', Limestone: '#d9cfb0', Coal: '#5b5f6b', Caterium_Ore: '#e8c547',
  Raw_Quartz: '#d77bd8', Sulfur: '#d6e04a', Bauxite: '#c8553d', Uranium_Ore: '#6ee06e', SAM: '#9b6cf0',
  Crude_Oil: '#3a3a52', Nitrogen_Gas: '#7fb7d9', Water: '#3fa7f5', Geyser: '#ff6b9a',
};
const RADIUS = { impure: 4, normal: 6, pure: 8.5 };   // screen px
const CAP = { Miner: 1200, Oil_Extractor: 600, Water_Extractor: 600 };
const GEO_MW = { impure: 100, normal: 200, pure: 400 };
const FACTORY_COLORS = ['#f59e0b', '#22c55e', '#38bdf8', '#f472b6', '#a78bfa', '#ef4444', '#14b8a6', '#eab308', '#fb923c', '#84cc16'];
const nameOf = r => (r === 'Geyser' ? 'Geyser' : itemName(r));

let MAP = null, BY = {}, BOUNDS = null, SAVE = new Set(), SAVE_INFO = null, IMG = null;
export const mapNode = id => BY[id];
export function loadMap() {
  if (MAP) return Promise.resolve(MAP);
  return Promise.all([fetchMapNodes(), fetch('/api/save-nodes').then(r => r.json()).catch(() => ({ nodes: [] })),
                      fetch('/api/map-settings').then(r => r.json()).catch(() => ({}))]).then(([d, sv, ms]) => {
    MAP = d.nodes; BOUNDS = d.bounds;
    BY = Object.fromEntries(MAP.map(n => [n.id, n]));
    SAVE = new Set(sv.nodes || []); SAVE_INFO = sv.file ? sv : null;
    IMG = ms;
    return MAP;
  });
}

// ══════════════════════════════════════════════════════════
// One map in a container
// ══════════════════════════════════════════════════════════

function makeMap(el, M) {
  // M: { filter:Set, picked?:Set, taken?, owner?, ownerColor?, pins?, onClick(id), onBox(ids), onPin?(x,y) }
  el.classList.add('mp-map');
  el.innerHTML = '<svg></svg><div class="mp-tip"></div>';
  const svg = el.querySelector('svg'), tip = el.querySelector('.mp-tip');
  const fit = () => {
    const w = el.clientWidth, h = el.clientHeight;
    const bw = BOUNDS.x[1] - BOUNDS.x[0], bh = BOUNDS.y[1] - BOUNDS.y[0];
    const scale = Math.min(w / bw, h / bh) * 0.96;
    M.view = { scale, ox: (w - bw * scale) / 2 - BOUNDS.x[0] * scale, oy: (h - bh * scale) / 2 - BOUNDS.y[0] * scale };
  };
  const sx = x => x * M.view.scale + M.view.ox, sy = y => y * M.view.scale + M.view.oy;
  const wx = px => (px - M.view.ox) / M.view.scale, wy = py => (py - M.view.oy) / M.view.scale;

  function draw() {
    if (!M.view) fit();
    const w = el.clientWidth, h = el.clientHeight;
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    let g = '';
    if (IMG?.ext) {       // your map picture, on the in-game map's edges (nudged by dx, dy, scale)
      const bw = (BOUNDS.x[1] - BOUNDS.x[0]) * IMG.scale, bh = (BOUNDS.y[1] - BOUNDS.y[0]) * IMG.scale;
      const cx = (BOUNDS.x[0] + BOUNDS.x[1]) / 2 + IMG.dx, cy = (BOUNDS.y[0] + BOUNDS.y[1]) / 2 + IMG.dy;
      g += `<image href="/api/map-image?v=${IMG.v || 0}" x="${sx(cx - bw / 2)}" y="${sy(cy - bh / 2)}" width="${bw * M.view.scale}"
        height="${bh * M.view.scale}" opacity="${IMG.opacity}" preserveAspectRatio="none"/>`;
    }
    const step = M.view.scale > 0.4 ? 100 : 500;
    for (let x = Math.ceil(BOUNDS.x[0] / step) * step; x <= BOUNDS.x[1]; x += step)
      g += `<line class="mp-grid" x1="${sx(x)}" y1="${sy(BOUNDS.y[0])}" x2="${sx(x)}" y2="${sy(BOUNDS.y[1])}"/>`;
    for (let y = Math.ceil(BOUNDS.y[0] / step) * step; y <= BOUNDS.y[1]; y += step)
      g += `<line class="mp-grid" x1="${sx(BOUNDS.x[0])}" y1="${sy(y)}" x2="${sx(BOUNDS.x[1])}" y2="${sy(y)}"/>`;
    const wells = {};
    MAP.forEach(n => { if (n.w && M.filter.has(n.r)) (wells[n.w] = wells[n.w] || []).push(n); });
    Object.values(wells).forEach(list => {
      const cx = list.reduce((s, n) => s + n.x, 0) / list.length, cy = list.reduce((s, n) => s + n.y, 0) / list.length;
      const rad = Math.max(...list.map(n => Math.hypot(n.x - cx, n.y - cy))) * M.view.scale + 10;
      g += `<circle class="mp-well" cx="${sx(cx)}" cy="${sy(cy)}" r="${rad}"/>`;
    });
    const order = { impure: 0, normal: 1, pure: 2 };
    const zoom = Math.min(1.6, Math.max(0.8, M.view.scale / 0.12));
    [...MAP].filter(n => M.filter.has(n.r)).sort((a, b) => order[a.p] - order[b.p]).forEach(n => {
      const x = sx(n.x), y = sy(n.y);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) return;
      const r = RADIUS[n.p] * (n.w ? 0.75 : 1) * zoom;
      const taken = M.taken?.[n.id], on = M.picked?.has(n.id), own = M.owner?.[n.id];
      g += `<g data-id="${n.id}" class="mp-n ${taken ? 'taken' : ''} ${on ? 'on' : ''}">
        ${SAVE.has(n.id) ? `<circle cx="${x}" cy="${y}" r="${r + 3.5}" class="mp-save"/>` : ''}
        ${own ? `<circle cx="${x}" cy="${y}" r="${r + 2}" fill="none" stroke="${M.ownerColor(own)}" stroke-width="2.5"/>` : ''}
        <circle cx="${x}" cy="${y}" r="${r}" fill="${COLORS[n.r]}" fill-opacity="${{ impure: 0.45, normal: 0.75, pure: 1 }[n.p]}"/>
        ${taken ? `<path d="M${x - r} ${y - r}L${x + r} ${y + r}M${x + r} ${y - r}L${x - r} ${y + r}" class="mp-x"/>` : ''}</g>`;
    });
    (M.pins || []).forEach((p, i) => {
      const x = sx(p.x), y = sy(p.y), c = p.color || COLORS.Water;
      g += `<g data-pin="${i}" class="mp-pin"><rect x="${x - 7}" y="${y - 7}" width="14" height="14" rx="3" fill="${c}" stroke="${p.mine === false ? 'none' : '#fff'}" stroke-width="1.5"/>
        <text x="${x}" y="${y + 3.5}" text-anchor="middle">${p.count}</text></g>`;
    });
    svg.innerHTML = g;
  }

  el.addEventListener('wheel', e => {
    e.preventDefault();
    const r = el.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const k = Math.exp(-e.deltaY * 0.0015), v = M.view;
    const ns = Math.min(Math.max(v.scale * k, 0.02), 3);
    v.ox = px - (px - v.ox) * ns / v.scale; v.oy = py - (py - v.oy) * ns / v.scale; v.scale = ns;
    draw();
  }, { passive: false });
  el.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('[data-id],[data-pin]') && !e.shiftKey) return;   // clicks handled on click
    e.preventDefault();
    const r = el.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    const v0 = { ...M.view }, box = e.shiftKey && M.onBox;
    let rect = null, moved = false;
    if (box) {
      rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('class', 'mp-sel');
      svg.appendChild(rect);
    }
    const move = ev => {
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      moved = moved || Math.hypot(x - x0, y - y0) > 3;
      if (box) {
        rect.setAttribute('x', Math.min(x0, x)); rect.setAttribute('y', Math.min(y0, y));
        rect.setAttribute('width', Math.abs(x - x0)); rect.setAttribute('height', Math.abs(y - y0));
      } else { M.view.ox = v0.ox + x - x0; M.view.oy = v0.oy + y - y0; draw(); }
    };
    const up = ev => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      if (box) {
        const [ax, bx, ay, by] = [Math.min(x0, x), Math.max(x0, x), Math.min(y0, y), Math.max(y0, y)];
        M.onBox(MAP.filter(n => M.filter.has(n.r) && !M.taken?.[n.id]
          && sx(n.x) >= ax && sx(n.x) <= bx && sy(n.y) >= ay && sy(n.y) <= by).map(n => n.id));
        rect.remove();
      } else if (!moved && M.onPin) M.onPin(Math.round(wx(x)), Math.round(wy(y)));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  el.addEventListener('click', e => {
    if (e.shiftKey) return;
    const pin = e.target.closest('[data-pin]');
    if (pin && M.onPinClick) { M.onPinClick(+pin.dataset.pin); return; }
    const hit = e.target.closest('[data-id]');
    if (hit && M.onClick && !M.taken?.[hit.dataset.id]) M.onClick(hit.dataset.id);
  });
  el.addEventListener('mousemove', e => {
    const hit = e.target.closest('[data-id]'), pin = e.target.closest('[data-pin]');
    if (!hit && !pin) { tip.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    if (pin) {
      const p = M.pins[+pin.dataset.pin];
      tip.innerHTML = `<b>${p.count} water extractor${p.count > 1 ? 's' : ''}</b>${p.label ? `<br><span>${p.label}</span>` : ''}`;
    } else {
      const n = BY[hit.dataset.id];
      tip.innerHTML = `<b>${nameOf(n.r)}</b> · ${n.p}${n.w ? ' · well satellite' : ''}${n.r === 'Geyser' ? ` · ~${GEO_MW[n.p]} MW` : ''}<br>
        <span>${fmt(n.x)}, ${fmt(n.y)} m</span>${SAVE.has(n.id) ? '<br><span class="mp-save-t">mined in your save</span>' : ''}
        ${M.taken?.[n.id] ? `<br><span class="n-warn">mined by ${M.taken[n.id]}</span>` : ''}
        ${M.owner?.[n.id] ? `<br><span>${M.ownerName(M.owner[n.id])}</span>` : ''}`;
    }
    tip.style.display = 'block';
    tip.style.left = (e.clientX - r.left + 12) + 'px';
    tip.style.top = (e.clientY - r.top + 12) + 'px';
  });
  return { draw, refit: () => { M.view = null; draw(); } };
}

// Filter chips for a map
function chips(el, M, redraw) {
  el.innerHTML = Object.keys(COLORS).map(r =>
    `<button class="mp-f ${M.filter.has(r) ? 'on' : ''}" data-r="${r}"><i style="background:${COLORS[r]}"></i>${nameOf(r)}</button>`).join('')
    + '<button class="mp-f" data-r="*" title="Shift- or Ctrl-click a resource to add it">All</button>';
  el.querySelectorAll('.mp-f').forEach(b => b.addEventListener('click', e => {
    const r = b.dataset.r;
    if (r === '*') M.filter = new Set(Object.keys(COLORS));
    else if (e.shiftKey || e.ctrlKey || e.metaKey) M.filter.has(r) ? M.filter.delete(r) : M.filter.add(r);
    else M.filter = new Set([r]);
    el.querySelectorAll('.mp-f').forEach(x => x.classList.toggle('on', M.filter.has(x.dataset.r)));
    redraw();
  }));
}

// Save and map-picture tools, shared by both maps
function tools(el, redraw) {
  el.innerHTML = `
    <label class="bsm" title="Read a .sav to mark the nodes your game already mines">📂 Load save<input type="file" accept=".sav" hidden></label>
    <span class="mp-hint mp-save-info">${SAVE_INFO ? `${SAVE.size} nodes mined in ${SAVE_INFO.file || 'your save'}` : ''}</span>
    <label class="bsm" title="A picture of the whole in-game map, to draw the nodes on">🖼 Map picture<input type="file" accept="image/png,image/jpeg,image/webp" hidden></label>
    ${IMG?.ext ? `<span class="mp-align">nudge <button class="bsm" data-a="left">←</button><button class="bsm" data-a="right">→</button>
      <button class="bsm" data-a="up">↑</button><button class="bsm" data-a="down">↓</button>
      <button class="bsm" data-a="in">+</button><button class="bsm" data-a="out">−</button>
      <button class="bsm" data-a="fade" title="Fade the picture">◐</button><button class="bsm" data-a="reset" title="Back to the map's edges">reset</button></span>` : ''}`;
  const [saveIn, imgIn] = el.querySelectorAll('input[type=file]');
  saveIn.addEventListener('change', () => {
    const f = saveIn.files[0];
    if (!f) return;
    el.querySelector('.mp-save-info').textContent = 'Reading the save…';
    fetch('/api/save-file', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': f.name }, body: f })
      .then(r => r.json()).then(d => {
        if (d.error) throw new Error(d.error);
        SAVE = new Set(d.nodes); SAVE_INFO = d;
        el.querySelector('.mp-save-info').textContent = `${SAVE.size} nodes mined in ${d.file}`;
        redraw();
      }).catch(e => { el.querySelector('.mp-save-info').textContent = `Couldn't read it: ${e.message}`; });
  });
  imgIn.addEventListener('change', () => {
    const f = imgIn.files[0];
    if (!f) return;
    fetch('/api/map-image', { method: 'POST', headers: { 'Content-Type': f.type }, body: f })
      .then(r => r.json()).then(d => { if (!d.error) { IMG = { ...d, v: Date.now() }; tools(el, redraw); redraw(); } });
  });
  el.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => {
    const step = 20 / IMG.scale, a = b.dataset.a;
    const ch = { left: { dx: IMG.dx - step }, right: { dx: IMG.dx + step }, up: { dy: IMG.dy - step }, down: { dy: IMG.dy + step },
      in: { scale: IMG.scale * 1.005 }, out: { scale: IMG.scale / 1.005 }, fade: { opacity: IMG.opacity > 0.35 ? 0.3 : 0.7 },
      reset: { dx: 0, dy: 0, scale: 1 } }[a];
    Object.assign(IMG, ch);
    redraw();
    fetch('/api/map-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ch) });
  }));
}

// ══════════════════════════════════════════════════════════
// PICKER — the nodes one factory mines
// ══════════════════════════════════════════════════════════

let S = null;   // the open picker

/** opts: { resource, picked: Set, shards: {id|well: n}, pins: [{x, y, count, shards}],
 *  taken: {id: factory name}, minerRate, onApply(picked, shards, pins) } */
export function openMapPicker(opts) {
  loadMap().then(() => {
    S = { ...opts, picked: new Set(opts.picked), shards: { ...opts.shards }, pins: (opts.pins || []).map(p => ({ ...p })),
          filter: opts.resource && COLORS[opts.resource] ? new Set([opts.resource]) : new Set(Object.keys(COLORS)),
          pinMode: false };
    let m = $('map-modal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'map-modal';
      m.innerHTML = `
        <div class="mp-box">
          <div class="mp-top">
            <b>Pick nodes</b>
            <span class="mp-hint">Click a node · Shift+drag a box · drag to pan · scroll to zoom</span>
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
            </div>
          </div>
        </div>`;
      document.body.appendChild(m);
      $('mp-cancel').addEventListener('click', close);
      $('mp-apply').addEventListener('click', () => { S.onApply(S.picked, S.shards, S.pins); close(); });
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
    M.onBox = ids => { ids.forEach(id => M.picked.add(id)); M.map.draw(); renderList(); };
    M.onPin = (x, y) => { if (!M.pinMode) return; M.pins.push({ x, y, count: 1, shards: 0 }); M.map.draw(); renderList(); };
    M.onPinClick = i => { if (M.pinMode) { M.pins.splice(i, 1); M.map.draw(); renderList(); } };
    M.map = makeMap($('mp-map'), M);
    const redraw = () => M.map.draw();
    chips($('mp-filters'), M, redraw);
    tools($('mp-tools'), redraw);
    requestAnimationFrame(() => { M.map.refit(); renderList(); });
  });
}

function close() { $('map-modal')?.classList.remove('show'); S = null; }

// The picked extractors: one per node, one per well, one generator per geyser, the water pins
function units() {
  const out = [], wells = {};
  [...S.picked].map(id => BY[id]).filter(Boolean).forEach(n => {
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
  return out.sort((a, b) => nameOf(a.r).localeCompare(nameOf(b.r)) || b.top - a.top);
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

function renderList() {
  const us = units(), el = $('mp-list');
  if (!us.length) { el.innerHTML = '<p class="n-hint">No nodes picked yet.</p>'; return; }
  const tot = {};
  us.forEach(u => { tot[u.r] = (tot[u.r] || 0) + u.rate(shardOf(u)); });
  const shards = us.reduce((s, u) => s + shardOf(u) * cost(u), 0);
  el.innerHTML = `<div class="mp-tot">${Object.entries(tot).map(([r, v]) =>
      `<div><i style="background:${COLORS[r]}"></i>${nameOf(r)} <b>${fmt(v)}${r === 'Geyser' ? ' MW' : '/min'}</b></div>`).join('')}
      <div class="n-hint">${us.length} extractor${us.length > 1 ? 's' : ''} · ⚡${shards} shards</div></div>`
    + us.map(u => `<div class="mp-u" data-k="${u.key}">
        <i style="background:${COLORS[u.r]}"></i>
        <span>${nameOf(u.r)} · ${u.kind === 'well' ? `well, ${u.nodes.length} satellites` : u.kind === 'pin'
          ? `<input type="number" class="mp-cnt" min="1" step="1" value="${u.pin.count}"/> extractors` : u.nodes[0].p}</span>
        ${u.kind === 'geo' ? '<span class="n-hint">avg</span>' : `<select>${[...Array(MAX_SHARDS + 1).keys()].map(k =>
          `<option value="${k}" ${k === shardOf(u) ? 'selected' : ''}>⚡${k}</option>`).join('')}</select>`}
        <b>${fmt(u.rate(shardOf(u)))}${u.kind === 'geo' ? ' MW' : ''}</b>
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
 *  pins: [{x, y, count, factory}]; onOpen(key). */
export function mountMapView(el, { owners, factories, pins, onOpen }) {
  return loadMap().then(() => {
    const color = {};
    factories.forEach((f, i) => { color[f.key] = FACTORY_COLORS[i % FACTORY_COLORS.length]; });
    const name = k => factories.find(f => f.key === k)?.name || k;
    el.innerHTML = `<div class="mp-filters"></div><div class="mp-tools"></div>
      <div class="mp-main"><div class="mp-view"></div><div class="mp-side mp-legend"></div></div>`;
    const M = { filter: new Set(Object.keys(COLORS)), owner: owners, ownerColor: k => color[k] || '#fff', ownerName: name,
                pins: pins.map(p => ({ ...p, color: color[p.factory], label: name(p.factory), mine: true })) };
    M.map = makeMap(el.querySelector('.mp-view'), M);
    const legend = () => {
      const count = {}, free = {}, inSave = {};
      MAP.forEach(n => {
        if (!M.filter.has(n.r)) return;
        if (owners[n.id]) count[owners[n.id]] = (count[owners[n.id]] || 0) + 1;
        else if (SAVE.has(n.id)) inSave[n.r] = (inSave[n.r] || 0) + 1;
        else if (n.p === 'pure') free[n.r] = (free[n.r] || 0) + 1;
      });
      el.querySelector('.mp-legend').innerHTML = `
        <div class="n-sent-t">Factories</div>
        ${factories.filter(f => count[f.key]).map(f => `<div class="mp-lg"><i style="border-color:${color[f.key]}"></i>
          <span class="bb-name" data-key="${f.key}" style="font-weight:400">${f.name}</span><b>${count[f.key]}</b></div>`).join('')
          || '<p class="n-hint">No factory has nodes picked yet.</p>'}
        <div class="n-sent-t" style="margin-top:10px">In your save, not in a factory</div>
        ${Object.keys(inSave).length ? Object.entries(inSave).map(([r, c]) => `<div class="mp-lg"><i class="sv"></i>${nameOf(r)}<b>${c}</b></div>`).join('')
          : `<p class="n-hint">${SAVE_INFO ? 'None' : 'Load a save to see what you already mine.'}</p>`}
        <div class="n-sent-t" style="margin-top:10px">Pure nodes still free</div>
        ${Object.entries(free).map(([r, c]) => `<div class="mp-lg"><i style="background:${COLORS[r]};border:none"></i>${nameOf(r)}<b>${c}</b></div>`).join('')}`;
      el.querySelectorAll('.mp-legend .bb-name').forEach(t => t.addEventListener('click', () => onOpen(t.dataset.key)));
    };
    const redraw = () => { M.map.draw(); legend(); };
    chips(el.querySelector('.mp-filters'), M, redraw);
    tools(el.querySelector('.mp-tools'), redraw);
    requestAnimationFrame(() => { M.map.refit(); legend(); });
  });
}
