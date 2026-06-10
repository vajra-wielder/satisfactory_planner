/**
 * pinboard.js — Manual planning canvas (Pinboard mode).
 *
 * MS Paint-style toolbar: Select, Group (draw rect to create group),
 * Arrow (click node/group then click target), Unpin (click node to remove).
 *
 * Groups: drag a rectangle on the canvas → opens editor → creates sticky note
 * Arrows: click source node/group → click target node/group → arrow drawn
 * Unpin:  click any node → confirms unpin
 */

import { PINS, RECIPES, mCol, MABBR, itemName, addPin, removePin, isPinned } from './state.js';

// ── Canvas refs ───────────────────────────────────────────
let CV = null, C = null;
function initRefs() {
  if (CV) return true;
  CV = document.getElementById('gc');
  if (!CV) return false;
  C = CV.getContext('2d');
  return true;
}

// ── Mode flag ─────────────────────────────────────────────
let ACTIVE = false;
export function isPinboardActive() { return ACTIVE; }

// ── Active tool ───────────────────────────────────────────
// 'select' | 'group' | 'arrow' | 'unpin'
let TOOL = 'select';

function setTool(t) {
  TOOL = t;
  // Update toolbar button states
  ['select','group','arrow','unpin'].forEach(id => {
    const btn = document.getElementById('pb-tool-' + id);
    if (btn) btn.classList.toggle('pb-tool-active', id === t);
  });
  // Cursor hint
  if (!CV) return;
  if (t === 'group')  CV.style.cursor = 'crosshair';
  else if (t === 'arrow') CV.style.cursor = 'cell';
  else if (t === 'unpin') CV.style.cursor = 'not-allowed';
  else CV.style.cursor = 'default';

  // Cancel any in-progress operations
  ARROW_SRC = null;
  GROUP_RECT = null;
  schedDraw();
}

// ── Viewport ──────────────────────────────────────────────
let PAN  = { x: 80, y: 60 };
let ZOOM = 1;

// ── Scene ─────────────────────────────────────────────────
let NODES  = [];
let EDGES  = [];
let GROUPS = [];
let ARROWS = [];

// ── Tool state ────────────────────────────────────────────
let ARROW_SRC  = null;  // { type:'node'|'group', id } — first click in arrow mode
let GROUP_RECT = null;  // { x, y, w, h } — being drawn in group mode

// ── Constants matching graph.js node metrics ──────────────
const NW      = 258;
const IO_H    = 18;
const DIV_H   = 15;
const STATS_H = 20;
const HDR_H   = 20 + 16 + 16;
const PAD_BOT = 10;
const XGAP    = 200;
const YGAP    = 50;

function nodeH(node) {
  if (node._hcache != null) return node._hcache;
  const r    = RECIPES[node.id];
  if (!r) return 80;
  const ins  = Object.keys(r.inputs  || {}).length;
  const outs = Object.keys(r.outputs || {}).length;
  const io   = (ins  > 0 ? DIV_H + ins  * IO_H : 0)
             + (outs > 0 ? DIV_H + outs * IO_H : 0);
  node._hcache = HDR_H + STATS_H + io + PAD_BOT;
  return node._hcache;
}

// ── Interaction ───────────────────────────────────────────
let DRAG      = null;
let HIT       = null;
let animFrame = null;

function schedDraw() {
  if (animFrame) return;
  animFrame = requestAnimationFrame(() => { animFrame = null; draw(); });
}

// ── Build scene from PINS ─────────────────────────────────
export function rebuild() {
  if (!initRefs()) return;
  NODES  = [];
  EDGES  = [];
  GROUPS = JSON.parse(JSON.stringify(PINS.pin_groups  || []));
  ARROWS = JSON.parse(JSON.stringify(PINS.pin_arrows  || []));

  const keys = PINS.pinned_recipes || [];
  if (!keys.length) { schedDraw(); return; }

  const rank = {};
  keys.forEach(k => rank[k] = 0);
  for (let it = 0; it < 20; it++) {
    let changed = false;
    keys.forEach(k => {
      const r = RECIPES[k]; if (!r) return;
      let maxR = 0;
      keys.forEach(p => {
        if (p === k) return;
        const pr = RECIPES[p]; if (!pr) return;
        const pOuts = Object.keys(pr.outputs || {});
        const kIns  = Object.keys(r.inputs   || {});
        if (pOuts.some(o => kIns.includes(o)))
          maxR = Math.max(maxR, (rank[p] || 0) + 1);
      });
      if (maxR !== rank[k]) { rank[k] = maxR; changed = true; }
    });
    if (!changed) break;
  }
  const byRank = {};
  keys.forEach(k => {
    const r = rank[k] || 0;
    (byRank[r] = byRank[r] || []).push(k);
  });
  const layers = Object.keys(byRank).sort((a, b) => +a - +b).map(r => byRank[r]);

  let curX = 60;
  layers.forEach(layer => {
    let curY = 60;
    layer.forEach(key => {
      const saved = PINS.node_positions[key];
      const n = {
        id: key,
        x:  saved ? saved.x : curX,
        y:  saved ? saved.y : curY,
        w:  NW, h: 0,
        _hcache: null,
      };
      n.h = nodeH(n);
      NODES.push(n);
      curY += n.h + YGAP;
    });
    curX += NW + XGAP;
  });

  NODES.forEach(src => {
    const sr = RECIPES[src.id]; if (!sr) return;
    NODES.forEach(tgt => {
      if (src === tgt) return;
      const tr = RECIPES[tgt.id]; if (!tr) return;
      Object.keys(sr.outputs || {}).forEach(item => {
        if (tr.inputs[item]) {
          EDGES.push({ src: src.id, tgt: tgt.id, item, rate: sr.outputs[item], color: mCol(sr.machine) });
        }
      });
    });
  });

  cacheEdgePaths();
  schedDraw();
}

