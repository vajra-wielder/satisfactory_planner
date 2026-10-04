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
import { uploadSave, changesHTML, wireChanges } from './save-import.js';

const $ = id => document.getElementById(id);
const fmt = v => (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : +v.toFixed(1)).toLocaleString();
const COLORS = {
  Iron_Ore: '#9aa6b8', Copper_Ore: '#e07a3f', Limestone: '#d9cfb0', Coal: '#5b5f6b', Caterium_Ore: '#e8c547',
  Raw_Quartz: '#d77bd8', Sulfur: '#d6e04a', Bauxite: '#c8553d', Uranium_Ore: '#6ee06e', SAM: '#9b6cf0',
  Crude_Oil: '#3a3a52', Nitrogen_Gas: '#7fb7d9', Water: '#3fa7f5', Geyser: '#ff6b9a',
};
const CAP = { Miner: 1200, Oil_Extractor: 600, Water_Extractor: 600 };
const GEO_MW = { impure: 100, normal: 200, pure: 400 };
const FACTORY_COLORS = ['#f59e0b', '#22c55e', '#38bdf8', '#f472b6', '#a78bfa', '#ef4444', '#14b8a6', '#eab308', '#fb923c', '#84cc16'];
// Labels up close: the bubble already says the purity, so just a short name (none
// when only one resource is shown) and whose it is
const SHORT = { Iron_Ore: 'Iron', Copper_Ore: 'Copper', Caterium_Ore: 'Caterium', Raw_Quartz: 'Quartz', Uranium_Ore: 'Uranium',
  Crude_Oil: 'Oil', Nitrogen_Gas: 'Nitrogen', Limestone: 'Lime' };
const shortOf = r => SHORT[r] || nameOf(r);
const DARK = new Set(['Coal', 'Crude_Oil', 'Bauxite', 'SAM', 'Copper_Ore']);   // purity letters in white on these
const nameOf = r => (r === 'Geyser' ? 'Geyser' : itemName(r));
// What a factory mines; geysers' generators go on the grid (the Blackboard's map)
const PICKABLE = Object.keys(COLORS).filter(r => r !== 'Geyser');

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
    waitForPicture();
    return MAP;
  });
}

// The game's map is fetched once, in the background: draw it when it's here
let _waiting = false;
function waitForPicture(tries = 0) {
  if (IMG?.ext || IMG?.game !== 'downloading' || (_waiting && !tries)) return;
  _waiting = true;
  setTimeout(() => fetch('/api/map-settings').then(r => r.json()).then(ms => {
    IMG = ms;
    if (ms.ext) { _waiting = false; document.dispatchEvent(new Event('map-picture')); document.querySelectorAll('.mp-tools').forEach(t => t._redo?.()); }
    else if (ms.game === 'downloading' && tries < 90) waitForPicture(tries + 1);
    else { _waiting = false; document.querySelectorAll('.mp-tools').forEach(t => t._redo?.()); }
  }).catch(() => { _waiting = false; }), 2000);
}

// ══════════════════════════════════════════════════════════
// One map in a container
// ══════════════════════════════════════════════════════════