function cacheEdgePaths() {
  const nodeMap = Object.fromEntries(NODES.map(n => [n.id, n]));
  EDGES.forEach(e => {
    const sn = nodeMap[e.src], tn = nodeMap[e.tgt];
    if (!sn || !tn) return;
    const x1 = sn.x + sn.w, y1 = sn.y + nodeH(sn) / 2;
    const x2 = tn.x,         y2 = tn.y + nodeH(tn) / 2;
    const span = Math.max(Math.abs(x2 - x1), 80);
    e._x1 = x1; e._y1 = y1;
    e._cx1 = x1 + span * 0.45; e._cy1 = y1;
    e._cx2 = x2 - span * 0.45; e._cy2 = y2;
    e._x2 = x2; e._y2 = y2;
    e._mx = 0.125*x1 + 0.375*e._cx1 + 0.375*e._cx2 + 0.125*x2;
    e._my = 0.125*y1 + 0.375*y1     + 0.375*y2     + 0.125*y2;
  });
}

// ── Mode toggle ───────────────────────────────────────────
export function enterPinboard() {
  ACTIVE = true;
  TOOL   = 'select';
  document.getElementById('ge').classList.add('hidden');
  document.getElementById('rb').style.display      = 'none';
  document.getElementById('bc').style.display      = 'none';
  document.getElementById('pinboard-overlay').style.display = '';
  // Sync toolbar button state
  setTool('select');
  rebuild();
  fitAll();
}

export function exitPinboard() {
  ACTIVE     = false;
  ARROW_SRC  = null;
  GROUP_RECT = null;
  document.getElementById('pinboard-overlay').style.display = 'none';
}

// ── Fit ───────────────────────────────────────────────────
export function fitAll() {
  if (!initRefs() || !NODES.length) { schedDraw(); return; }
  const W = CV.clientWidth, H = CV.clientHeight;
  const xs = NODES.map(n => n.x),  xe = NODES.map(n => n.x + n.w);
  const ys = NODES.map(n => n.y),  ye = NODES.map(n => n.y + nodeH(n));
  const minX = Math.min(...xs) - 40, maxX = Math.max(...xe) + 40;
  const minY = Math.min(...ys) - 40, maxY = Math.max(...ye) + 40;
  const sW = maxX - minX, sH = maxY - minY;
  const z  = Math.min(3, Math.max(0.08, Math.min(W / sW, H / sH)));
  ZOOM  = z;
  PAN.x = (W - sW * z) / 2 - minX * z;
  PAN.y = (H - sH * z) / 2 - minY * z;
  schedDraw();
}

// ── Persist positions back to PINS ────────────────────────
function savePositions() {
  NODES.forEach(n => { PINS.node_positions[n.id] = { x: n.x, y: n.y }; });
}

// ── Unpin ─────────────────────────────────────────────────
function unpinNode(key) {
  removePin(key);
  rebuild();
  updatePinBadge();
}

// ── Spatial hit tests ──────────────────────────────────────
function hitNode(cx, cy) {
  const wx = (cx - PAN.x) / ZOOM, wy = (cy - PAN.y) / ZOOM;
  for (let i = NODES.length - 1; i >= 0; i--) {
    const n = NODES[i];
    if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + nodeH(n)) return n;
  }
  return null;
}

function hitGroup(cx, cy) {
  // Only the header bar (top 28px)
  const wx = (cx - PAN.x) / ZOOM, wy = (cy - PAN.y) / ZOOM;
  for (let i = GROUPS.length - 1; i >= 0; i--) {
    const g = GROUPS[i];
    if (wx >= g.x && wx <= g.x + g.w && wy >= g.y && wy <= g.y + 28) return g;
  }
  return null;
}

function hitGroupBody(cx, cy) {
  const wx = (cx - PAN.x) / ZOOM, wy = (cy - PAN.y) / ZOOM;
  for (let i = GROUPS.length - 1; i >= 0; i--) {
    const g = GROUPS[i];
    if (wx >= g.x && wx <= g.x + g.w && wy >= g.y && wy <= g.y + g.h) return g;
  }
  return null;
}

function hitArrowDelete(cx, cy) {
  // Check if click lands on arrow's × midpoint button
  const wx = (cx - PAN.x) / ZOOM, wy = (cy - PAN.y) / ZOOM;
  for (let i = ARROWS.length - 1; i >= 0; i--) {
    const a = ARROWS[i];
    if (a._midX == null) continue;
    const dx = wx - a._midX, dy = wy - a._midY;
    if (Math.sqrt(dx*dx + dy*dy) <= (a._r || 8)) return a;
  }
  return null;
}

// ── Arrow tool first-click: returns {type, id} or null ────
function hitArrowSource(cx, cy) {
  const node = hitNode(cx, cy);
  if (node) return { type: 'node', id: node.id, node };
  const grp  = hitGroupBody(cx, cy);
  if (grp)  return { type: 'group', id: grp.id, grp };
  return null;
}

// ── Mouse event helpers ───────────────────────────────────
function getPos(e) {
  const r = CV.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// ── Mouse down: dispatch by tool ──────────────────────────
function onMouseDown(e) {
  if (!ACTIVE) return;
  e.stopPropagation();
  if (e.button !== 0) return;
  const pos = getPos(e);

  if (TOOL === 'unpin') {
    const node = hitNode(pos.x, pos.y);
    if (node) { unpinNode(node.id); }
    return;
  }

  if (TOOL === 'arrow') {
    // Check if clicking the × on an existing arrow
    const arrowDel = hitArrowDelete(pos.x, pos.y);
    if (arrowDel) {
      PINS.pin_arrows = PINS.pin_arrows.filter(a => a.id !== arrowDel.id);
      ARROWS          = JSON.parse(JSON.stringify(PINS.pin_arrows));
      ARROW_SRC = null;
      schedDraw();
      return;
    }

    if (!ARROW_SRC) {
      // First click: pick source
      const src = hitArrowSource(pos.x, pos.y);
      if (src) {
        ARROW_SRC = src;
        schedDraw();
      }
    } else {
      // Second click: pick target (node or group, different from source)
      const node = hitNode(pos.x, pos.y);
      const grp  = hitGroupBody(pos.x, pos.y);
      const tgt  = node || grp;
      if (tgt) {
        const tgtType = node ? 'node' : 'group';
        const tgtId   = tgt.id || tgt.id;
        if (!(tgtType === ARROW_SRC.type && tgtId === ARROW_SRC.id)) {
          PINS.pin_arrows.push({
            id: uid(),
            fromType: ARROW_SRC.type,
            fromId:   ARROW_SRC.id,
            toType:   tgtType,
            toId:     node ? node.id : grp.id,
          });
          ARROWS = JSON.parse(JSON.stringify(PINS.pin_arrows));
        }
        ARROW_SRC = null;
        schedDraw();
      } else {
        // Clicked empty space → spawn a callout note at cursor with arrow from source
        const wx = (pos.x - PAN.x) / ZOOM, wy = (pos.y - PAN.y) / ZOOM;
        const noteW = 240, noteH = 120;
        const capturedSrc = ARROW_SRC;
        ARROW_SRC = null;
        schedDraw();
        // Open group editor; on confirm the arrow is also created
        showGroupEditor(null, wx - noteW / 2, wy - noteH / 2, noteW, noteH, capturedSrc);
      }
    }
    return;
  }

  if (TOOL === 'group') {
    // Start drawing a rectangle
    const wx = (pos.x - PAN.x) / ZOOM, wy = (pos.y - PAN.y) / ZOOM;
    GROUP_RECT = { sx: wx, sy: wy, x: wx, y: wy, w: 0, h: 0 };
    DRAG = { type: 'group-draw', startPos: pos };
    return;
  }

  // SELECT tool
  // Check node first
  const node = hitNode(pos.x, pos.y);
  if (node) {
    DRAG = { type: 'node', node, sx: pos.x, sy: pos.y, ox: node.x, oy: node.y, moved: false };
    return;
  }
  // Then group header
  const group = hitGroup(pos.x, pos.y);
  if (group) {
    DRAG = { type: 'group', group, sx: pos.x, sy: pos.y, ox: group.x, oy: group.y, moved: false };
    return;
  }
  // Check arrow × button
  const arrowDel = hitArrowDelete(pos.x, pos.y);
  if (arrowDel) {
    PINS.pin_arrows = PINS.pin_arrows.filter(a => a.id !== arrowDel.id);
    ARROWS          = JSON.parse(JSON.stringify(PINS.pin_arrows));
    schedDraw();
    return;
  }
  // Pan
  DRAG = { type: 'pan', sx: pos.x, sy: pos.y, px: PAN.x, py: PAN.y };
  CV.style.cursor = 'grabbing';
}

function onMouseMove(e) {
  if (!ACTIVE) return;
  const pos = getPos(e);

  // Arrow tool: show live cursor line from source
  if (TOOL === 'arrow' && ARROW_SRC) {
    _arrowMousePos = { x: (pos.x - PAN.x) / ZOOM, y: (pos.y - PAN.y) / ZOOM };
    schedDraw();
  }

  if (DRAG) {
    if (DRAG.type === 'group-draw') {
      const wx = (pos.x - PAN.x) / ZOOM, wy = (pos.y - PAN.y) / ZOOM;
      GROUP_RECT.x = Math.min(GROUP_RECT.sx, wx);
      GROUP_RECT.y = Math.min(GROUP_RECT.sy, wy);
      GROUP_RECT.w = Math.abs(wx - GROUP_RECT.sx);
      GROUP_RECT.h = Math.abs(wy - GROUP_RECT.sy);
      schedDraw();
      return;
    }

    if (DRAG.type === 'node') {
      const dx = (pos.x - DRAG.sx) / ZOOM, dy = (pos.y - DRAG.sy) / ZOOM;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) DRAG.moved = true;
      if (DRAG.moved) {
        DRAG.node.x = DRAG.ox + dx;
        DRAG.node.y = DRAG.oy + dy;
        cacheEdgePaths();
        schedDraw();
      }
    } else if (DRAG.type === 'group') {
      const dx = (pos.x - DRAG.sx) / ZOOM, dy = (pos.y - DRAG.sy) / ZOOM;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) DRAG.moved = true;
      if (DRAG.moved) {
        DRAG.group.x = DRAG.ox + dx;
        DRAG.group.y = DRAG.oy + dy;
        schedDraw();
      }
    } else if (DRAG.type === 'pan') {
      PAN.x = DRAG.px + (pos.x - DRAG.sx);
      PAN.y = DRAG.py + (pos.y - DRAG.sy);
      schedDraw();
    }
    return;
  }

  // Hover highlight
  if (TOOL === 'select') {
    const node   = hitNode(pos.x, pos.y);
    const newHit = node ? node.id : null;
    if (newHit !== HIT) {
      HIT = newHit;
      CV.style.cursor = HIT ? 'pointer' : 'default';
      schedDraw();
    }
  }
}

let _arrowMousePos = null;

function onMouseUp(e) {
  if (!ACTIVE) return;

  if (DRAG?.type === 'group-draw') {
    // Finish group rectangle
    const rect = GROUP_RECT;
    GROUP_RECT = null;
    DRAG = null;
    if (rect && rect.w > 40 && rect.h > 40) {
      // Open editor with the drawn rect dimensions
      showGroupEditor(null, rect.x, rect.y, rect.w, rect.h);
    }
    schedDraw();
    return;
  }

  if (DRAG) {
    if (DRAG.type === 'node') {
      if (!DRAG.moved) {
        // single click on node in select mode — no-op
      } else {
        savePositions();
      }
    }
    if (DRAG.type === 'group' && DRAG.moved) {
      const g  = DRAG.group;
      const pg = PINS.pin_groups.find(p => p.id === g.id);
      if (pg) { pg.x = g.x; pg.y = g.y; }
    }
    DRAG = null;
  }

  // Restore cursor
  if (TOOL === 'select') CV.style.cursor = HIT ? 'pointer' : 'default';
}