function makeMap(el, M) {
  // M: { filter:Set, picked?:Set, taken?, owner?, ownerColor?, pins?, onClick(id), onBox(ids), onPin?(x,y) }
  el._mapOff?.abort();                    // a map remade in the same place drops the old one's listeners
  const off = new AbortController(), on = { signal: off.signal };
  el._mapOff = off;
  el.classList.add('mp-map');
  el.innerHTML = `<img class="mp-bg" alt="" draggable="false"><svg></svg><div class="mp-tip"></div>
    <div class="mp-zoom"><button class="bsm" data-z="in" title="Zoom in (+)">+</button><button class="bsm" data-z="out" title="Zoom out (−)">−</button>
      <button class="bsm" data-z="fit" title="The whole map (0)">⤢</button></div>
    <div class="mp-level"></div>`;
  const svg = el.querySelector('svg'), tip = el.querySelector('.mp-tip'), bg = el.querySelector('.mp-bg');
  const fit = () => {
    const w = el.clientWidth, h = el.clientHeight;
    const bw = BOUNDS.x[1] - BOUNDS.x[0], bh = BOUNDS.y[1] - BOUNDS.y[0];
    const scale = Math.min(w / bw, h / bh) * 0.96;
    M.fitScale = scale;
    M.view = { scale, ox: (w - bw * scale) / 2 - BOUNDS.x[0] * scale, oy: (h - bh * scale) / 2 - BOUNDS.y[0] * scale };
  };
  const sx = x => x * M.view.scale + M.view.ox, sy = y => y * M.view.scale + M.view.oy;
  const wx = px => (px - M.view.ox) / M.view.scale, wy = py => (py - M.view.oy) / M.view.scale;
  // How much each node shows: dots from afar; its purity when you're closer or
  // have picked one or two resources; its name and whose it is up close
  const level = () => {
    const rel = M.view.scale / (M.fitScale || M.view.scale);
    return rel >= 4.5 ? 2 : rel >= 2 || M.filter.size <= 2 ? 1 : 0;
  };
  const SIZE = [{ impure: 2.5, normal: 3.5, pure: 4.5 }, { impure: 5, normal: 6.5, pure: 8 }, { impure: 6, normal: 7.5, pure: 9.5 }];
  const LETTER = { impure: 'I', normal: 'N', pure: 'P' };

  function drawPicture() {
    if (!IMG?.ext) { bg.style.display = 'none'; return; }
    // yours nudged by dx, dy, scale; the game's exactly on the map's edges
    const bw = (BOUNDS.x[1] - BOUNDS.x[0]) * IMG.scale, bh = (BOUNDS.y[1] - BOUNDS.y[0]) * IMG.scale;
    const cx = (BOUNDS.x[0] + BOUNDS.x[1]) / 2 + IMG.dx, cy = (BOUNDS.y[0] + BOUNDS.y[1]) / 2 + IMG.dy;
    const src = `/api/map-image?v=${IMG.v || 0}&s=${IMG.source || ''}`;
    if (bg.getAttribute('src') !== src) bg.setAttribute('src', src);
    Object.assign(bg.style, { display: 'block', left: `${sx(cx - bw / 2)}px`, top: `${sy(cy - bh / 2)}px`,
      width: `${bw * M.view.scale}px`, height: `${bh * M.view.scale}px`, opacity: IMG.opacity });
  }

  // What a factory's nodes give that its plan doesn't use: a tag on its nodes
  // of that resource ("+230 unused"); in the picker, click it to bring it here
  function spareTags() {
    let out = '';
    (M.spare || []).forEach((sp, i) => {
      if (!M.filter.has(sp.item) || !(sp.left > 0.05)) return;
      const ns = sp.ids.map(id => BY[id]).filter(Boolean);
      if (!ns.length) return;
      const x = sx(ns.reduce((a, n) => a + n.x, 0) / ns.length), y = sy(Math.min(...ns.map(n => n.y))) - 16;
      if (x < -80 || y < -30 || x > el.clientWidth + 80 || y > el.clientHeight + 30) return;
      const t = sp.bring > 0 ? `→ ${fmt(sp.bring)} of ${fmt(sp.left)} here` : `+${fmt(sp.left)}${sp.fluid ? ' m³' : ''} unused`;
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
    if (!IMG?.ext) {
      const step = M.view.scale > 0.4 ? 100 : 500;
      for (let x = Math.ceil(BOUNDS.x[0] / step) * step; x <= BOUNDS.x[1]; x += step)
        g += `<line class="mp-grid" x1="${sx(x)}" y1="${sy(BOUNDS.y[0])}" x2="${sx(x)}" y2="${sy(BOUNDS.y[1])}"/>`;
      for (let y = Math.ceil(BOUNDS.y[0] / step) * step; y <= BOUNDS.y[1]; y += step)
        g += `<line class="mp-grid" x1="${sx(BOUNDS.x[0])}" y1="${sy(y)}" x2="${sx(BOUNDS.x[1])}" y2="${sy(y)}"/>`;
    }
    const wells = {};
    MAP.forEach(n => { if (n.w && M.filter.has(n.r)) (wells[n.w] = wells[n.w] || []).push(n); });
    let labels = '';
    Object.values(wells).forEach(list => {
      const cx = list.reduce((s, n) => s + n.x, 0) / list.length, cy = list.reduce((s, n) => s + n.y, 0) / list.length;
      const rad = Math.max(...list.map(n => Math.hypot(n.x - cx, n.y - cy))) * M.view.scale + 10;
      g += `<circle class="mp-well" cx="${sx(cx)}" cy="${sy(cy)}" r="${rad}"/>`;
      if (lv === 2) labels += `<text class="mp-lbl" x="${sx(cx)}" y="${sy(cy) - rad - 5}" text-anchor="middle">${M.filter.size > 1 ? shortOf(list[0].r) + ' ' : ''}well ×${list.length}</text>`;
    });
    const order = { impure: 0, normal: 1, pure: 2 };
    const placed = [];
    [...MAP].filter(n => M.filter.has(n.r)).sort((a, b) => order[a.p] - order[b.p]).forEach(n => {
      const x = sx(n.x), y = sy(n.y);
      if (x < -40 || y < -40 || x > w + 40 || y > h + 40) return;
      const r = SIZE[lv][n.p] * (n.w ? 0.8 : 1);
      const taken = M.taken?.[n.id], picked = M.picked?.has(n.id), own = M.owner?.[n.id];
      g += `<g data-id="${n.id}" class="mp-n ${taken ? 'taken' : ''} ${picked ? 'on' : ''}">
        ${SAVE.has(n.id) ? `<circle cx="${x}" cy="${y}" r="${r + 3.5}" class="mp-save"/>` : ''}
        ${own ? `<circle cx="${x}" cy="${y}" r="${r + 2}" fill="none" stroke="${M.ownerColor(own)}" stroke-width="2.5"/>` : ''}
        ${M.grid?.has(n.id) ? `<circle cx="${x}" cy="${y}" r="${r + 6}" class="mp-grid-g"/>` : ''}
        <circle cx="${x}" cy="${y}" r="${r}" fill="${COLORS[n.r]}" fill-opacity="${lv ? 1 : { impure: 0.55, normal: 0.8, pure: 1 }[n.p]}"/>
        ${lv && !M.grid?.has(n.id) ? `<text x="${x}" y="${y + r * 0.42}" class="mp-pur ${DARK.has(n.r) ? 'lt' : ''}" style="font-size:${(r * 1.15).toFixed(1)}px">${LETTER[n.p]}</text>` : ''}
        ${M.grid?.has(n.id) ? `<text x="${x}" y="${y + 3.5}" class="mp-bolt">⚡</text>` : ''}
        ${taken ? `<path d="M${x - r} ${y - r}L${x + r} ${y + r}M${x + r} ${y - r}L${x - r} ${y + r}" class="mp-x"/>` : ''}</g>`;
      if (lv === 2 && !n.w) {
        let who = taken || (own ? M.ownerName(own) : M.grid?.has(n.id) ? '⚡ grid' : SAVE.has(n.id) ? 'in save' : '');
        // whose it is, once per cluster: not again for a node of the same one close by
        if (who && placed.some(q => q.who === who && Math.hypot(q.x - x, q.y - y) < 70)) who = '';
        else if (who) placed.push({ who, x, y });
        const what = [M.filter.size > 1 ? shortOf(n.r) : '', n.r === 'Geyser' ? `${GEO_MW[n.p]} MW` : ''].filter(Boolean).join(' ');
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
    el.querySelector('.mp-level').textContent = ['Zoom in or pick one resource for purity', 'Zoom in more for names and owners', ''][lv];
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
  el.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('[data-id],[data-pin],[data-spare]') && !e.shiftKey) return;   // clicks handled on click
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
      } else { M.view.ox = v0.ox + x - x0; M.view.oy = v0.oy + y - y0; soon(); }
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
  }, on);
  el.addEventListener('click', e => {
    if (e.shiftKey) return;
    const tag = e.target.closest('[data-spare]');
    if (tag) { M.onSpare?.(+tag.dataset.spare); return; }
    const pin = e.target.closest('[data-pin]');
    if (pin && M.onPinClick) { M.onPinClick(+pin.dataset.pin); return; }
    const hit = e.target.closest('[data-id]');
    if (hit && M.onClick && !M.taken?.[hit.dataset.id]) M.onClick(hit.dataset.id);
  }, on);
  el.addEventListener('mousemove', e => {
    const hit = e.target.closest('[data-id]'), pin = e.target.closest('[data-pin]'), tag = e.target.closest('[data-spare]');
    if (!hit && !pin && !tag) { tip.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    if (tag) {
      const sp = M.spare[+tag.dataset.spare];
      tip.innerHTML = `<b>${sp.name}</b> leaves ${fmt(sp.left)}/min of ${nameOf(sp.item)} unused${sp.stale ? '<br><span class="n-warn">its plan is out of date</span>' : ''}
        ${M.onSpare ? `<br><span>${sp.bring > 0 ? 'Click to leave it there' : 'Click to bring it here — as an import'}</span>` : ''}`;
    } else if (pin) {
      const p = M.pins[+pin.dataset.pin];
      tip.innerHTML = `<b>${p.count} water extractor${p.count > 1 ? 's' : ''}</b>${p.label ? `<br><span>${p.label}</span>` : ''}`;
    } else {
      const n = BY[hit.dataset.id];
      tip.innerHTML = `<b>${nameOf(n.r)}</b> · ${n.p}${n.w ? ' · well satellite' : ''}${n.r === 'Geyser' ? ` · ~${GEO_MW[n.p]} MW` : ''}<br>
        <span>${fmt(n.x)}, ${fmt(n.y)} m</span>${SAVE.has(n.id) ? '<br><span class="mp-save-t">mined in your save</span>' : ''}
        ${M.taken?.[n.id] ? `<br><span class="n-warn">mined by ${M.taken[n.id]}</span>` : ''}
        ${(M.spare || []).filter(sp => sp.item === n.r && sp.ids.includes(n.id) && sp.left > 0.05)
          .map(sp => `<br><span class="mp-spare-t">${fmt(sp.left)}/min of it unused there</span>`).join('')}
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

// Filter chips for a map
function chips(el, M, redraw, kinds = Object.keys(COLORS)) {
  el.innerHTML = kinds.map(r =>
    `<button class="mp-f ${M.filter.has(r) ? 'on' : ''}" data-r="${r}"><i style="background:${COLORS[r]}"></i>${nameOf(r)}</button>`).join('')
    + '<button class="mp-f" data-r="*" title="Shift- or Ctrl-click a resource to add it">All</button>';
  el.querySelectorAll('.mp-f').forEach(b => b.addEventListener('click', e => {
    const r = b.dataset.r;
    if (r === '*') M.filter = new Set(kinds);
    else if (e.shiftKey || e.ctrlKey || e.metaKey) M.filter.has(r) ? M.filter.delete(r) : M.filter.add(r);
    else M.filter = new Set([r]);
    el.querySelectorAll('.mp-f').forEach(x => x.classList.toggle('on', M.filter.has(x.dataset.r)));
    redraw();
  }));
}

// Save and map-picture tools, shared by both maps
function tools(el, redraw) {
  el._redo = () => { tools(el, redraw); redraw(); };
  const own = IMG?.source === 'own';
  const pic = own ? '' : IMG?.source === 'game' ? '<span class="mp-hint">The game\'s map</span>'
    : IMG?.game === 'downloading' ? '<span class="mp-hint">Fetching the game\'s map…</span>'
    : IMG?.game === 'failed' ? `<span class="mp-hint n-warn" title="${(IMG.game_error || '').replace(/"/g, '&quot;')}">Couldn't fetch the game's map</span> <button class="bsm" id="mp-game-retry">Try again</button>` : '';
  el.innerHTML = `
    <label class="bsm" title="Read a .sav to mark the nodes your game already mines">📂 Load save<input type="file" accept=".sav" hidden></label>
    <span class="mp-hint mp-save-info">${SAVE_INFO ? `${SAVE.size} nodes mined in ${SAVE_INFO.file || 'your save'}` : ''}</span>
    <span class="mp-unl"></span>
    ${pic}
    <label class="bsm" title="Your own picture of the whole in-game map, instead of the game's">🖼 ${own ? 'Another picture' : 'My own picture'}<input type="file" accept="image/png,image/jpeg,image/webp" hidden></label>
    ${own ? '<button class="bsm" id="mp-game-use" title="Drop your picture and draw the game\'s map">Use the game map</button>' : ''}
    ${IMG?.ext ? `<span class="mp-align">${own ? `nudge <button class="bsm" data-a="left">←</button><button class="bsm" data-a="right">→</button>
      <button class="bsm" data-a="up">↑</button><button class="bsm" data-a="down">↓</button>
      <button class="bsm" data-a="in">+</button><button class="bsm" data-a="out">−</button>
      <button class="bsm" data-a="reset" title="Back to the map's edges">reset</button>` : ''}<button class="bsm" data-a="fade" title="Fade the picture">Fade</button></span>` : ''}`;
  if (el._keep) el.prepend(el._keep);   // a button of the map's own (the Blackboard's ⚡ Geothermal)
  el.querySelector('#mp-game-retry')?.addEventListener('click', () =>
    fetch('/api/map-game', { method: 'POST' }).then(r => r.json()).then(ms => { IMG = ms; waitForPicture(); el._redo(); }));
  el.querySelector('#mp-game-use')?.addEventListener('click', () =>
    fetch('/api/map-image', { method: 'DELETE' }).then(r => r.json()).then(ms => { IMG = { ...ms, v: Date.now() }; waitForPicture(); el._redo(); }));
  const [saveIn, imgIn] = el.querySelectorAll('input[type=file]');
  saveIn.addEventListener('change', () => {
    const f = saveIn.files[0];
    if (!f) return;
    el.querySelector('.mp-save-info').textContent = 'Reading the save…';
    uploadSave(f).then(d => {
      SAVE = new Set(d.nodes); SAVE_INFO = d;
      el.querySelector('.mp-save-info').textContent = `${SAVE.size} nodes mined in ${d.file}`;
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
      .then(r => r.json()).then(d => { if (!d.error) { IMG = { ...d, v: Date.now() }; tools(el, redraw); redraw(); } });
  });
  el.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => {
    const step = 20 / IMG.scale, a = b.dataset.a;
    const ch = { left: { dx: IMG.dx - step }, right: { dx: IMG.dx + step }, up: { dy: IMG.dy - step }, down: { dy: IMG.dy + step },
      in: { scale: IMG.scale * 1.005 }, out: { scale: IMG.scale / 1.005 }, fade: { opacity: IMG.opacity >= 0.95 ? 0.7 : IMG.opacity >= 0.65 ? 0.4 : 1 },
      reset: { dx: 0, dy: 0, scale: 1 } }[a];
    Object.assign(IMG, ch);
    redraw();
    fetch('/api/map-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ch) });
  }));
}

// ══════════════════════════════════════════════════════════
// PICKER — the nodes one factory mines
// ══════════════════════════════════════════════════════════

// A save read anywhere (Unlocks too) marks its nodes on the maps
document.addEventListener('save-read', e => { SAVE = new Set(e.detail.nodes || []); SAVE_INFO = e.detail; });

let S = null;   // the open picker

/** opts: { resource, picked: Set, shards: {id|well: n}, pins: [{x, y, count, shards}],
 *  taken: {id: factory name}, minerRate, onApply(picked, shards, pins) } */
export function openMapPicker(opts) {
  loadMap().then(() => {
    S = { ...opts, picked: new Set(opts.picked), shards: { ...opts.shards }, pins: (opts.pins || []).map(p => ({ ...p })),
          spare: (opts.spare || []).map(sp => ({ ...sp, bring: sp.mine || 0, ids: sp.ids.filter(id => BY[id]?.r === sp.item) })),
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
    M.onBox = ids => { ids.forEach(id => M.picked.add(id)); M.map.draw(); renderList(); };
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
      const pts = [...[...M.picked].map(id => BY[id]).filter(Boolean).map(n => [n.x, n.y]), ...M.pins.map(p => [p.x, p.y])];
      M.map.fitTo(pts);
      renderList();
    });
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

// Where this factory is: the middle of the nodes and pins it has picked
function here() {
  const pts = [...[...S.picked].map(id => BY[id]).filter(Boolean).map(n => [n.x, n.y]), ...S.pins.map(p => [p.x, p.y])];
  return pts.length ? [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length] : null;
}

// What other factories' nodes give that their plans don't use: bring some here
function renderSpare() {
  const el = $('mp-spare');
  const list = S.spare.filter(sp => sp.left > 0.05 || sp.bring > 0);
  if (!list.length) { el.innerHTML = ''; return; }
  const at = here();
  const dist = sp => {
    const ns = sp.ids.map(id => BY[id]).filter(Boolean);
    if (!at || !ns.length) return null;
    return Math.hypot(ns.reduce((a, n) => a + n.x, 0) / ns.length - at[0], ns.reduce((a, n) => a + n.y, 0) / ns.length - at[1]);
  };
  const rows = list.map((sp, k) => ({ sp, i: S.spare.indexOf(sp), d: dist(sp) }))
    .sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9) || b.sp.left - a.sp.left);
  el.innerHTML = `<div class="n-sent-t">Unused nearby</div>
    <p class="n-hint">What other factories' nodes give that their plans don't use. Bring some here as an import; what you leave stays theirs.</p>`
    + rows.map(({ sp, i, d }) => `<div class="mp-u mp-su ${S.filter.has(sp.item) ? '' : 'dim'}" data-s="${i}">
        <i style="background:${COLORS[sp.item] || '#888'}"></i>
        <span>${nameOf(sp.item)} · ${sp.name}<br><span class="n-hint">${fmt(sp.left)}/min unused${d != null ? ` · ${d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m'} away` : ''}${sp.stale ? ' · its plan is out of date' : ''}</span></span>
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
 *  pins: [{x, y, count, factory}]; grid: geyser ids with the grid's geothermal
 *  generators; onGrid(ids) when they change; onOpen(key). */
export function mountMapView(el, { owners, factories, pins, grid = [], spare = [], onGrid = () => {}, onOpen }) {
  return loadMap().then(() => {
    const color = {};
    factories.forEach((f, i) => { color[f.key] = FACTORY_COLORS[i % FACTORY_COLORS.length]; });
    const name = k => factories.find(f => f.key === k)?.name || k;
    el.innerHTML = `<div class="mp-filters"></div><div class="mp-tools"></div>
      <div class="mp-main"><div class="mp-view"></div><div class="mp-side mp-legend"></div></div>`;
    const M = { filter: new Set(Object.keys(COLORS)), owner: owners, ownerColor: k => color[k] || '#fff', ownerName: name,
                pins: pins.map(p => ({ ...p, color: color[p.factory], label: name(p.factory), mine: true })),
                grid: new Set(grid), geoMode: false,
                spare: spare.map(sp => ({ ...sp, ids: sp.ids.filter(id => BY[id]?.r === sp.item) })) };
    const setGrid = ids => { M.grid = new Set(ids); onGrid([...M.grid].sort()); redraw(); };
    // In geothermal mode a click on a geyser puts a generator on it (or takes it off)
    M.onClick = id => {
      if (!M.geoMode || BY[id]?.r !== 'Geyser' || owners[id]) return;
      const g = new Set(M.grid);
      g.has(id) ? g.delete(id) : g.add(id);
      setGrid(g);
    };
    M.map = makeMap(el.querySelector('.mp-view'), M);
    const legend = () => {
      const count = {}, free = {}, inSave = {};
      MAP.forEach(n => {
        if (!M.filter.has(n.r)) return;
        if (owners[n.id]) count[owners[n.id]] = (count[owners[n.id]] || 0) + 1;
        else if (SAVE.has(n.id)) inSave[n.r] = (inSave[n.r] || 0) + 1;
        else if (n.p === 'pure' && !M.grid.has(n.id)) free[n.r] = (free[n.r] || 0) + 1;
      });
      const mw = [...M.grid].reduce((a, id) => a + (GEO_MW[BY[id]?.p] || 0), 0);
      // geysers your save already has generators on, not yet on the grid
      const saved = MAP.filter(n => n.r === 'Geyser' && SAVE.has(n.id) && !M.grid.has(n.id) && !owners[n.id]).map(n => n.id);
      el.querySelector('.mp-legend').innerHTML = `
        <div class="n-sent-t">Power grid</div>
        ${M.grid.size ? `<div class="mp-lg"><i class="geo"></i>Geothermal × ${M.grid.size}<b>${fmt(mw)} MW</b></div>
          <p class="n-hint">On average — a geyser swings between ½× and 1½×: ${fmt(mw / 2)}–${fmt(mw * 1.5)} MW.</p>`
          : '<p class="n-hint">No geothermal generators yet — ⚡ Geothermal, then click geysers.</p>'}
        ${saved.length ? `<button class="bsm" id="mp-geo-save">⚡ Add the ${saved.length} in your save</button>` : ''}
        ${M.spare.some(sp => sp.left > 0.05) ? `<div class="n-sent-t" style="margin-top:10px">Unused at factories</div>
          ${M.spare.filter(sp => sp.left > 0.05).sort((a, b) => b.left - a.left).map(sp => `<div class="mp-lg"><i style="background:${COLORS[sp.item] || '#888'};border:none"></i>
            <span>${nameOf(sp.item)} · <span class="bb-name" data-key="${sp.factory}" style="font-weight:400">${sp.name}</span></span><b>+${fmt(sp.left)}</b></div>`).join('')}
          <p class="n-hint">Bring it to a factory nearby: Pick on map there, or import it.</p>` : ''}
        <div class="n-sent-t" style="margin-top:10px">Factories</div>
        ${factories.filter(f => count[f.key]).map(f => `<div class="mp-lg"><i style="border-color:${color[f.key]}"></i>
          <span class="bb-name" data-key="${f.key}" style="font-weight:400">${f.name}</span><b>${count[f.key]}</b></div>`).join('')
          || '<p class="n-hint">No factory has nodes picked yet.</p>'}
        <div class="n-sent-t" style="margin-top:10px">In your save, not in a factory</div>
        ${Object.keys(inSave).length ? Object.entries(inSave).map(([r, c]) => `<div class="mp-lg"><i class="sv"></i>${nameOf(r)}<b>${c}</b></div>`).join('')
          : `<p class="n-hint">${SAVE_INFO ? 'None' : 'Load a save to see what you already mine.'}</p>`}
        <div class="n-sent-t" style="margin-top:10px">Pure nodes still free</div>
        ${Object.entries(free).map(([r, c]) => `<div class="mp-lg"><i style="background:${COLORS[r]};border:none"></i>${nameOf(r)}<b>${c}</b></div>`).join('')}`;
      el.querySelectorAll('.mp-legend .bb-name').forEach(t => t.addEventListener('click', () => onOpen(t.dataset.key)));
      el.querySelector('#mp-geo-save')?.addEventListener('click', () => setGrid([...M.grid, ...saved]));
    };
    function redraw() { M.map.draw(); legend(); }
    chips(el.querySelector('.mp-filters'), M, redraw);
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
      if (M.geoMode) M.filter = new Set(['Geyser']);
      el.querySelectorAll('.mp-filters .mp-f').forEach(x => x.classList.toggle('on', M.filter.has(x.dataset.r)));
      redraw();
    });
    requestAnimationFrame(() => { M.map.refit(); legend(); });
  });
}