function onDblClick(e) {
  if (!ACTIVE) return;
  e.stopPropagation();
  if (TOOL !== 'select') return;
  const pos  = getPos(e);
  // Double-click group body → edit
  const grp = hitGroupBody(pos.x, pos.y);
  if (grp) {
    showGroupEditor(grp);
    return;
  }
  // Double-click node → expand/collapse
  const node = hitNode(pos.x, pos.y);
  if (node) {
    node._hcache = null;
    cacheEdgePaths();
    schedDraw();
  }
}

// ── Events ────────────────────────────────────────────────
export function initPinboardEvents() {
  initRefs();
  CV.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  CV.addEventListener('dblclick', onDblClick);

  CV.addEventListener('wheel', e => {
    if (!ACTIVE) return;
    e.preventDefault();
    const pos = getPos(e);
    const nz  = Math.min(3, Math.max(0.05, ZOOM * (e.deltaY > 0 ? 0.85 : 1.18)));
    PAN.x = pos.x - (pos.x - PAN.x) * (nz / ZOOM);
    PAN.y = pos.y - (pos.y - PAN.y) * (nz / ZOOM);
    ZOOM  = nz;
    schedDraw();
  }, { passive: false });

  // Toolbar buttons wired here
  const toolBtns = ['select','group','arrow','unpin'];
  toolBtns.forEach(t => {
    const btn = document.getElementById('pb-tool-' + t);
    if (btn) btn.addEventListener('click', () => setTool(t));
  });

  // Escape cancels arrow source selection / group draw
  window.addEventListener('keydown', e => {
    if (!ACTIVE) return;
    if (e.key === 'Escape') {
      ARROW_SRC  = null;
      GROUP_RECT = null;
      if (TOOL !== 'select') setTool('select');
      schedDraw();
    }
  });
}

// ── Group editor modal ─────────────────────────────────────
const GROUP_COLORS = [
  '#f59e0b22', '#22c55e22', '#3b82f622', '#a855f722',
  '#ef444422', '#06b6d422', '#ec489922',
];
const GROUP_BORDER = [
  '#f59e0b', '#22c55e', '#3b82f6', '#a855f7',
  '#ef4444', '#06b6d4', '#ec4899',
];

function showGroupEditor(existingGroup, initX, initY, initW, initH, arrowSrc = null) {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:950;
    display:flex;align-items:center;justify-content:center;
  `;
  const box = document.createElement('div');
  box.style.cssText = `
    background:var(--p2);border:1px solid var(--b2);border-radius:12px;
    padding:20px 24px;width:340px;box-shadow:0 24px 64px rgba(0,0,0,.8);
  `;
  const colorIdx = existingGroup
    ? GROUP_COLORS.indexOf(existingGroup.color)
    : 0;

  box.innerHTML = `
    <div style="font-size:13px;font-weight:600;color:var(--t);margin-bottom:14px">
      ${existingGroup ? 'Edit Group' : arrowSrc ? '📝 New Callout Note' : 'New Sticky Group'}
    </div>
    <div style="font-size:11px;color:var(--t3);margin-bottom:4px">Title</div>
    <input id="ge-title" type="text" value="${existingGroup?.title || ''}"
      placeholder="${arrowSrc ? 'Note title…' : 'Group title…'}"
      style="width:100%;margin-bottom:10px;font-family:var(--font)"/>
    <div style="font-size:11px;color:var(--t3);margin-bottom:4px">Note</div>
    <textarea id="ge-note"
      placeholder="${arrowSrc ? 'Your annotation or callout text…' : 'Notes, ideas, reminders…'}"
      style="width:100%;min-height:70px;resize:vertical;font-family:var(--font);font-size:12px;margin-bottom:12px">${existingGroup?.note || ''}</textarea>
    <div style="font-size:11px;color:var(--t3);margin-bottom:6px">Color</div>
    <div id="ge-colors" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px"></div>
    ${existingGroup ? `
    <button id="ge-delete" style="
      width:100%;margin-bottom:10px;padding:7px;font-size:12px;
      background:rgba(239,68,68,.1);border:1px solid #ef4444;border-radius:6px;
      color:#ef4444;cursor:pointer
    ">Delete Group</button>` : ''}
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button id="ge-cancel" class="bsm">Cancel</button>
      <button id="ge-ok" class="bsolve" style="width:auto;padding:8px 18px">
        ${existingGroup ? 'Save' : arrowSrc ? 'Add Note' : 'Add'}
      </button>
    </div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let selectedColor = Math.max(0, colorIdx);
  const colDiv = box.querySelector('#ge-colors');
  GROUP_COLORS.forEach((c, i) => {
    const sw = document.createElement('div');
    sw.style.cssText = `width:22px;height:22px;border-radius:50%;cursor:pointer;
      background:${GROUP_BORDER[i]};border:3px solid ${i === selectedColor ? 'var(--t)' : 'transparent'};
      transition:border-color .1s`;
    sw.addEventListener('click', () => {
      selectedColor = i;
      colDiv.querySelectorAll('div').forEach((el, j) => {
        el.style.borderColor = j === selectedColor ? 'var(--t)' : 'transparent';
      });
    });
    colDiv.appendChild(sw);
  });

  box.querySelector('#ge-cancel').addEventListener('click', () => overlay.remove());

  if (existingGroup) {
    box.querySelector('#ge-delete')?.addEventListener('click', () => {
      PINS.pin_groups  = PINS.pin_groups.filter(g => g.id !== existingGroup.id);
      PINS.pin_arrows  = PINS.pin_arrows.filter(a => a.fromId !== existingGroup.id);
      GROUPS           = JSON.parse(JSON.stringify(PINS.pin_groups));
      ARROWS           = JSON.parse(JSON.stringify(PINS.pin_arrows));
      schedDraw();
      overlay.remove();
    });
  }

  box.querySelector('#ge-ok').addEventListener('click', () => {
    const title  = box.querySelector('#ge-title').value.trim() || 'Note';
    const note   = box.querySelector('#ge-note').value.trim();
    const color  = GROUP_COLORS[selectedColor];
    const border = GROUP_BORDER[selectedColor];

    if (existingGroup) {
      existingGroup.title  = title;
      existingGroup.note   = note;
      existingGroup.color  = color;
      existingGroup.border = border;
      const pg = PINS.pin_groups.find(g => g.id === existingGroup.id);
      if (pg) { pg.title = title; pg.note = note; pg.color = color; pg.border = border; }
    } else {
      const g = {
        id: uid(), title, note,
        x: initX ?? 100, y: initY ?? 100,
        w: initW ?? 320, h: initH ?? 200,
        color, border,
      };
      PINS.pin_groups.push(g);
      GROUPS.push(JSON.parse(JSON.stringify(g)));

      // If spawned from an arrow-to-empty-space action, wire the arrow
      if (arrowSrc) {
        PINS.pin_arrows.push({
          id: uid(),
          fromType: arrowSrc.type,
          fromId:   arrowSrc.id,
          toType:   'group',
          toId:     g.id,
        });
        ARROWS = JSON.parse(JSON.stringify(PINS.pin_arrows));
      }
    }
    GROUPS = JSON.parse(JSON.stringify(PINS.pin_groups));
    schedDraw();
    overlay.remove();
  });

  // Focus title input
  setTimeout(() => box.querySelector('#ge-title')?.focus(), 50);
}

// ── Draw ──────────────────────────────────────────────────
export function draw() {
  if (!ACTIVE || !initRefs()) return;
  try { _draw(); } catch (err) { console.error('Pinboard draw error:', err); }
}

// ── Viewport culling ─────────────────────────────────────
function pbViewportBounds(W, H, margin = 60) {
  return {
    x1: (-PAN.x / ZOOM) - margin,
    y1: (-PAN.y / ZOOM) - margin,
    x2: (-PAN.x + W) / ZOOM + margin,
    y2: (-PAN.y + H) / ZOOM + margin,
  };
}
function pbNodeInView(n, vp) {
  const h = nodeH(n);
  return n.x + n.w >= vp.x1 && n.x <= vp.x2 &&
         n.y + h   >= vp.y1 && n.y <= vp.y2;
}
function pbGroupInView(g, vp) {
  return g.x + g.w >= vp.x1 && g.x <= vp.x2 &&
         g.y + g.h >= vp.y1 && g.y <= vp.y2;
}
function pbEdgeInView(e, vp) {
  if (e._x1 == null) return false;
  const minX = Math.min(e._x1, e._x2), maxX = Math.max(e._x1, e._x2);
  const minY = Math.min(e._y1, e._y2), maxY = Math.max(e._y1, e._y2);
  return maxX >= vp.x1 && minX <= vp.x2 && maxY >= vp.y1 && minY <= vp.y2;
}

function _draw() {
  const W = CV.clientWidth, H = CV.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  C.setTransform(dpr, 0, 0, dpr, 0, 0);
  C.clearRect(0, 0, W, H);
  C.fillStyle = '#0c0e13';
  C.fillRect(0, 0, W, H);

  // Dot grid
  const gs = 24 * ZOOM, dotR = 0.75;
  const ox = ((PAN.x % gs) + gs) % gs, oy = ((PAN.y % gs) + gs) % gs;
  C.fillStyle = 'rgba(39,45,61,0.75)';
  for (let gx = ox; gx < W; gx += gs)
    for (let gy = oy; gy < H; gy += gs) {
      C.beginPath(); C.arc(gx, gy, dotR, 0, Math.PI * 2); C.fill();
    }

  C.save();
  C.translate(PAN.x, PAN.y);
  C.scale(ZOOM, ZOOM);

  const vp = pbViewportBounds(W, H);

  // Groups behind everything — cull off-screen groups
  GROUPS.forEach(g => { if (pbGroupInView(g, vp)) drawGroup(g); });

  // User-drawn arrows (always draw — they span between nodes, bounds complex)
  drawArrows();

  // Item-flow edges — cull off-screen edges
  EDGES.forEach(e => { if (pbEdgeInView(e, vp)) drawEdge(e); });

  // Nodes — cull off-screen nodes
  NODES.forEach(n => { if (pbNodeInView(n, vp)) drawPinNode(n); });

  // Group-draw rectangle being dragged
  if (GROUP_RECT && GROUP_RECT.w > 0) {
    C.strokeStyle = '#f59e0b';
    C.lineWidth   = 2 / ZOOM;
    C.setLineDash([8 / ZOOM, 5 / ZOOM]);
    C.strokeRect(GROUP_RECT.x, GROUP_RECT.y, GROUP_RECT.w, GROUP_RECT.h);
    C.setLineDash([]);
    C.fillStyle = 'rgba(245,158,11,0.06)';
    C.fillRect(GROUP_RECT.x, GROUP_RECT.y, GROUP_RECT.w, GROUP_RECT.h);
  }

  // Arrow tool: live line from source to mouse
  if (TOOL === 'arrow' && ARROW_SRC && _arrowMousePos) {
    let sx, sy;
    if (ARROW_SRC.type === 'node') {
      const n = NODES.find(n => n.id === ARROW_SRC.id);
      if (n) { sx = n.x + n.w / 2; sy = n.y + nodeH(n) / 2; }
    } else {
      const g = GROUPS.find(g => g.id === ARROW_SRC.id);
      if (g) { sx = g.x + g.w / 2; sy = g.y + g.h / 2; }
    }
    if (sx != null) {
      C.beginPath();
      C.moveTo(sx, sy);
      C.lineTo(_arrowMousePos.x, _arrowMousePos.y);
      C.strokeStyle = '#f59e0b';
      C.lineWidth   = 2 / ZOOM;
      C.setLineDash([6 / ZOOM, 4 / ZOOM]);
      C.stroke();
      C.setLineDash([]);
    }
  }

  // Empty state
  if (!NODES.length) {
    C.restore();
    C.save();
    C.fillStyle = 'rgba(97,104,128,0.6)';
    C.font = '13px Inter,sans-serif';
    C.textAlign = 'center'; C.textBaseline = 'middle';
    C.fillText('No pinned recipes yet — pin some from the recipe lookup (📌)', W / 2, H / 2);
    C.restore();
    return;
  }

  C.restore();

  // Arrow-mode indicator: highlight source node/group with a ring
  if (TOOL === 'arrow' && ARROW_SRC) {
    C.save();
    C.translate(PAN.x, PAN.y);
    C.scale(ZOOM, ZOOM);
    C.strokeStyle = '#f59e0b';
    C.lineWidth   = 3 / ZOOM;
    C.setLineDash([6 / ZOOM, 4 / ZOOM]);
    if (ARROW_SRC.type === 'node') {
      const n = NODES.find(n => n.id === ARROW_SRC.id);
      if (n) { rPath(n.x - 3, n.y - 3, n.w + 6, nodeH(n) + 6, 12); C.stroke(); }
    } else {
      const g = GROUPS.find(g => g.id === ARROW_SRC.id);
      if (g) { rPath(g.x - 3, g.y - 3, g.w + 6, g.h + 6, 12); C.stroke(); }
    }
    C.setLineDash([]);
    C.restore();
  }
}

// ── Draw group sticky note ─────────────────────────────────
function drawGroup(g) {
  const border = g.border || '#f59e0b';
  const fill   = g.color  || '#f59e0b22';

  C.fillStyle = 'rgba(0,0,0,0.3)';
  rPath(g.x + 3, g.y + 3, g.w, g.h, 10); C.fill();

  C.fillStyle = fill;
  rPath(g.x, g.y, g.w, g.h, 10); C.fill();
  C.strokeStyle = border;
  C.lineWidth = 1.5 / ZOOM;
  rPath(g.x, g.y, g.w, g.h, 10); C.stroke();

  C.fillStyle = border + '33';
  rPathTop(g.x, g.y, g.w, 28, 10); C.fill();

  C.font = `bold 10px Inter,sans-serif`;
  C.fillStyle = border;
  C.textAlign = 'left'; C.textBaseline = 'middle';
  C.fillText('⠿', g.x + 8, g.y + 14);

  C.font      = `600 11px Inter,sans-serif`;
  C.fillStyle = border;
  C.textAlign = 'center'; C.textBaseline = 'middle';
  C.fillText(measureTrunc(g.title || 'Group', g.w - 50), g.x + g.w / 2 + 8, g.y + 14);

  // Double-click-to-edit hint (small, subtle)
  C.font      = '9px Inter,sans-serif';
  C.fillStyle = border + '66';
  C.textAlign = 'right'; C.textBaseline = 'middle';
  C.fillText('dbl-click to edit', g.x + g.w - 8, g.y + 14);

  if (g.note) {
    C.font      = '11px Inter,sans-serif';
    C.fillStyle = 'rgba(232,234,240,0.7)';
    C.textAlign = 'left'; C.textBaseline = 'top';
    wrapText(g.note, g.x + 10, g.y + 36, g.w - 20, 15);
  }

  C.textAlign = 'left'; C.textBaseline = 'alphabetic';
}

function wrapText(text, x, y, maxW, lineH) {
  const words = text.split(' ');
  let line = '', curY = y;
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (C.measureText(test).width > maxW && line) {
      C.fillText(line, x, curY);
      curY += lineH; line = word;
    } else { line = test; }
  }
  if (line) C.fillText(line, x, curY);
}

// ── Draw user arrows ──────────────────────────────────────
function drawArrows() {
  const nodeMap  = Object.fromEntries(NODES.map(n => [n.id, n]));
  const groupMap = Object.fromEntries(GROUPS.map(g => [g.id, g]));

  ARROWS.forEach(a => {
    // Support both old and new arrow schema
    const fromId   = a.fromId   || a.fromGroup;
    const fromType = a.fromType  || 'group';
    const toId     = a.toId     || a.toNode;
    const toType   = a.toType   || 'node';

    let sx, sy, ex, ey, border = '#f59e0b';

    if (fromType === 'node') {
      const n = nodeMap[fromId];
      if (!n) return;
      sx = n.x + n.w / 2; sy = n.y + nodeH(n) / 2;
      border = mCol(RECIPES[fromId]?.machine || '') || '#f59e0b';
    } else {
      const g = groupMap[fromId];
      if (!g) return;
      sx = g.x + g.w / 2; sy = g.y + g.h;
      border = g.border || '#f59e0b';
    }

    if (toType === 'node') {
      const n = nodeMap[toId];
      if (!n) return;
      ex = n.x; ey = n.y + nodeH(n) / 2;
    } else {
      const g = groupMap[toId];
      if (!g) return;
      ex = g.x + g.w / 2; ey = g.y;
    }

    C.beginPath();
    C.moveTo(sx, sy);
    const cy1 = sy + (ey - sy) * 0.5;
    const cy2 = ey - (ey - sy) * 0.3;
    C.bezierCurveTo(sx, cy1, ex, cy2, ex, ey);
    C.strokeStyle = border + 'cc';
    C.lineWidth = 2 / ZOOM;
    C.setLineDash([]);
    C.stroke();

    const ang = Math.atan2(ey - cy2, ex - sx);
    const al  = 10 / ZOOM, aw = 5 / ZOOM;
    const ax  = ex - Math.cos(ang) * al, ay = ey - Math.sin(ang) * al;
    C.beginPath();
    C.moveTo(ex, ey);
    C.lineTo(ax - Math.sin(ang) * aw, ay + Math.cos(ang) * aw);
    C.lineTo(ax + Math.sin(ang) * aw, ay - Math.cos(ang) * aw);
    C.closePath();
    C.fillStyle = border;
    C.fill();

    // × delete button at midpoint
    const midX = (sx + ex) / 2, midY = (sy + ey) / 2;
    const r    = 8 / ZOOM;
    C.fillStyle = '#0c0e13'; C.beginPath(); C.arc(midX, midY, r, 0, Math.PI*2); C.fill();
    C.strokeStyle = border; C.lineWidth = 1 / ZOOM; C.beginPath(); C.arc(midX, midY, r, 0, Math.PI*2); C.stroke();
    C.fillStyle = border;
    C.font = `bold ${Math.max(8, 11 / ZOOM)}px Inter,sans-serif`;
    C.textAlign = 'center'; C.textBaseline = 'middle';
    C.fillText('×', midX, midY);
    a._midX = midX; a._midY = midY; a._r = r;
  });
  C.textAlign = 'left'; C.textBaseline = 'alphabetic';
}

// ── Draw edge (item flow) ─────────────────────────────────
function drawEdge(e) {
  if (e._x1 == null) return;
  C.beginPath();
  C.moveTo(e._x1, e._y1);
  C.bezierCurveTo(e._cx1, e._cy1, e._cx2, e._cy2, e._x2, e._y2);
  C.strokeStyle = e.color + '99';
  C.lineWidth   = 1.5 / ZOOM;
  C.setLineDash([]);
  C.stroke();

  const ang = Math.atan2(e._y2 - e._cy2, e._x2 - e._cx2);
  const al  = 7 / ZOOM, aw = 3.5 / ZOOM;
  const ax  = e._x2 - Math.cos(ang) * al, ay = e._y2 - Math.sin(ang) * al;
  C.beginPath();
  C.moveTo(e._x2, e._y2);
  C.lineTo(ax - Math.sin(ang) * aw, ay + Math.cos(ang) * aw);
  C.lineTo(ax + Math.sin(ang) * aw, ay - Math.cos(ang) * aw);
  C.closePath();
  C.fillStyle = e.color + '99';
  C.fill();

  if (ZOOM >= 0.35) {
    const lbl = `${itemName(e.item)}  ${Number(e.rate).toFixed(1)}/m`;
    const fs  = 10;
    C.font    = `${fs}px 'JetBrains Mono',monospace`;
    const tw  = C.measureText(lbl).width;
    const pad = 4;
    C.fillStyle = 'rgba(25,29,40,0.92)';
    C.fillRect(e._mx - tw / 2 - pad, e._my - fs * 0.72 - pad / 2, tw + pad * 2, fs + pad);
    C.fillStyle    = e.color;
    C.textAlign    = 'center'; C.textBaseline = 'middle';
    C.fillText(lbl, e._mx, e._my);
    C.textAlign    = 'left'; C.textBaseline = 'alphabetic';
  }
}

// ── Draw pinned recipe node ────────────────────────────────
function drawPinNode(n) {
  const { x, y, w } = n;
  const h     = nodeH(n);
  const r     = RECIPES[n.id];
  const hover = HIT === n.id;
  // Highlight if it's the arrow source
  const isArrowSrc = TOOL === 'arrow' && ARROW_SRC?.id === n.id;
  if (!r) return;

  const color = mCol(r.machine);

  C.fillStyle = 'rgba(0,0,0,0.4)';
  rPath(x + 2, y + 2, w, h, 10); C.fill();

  C.fillStyle = '#191d28';
  rPath(x, y, w, h, 10); C.fill();

  C.strokeStyle = isArrowSrc ? '#f59e0b' : hover ? '#9aa0b4' : color + '88';
  C.lineWidth   = isArrowSrc ? 2.5 : hover ? 2 : 1.5;
  C.setLineDash([6, 4]);
  rPath(x, y, w, h, 10); C.stroke();
  C.setLineDash([]);

  C.fillStyle = color + 'bb';
  rPathTop(x, y, w, 3, 3); C.fill();

  // Tool-mode badge in top right (instead of 📌 in unpin mode)
  if (TOOL === 'unpin') {
    C.font = '10px sans-serif';
    C.textAlign = 'right'; C.textBaseline = 'top';
    C.fillStyle = '#ef4444';
    C.fillText('✕', x + w - 8, y + 8);
    C.textAlign = 'left'; C.textBaseline = 'alphabetic';
  } else {
    C.font = '10px sans-serif';
    C.textAlign = 'right'; C.textBaseline = 'top';
    C.fillText('📌', x + w - 8, y + 8);
    C.textAlign = 'left'; C.textBaseline = 'alphabetic';
  }

  let cy = y + 12;

  C.font = 'bold 9px JetBrains Mono,monospace';
  const abbr  = MABBR[r.machine] || r.machine;
  const abbrW = C.measureText(abbr).width + 12;
  C.fillStyle = color + '33'; rPath(x + 10, cy, abbrW, 15, 3); C.fill();
  C.strokeStyle = color + '66'; C.lineWidth = 0.5; rPath(x + 10, cy, abbrW, 15, 3); C.stroke();
  C.fillStyle = color; C.textAlign = 'center'; C.textBaseline = 'middle';
  C.fillText(abbr, x + 10 + abbrW / 2, cy + 7.5);
  C.textAlign = 'left'; C.textBaseline = 'alphabetic';

  if (r.alternate) {
    C.font = 'bold 8px JetBrains Mono,monospace';
    const ax2 = x + 10 + abbrW + 6;
    C.fillStyle = 'rgba(245,158,11,.15)'; rPath(ax2, cy, 24, 15, 3); C.fill();
    C.strokeStyle = '#f59e0b'; C.lineWidth = 0.5; rPath(ax2, cy, 24, 15, 3); C.stroke();
    C.fillStyle = '#f59e0b'; C.textAlign = 'center'; C.textBaseline = 'middle';
    C.fillText('ALT', ax2 + 12, cy + 7.5);
    C.textAlign = 'left'; C.textBaseline = 'alphabetic';
  }

  cy += 20;
  const cleanName = r.display.replace(/\(Alt\)/g, '').replace(/^Alternate:\s*/i, '').trim();
  C.font = '600 12px Inter,sans-serif'; C.fillStyle = '#e8eaf0'; C.textBaseline = 'middle';
  C.fillText(measureTrunc(cleanName, w - 22), x + 10, cy + 7);
  cy += 16;

  C.font = '10px JetBrains Mono,monospace'; C.fillStyle = '#616880';
  C.fillText(r.machine.replace(/_/g, ' '), x + 10, cy + 7);
  cy += 16;

  C.fillStyle = '#1f2435'; C.fillRect(x, cy, w, STATS_H);
  C.strokeStyle = '#272d3d'; C.lineWidth = 0.5;
  C.beginPath(); C.moveTo(x, cy); C.lineTo(x + w, cy); C.stroke();
  C.font = '10px JetBrains Mono,monospace'; C.fillStyle = '#616880'; C.textBaseline = 'middle';
  let sx2 = x + 7;
  const stat = (t, col) => { C.fillStyle = col; C.fillText(t, sx2, cy + STATS_H / 2); sx2 += C.measureText(t).width + 7; };
  stat('⚡ ' + (r.power_mw_base != null ? r.power_mw_base + ' MW' : '—'), '#fb923c');
  stat('× ' + Object.keys(r.outputs || {}).length + ' out', color);
  cy += STATS_H;

  const divider = label => {
    C.strokeStyle = '#272d3d'; C.lineWidth = 0.5;
    C.beginPath(); C.moveTo(x, cy); C.lineTo(x + w, cy); C.stroke();
    C.font = '9px Inter,sans-serif'; C.fillStyle = '#616880'; C.textBaseline = 'middle';
    C.fillText(label.toUpperCase(), x + 10, cy + DIV_H / 2);
    C.textBaseline = 'alphabetic'; cy += DIV_H;
  };
  const ioRow = (label, rate, lc) => {
    C.font = '11px Inter,sans-serif'; C.fillStyle = lc; C.textBaseline = 'middle';
    C.fillText(measureTrunc(label, w - 85), x + 12, cy + IO_H / 2);
    C.font = '10px JetBrains Mono,monospace'; C.fillStyle = '#9aa0b4';
    C.textAlign = 'right'; C.fillText(`${Number(rate).toFixed(1)}/m`, x + w - 8, cy + IO_H / 2);
    C.textAlign = 'left'; C.textBaseline = 'alphabetic'; cy += IO_H;
  };

  const ins  = Object.entries(r.inputs  || {});
  const outs = Object.entries(r.outputs || {});
  if (ins.length)  { divider('Inputs');  ins.forEach(([k, rv]) => ioRow('← ' + itemName(k), rv, '#9aa0b4')); }
  if (outs.length) { divider('Outputs'); outs.forEach(([k, rv]) => ioRow('→ ' + itemName(k), rv, '#22c55e')); }

  C.fillStyle = color + 'aa'; C.strokeStyle = '#191d28'; C.lineWidth = 2;
  circleFill(x,     y + h / 2, 5); C.fill(); C.stroke();
  circleFill(x + w, y + h / 2, 5); C.fill(); C.stroke();
}

// ── Canvas helpers ────────────────────────────────────────
function rPath(x, y, w, h, r) {
  C.beginPath();
  C.moveTo(x + r, y);
  C.lineTo(x + w - r, y); C.arcTo(x + w, y, x + w, y + r, r);
  C.lineTo(x + w, y + h - r); C.arcTo(x + w, y + h, x + w - r, y + h, r);
  C.lineTo(x + r, y + h); C.arcTo(x, y + h, x, y + h - r, r);
  C.lineTo(x, y + r); C.arcTo(x, y, x + r, y, r);
  C.closePath();
}

function rPathTop(x, y, w, h, r) {
  C.beginPath();
  C.moveTo(x + r, y);
  C.lineTo(x + w - r, y); C.arcTo(x + w, y, x + w, y + r, r);
  C.lineTo(x + w, y + h);
  C.lineTo(x, y + h);
  C.lineTo(x, y + r); C.arcTo(x, y, x + r, y, r);
  C.closePath();
}

function circleFill(x, y, r) {
  C.beginPath(); C.arc(x, y, r, 0, Math.PI * 2);
}

function measureTrunc(text, maxPx) {
  if (!text) return '';
  if (C.measureText(text).width <= maxPx) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (C.measureText(text.slice(0, mid) + '…').width <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + (lo < text.length ? '…' : '');
}

function uid() { return Math.random().toString(36).slice(2, 10); }

// ── Badge update ──────────────────────────────────────────
export function updatePinBadge() {
  const badge = document.getElementById('pin-badge');
  const count = (PINS.pinned_recipes || []).length;
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? '' : 'none';
  }
}

// ── Resize ────────────────────────────────────────────────
export function resize() {
  if (!ACTIVE) return;
  const dpr  = window.devicePixelRatio || 1;
  const rect = CV.parentElement.getBoundingClientRect();
  C.setTransform(1, 0, 0, 1, 0, 0);
  CV.width  = rect.width  * dpr;
  CV.height = rect.height * dpr;
  CV.style.width  = rect.width  + 'px';
  CV.style.height = rect.height + 'px';
  C.scale(dpr, dpr);
  schedDraw();
}
