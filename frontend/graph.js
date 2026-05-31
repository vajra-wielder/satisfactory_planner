/**
 * graph.js — Canvas-based DAG graph renderer.
 *
 * Fixes vs previous version:
 *  - Empty-state overlay hidden properly when result has nodes
 *  - Text measured with C.measureText() before drawing; truncated to fit exactly
 *  - Edge labels show actual FLOW rate (consuming recipe's input rate) not output rate
 *  - Clip region applied per node so text never bleeds outside
 *  - Resize resets CTX transform correctly (no accumulated scale)
 */

import { RESULT, mCol, MABBR, itemName } from './state.js';

const CV  = document.getElementById('gc');
const C   = CV.getContext('2d');
const GE  = document.getElementById('ge');  // empty-state overlay

// ── Viewport state ────────────────────────────────────────
let PAN  = { x: 0, y: 0 };
let ZOOM = 1;

// ── Scene state ───────────────────────────────────────────
let NODES = [];   // { id, x, y, w, h, type, data, expanded }
let EDGES = [];   // { src, tgt, item, rate, color, dashed }
let DRAG  = null;
let PANSTART = null;
let HIT   = null; // hovered node id

// ── DPI-aware resize ──────────────────────────────────────
let lastDpr = 1;
export function resize() {
  const dpr  = window.devicePixelRatio || 1;
  const rect = CV.parentElement.getBoundingClientRect();
  // Reset transform before resizing to avoid compounding
  C.setTransform(1, 0, 0, 1, 0, 0);
  CV.width  = rect.width  * dpr;
  CV.height = rect.height * dpr;
  CV.style.width  = rect.width  + 'px';
  CV.style.height = rect.height + 'px';
  C.scale(dpr, dpr);
  lastDpr = dpr;
  draw();
}
window.addEventListener('resize', resize);

// ── Node sizing ───────────────────────────────────────────
const NW       = 256;
const NH_BASE  = 118;  // header + stats bar (no IOs)
const IO_H     = 18;
const DIV_H    = 15;
const STATS_H  = 20;

function nodeH(node) {
  if (node.type !== 'recipe') return 54;
  const f   = node.data;
  const ins  = Object.keys(f.inputs  || {}).length;
  const outs = Object.keys(f.outputs || {}).length;
  // header sections: badge row(20) + name(16) + machines(16) + stats(STATS_H)
  // IO dividers + rows
  const ioPart = (ins  > 0 ? DIV_H + ins  * IO_H : 0)
               + (outs > 0 ? DIV_H + outs * IO_H : 0);
  const base = 20 + 16 + 16 + STATS_H + ioPart + 10; // +10 bottom pad
  if (!node.expanded) return base;
  const opts = (f.layout_options || []).length;
  return base + 14 + opts * 28 + 16;
}

// ── Layout ────────────────────────────────────────────────
export function initLayout() {
  NODES = [];
  EDGES = [];
  if (!RESULT?.flows?.length) {
    GE.classList.remove('hidden');
    draw();
    return;
  }
  GE.classList.add('hidden');

  const flows   = RESULT.flows;
  const flowMap = Object.fromEntries(flows.map(f => [f.recipe_key, f]));

  // Build producer/consumer maps across recipe flows
  const producers = {}, consumers = {};
  flows.forEach(f => {
    Object.keys(f.outputs || {}).forEach(item => {
      (producers[item] = producers[item] || []).push(f.recipe_key);
    });
    Object.keys(f.inputs || {}).forEach(item => {
      (consumers[item] = consumers[item] || []).push(f.recipe_key);
    });
  });

  // ── 1. Rank assignment — longest path from raw-resource inputs ────────────
  // A recipe's rank = 1 + max rank of any recipe that feeds into it.
  // Items that come only from source_nodes (not from any recipe) have rank -1.
  const rank = {};
  flows.forEach(f => rank[f.recipe_key] = 0);
  for (let it = 0; it < 40; it++) {
    let changed = false;
    flows.forEach(f => {
      let maxR = 0;
      Object.keys(f.inputs || {}).forEach(item => {
        const prods = (producers[item] || []).filter(k => k !== f.recipe_key);
        if (prods.length) maxR = Math.max(maxR, ...prods.map(k => (rank[k] ?? 0) + 1));
        // If item comes purely from source_nodes, it contributes rank 0 (no +1)
      });
      if (maxR !== rank[f.recipe_key]) { rank[f.recipe_key] = maxR; changed = true; }
    });
    if (!changed) break;
  }

  // Group recipes into layers by rank
  const byRank = {};
  flows.forEach(f => {
    const r = rank[f.recipe_key] ?? 0;
    (byRank[r] = byRank[r] || []).push(f.recipe_key);
  });
  const layerKeys = Object.keys(byRank).sort((a, b) => +a - +b);
  // layers[i] = array of recipe_key strings at that rank
  const layers = layerKeys.map(r => byRank[r]);

  // ── 2. Crossing reduction — Sugiyama barycenter heuristic ────────────────
  // For each layer (left→right), sort nodes by the median Y-position of their
  // left neighbours. Repeat right→left then left→right a few times.
  // We start with a stable initial order based on topological sort output.
  // Positions start uniform — we only have heights after node objects exist,
  // so we use index-based barycenter first, then refine after Y assignment.

  // Build adjacency: for each recipe key, which recipe keys feed into it?
  const prevOf = {}; // key → [keys that are in earlier layers and connect to key]
  const nextOf = {}; // key → [keys that are in later layers and key connects to]
  flows.forEach(f => {
    Object.keys(f.inputs || {}).forEach(item => {
      (producers[item] || []).filter(p => p !== f.recipe_key && rank[p] < rank[f.recipe_key])
        .forEach(p => {
          (prevOf[f.recipe_key] = prevOf[f.recipe_key] || []).push(p);
          (nextOf[p] = nextOf[p] || []).push(f.recipe_key);
        });
    });
  });

  function barycenterSort(layer, posOf) {
    return [...layer].sort((a, b) => {
      const pa = prevOf[a] || [];
      const pb = prevOf[b] || [];
      const ya = pa.length ? pa.reduce((s, k) => s + (posOf[k] ?? 0), 0) / pa.length : posOf[a] ?? 0;
      const yb = pb.length ? pb.reduce((s, k) => s + (posOf[k] ?? 0), 0) / pb.length : posOf[b] ?? 0;
      return ya - yb;
    });
  }

  // Initial position estimate: uniform spacing within each layer
  const posOf = {}; // key → estimated Y centre
  layers.forEach(layer => {
    layer.forEach((key, i) => { posOf[key] = i; });
  });

  // Run 4 passes of barycenter ordering (alternating direction)
  for (let pass = 0; pass < 4; pass++) {
    const fwd = pass % 2 === 0;
    (fwd ? layers : [...layers].reverse()).forEach(layer => {
      const sorted = barycenterSort(layer, posOf);
      sorted.forEach((key, i) => {
        layer[i] = key;
        posOf[key] = i;
      });
    });
  }

  // ── 3. Assign pixel positions ─────────────────────────────────────────────
  const XGAP = 170, YGAP = 44;
  const SRC_W = 165, SRC_H = 54;

  // First pass: create node objects with correct heights
  let curX = SRC_W + 40; // leave room for source column on the left
  const posMap = {};

  layers.forEach(layer => {
    // Compute total height of this layer to centre it vertically
    const tempNodes = layer.map(key => {
      const f = flowMap[key];
      const n = { id: key, x: 0, y: 0, w: NW, h: 0, type: 'recipe', data: f, expanded: false };
      n.h = nodeH(n);
      return n;
    });
    const totalH = tempNodes.reduce((s, n) => s + n.h, 0) + YGAP * (tempNodes.length - 1);
    let curY = 60;  // top margin; we'll centre after knowing the tallest layer

    tempNodes.forEach(n => {
      n.x = curX;
      n.y = curY;
      NODES.push(n);
      posMap[n.id] = n;
      curY += n.h + YGAP;
    });
    curX += NW + XGAP;
  });

  // Vertically centre each layer relative to the tallest one
  const colMaxBottom = {};
  layers.forEach((layer, li) => {
    let bot = 0;
    layer.forEach(k => { const n = posMap[k]; bot = Math.max(bot, n.y + n.h); });
    colMaxBottom[li] = bot;
  });
  const globalBottom = Math.max(...Object.values(colMaxBottom), 1);

  layers.forEach((layer, li) => {
    const bot = colMaxBottom[li];
    const shift = (globalBottom - bot) / 2;
    if (shift > 1) layer.forEach(k => { posMap[k].y += shift; });
  });

  // Second pass: refine Y order using actual node heights (barycenter by pixel midY)
  for (let pass = 0; pass < 3; pass++) {
    const fwd = pass % 2 === 0;
    (fwd ? layers : [...layers].reverse()).forEach(layer => {
      // Compute barycenter using actual pixel midY of predecessor nodes
      const withBC = layer.map(key => {
        const preds = prevOf[key] || [];
        const bc = preds.length
          ? preds.reduce((s, k) => s + (posMap[k] ? posMap[k].y + posMap[k].h / 2 : 0), 0) / preds.length
          : (posMap[key]?.y ?? 0);
        return { key, bc };
      }).sort((a, b) => a.bc - b.bc);

      // Reassign Y positions maintaining gaps
      let curY = Math.min(...layer.map(k => posMap[k]?.y ?? 0));
      // Anchor to topmost node's current position to avoid drift
      curY = Math.max(60, curY);
      withBC.forEach(({ key }, i) => {
        layer[i] = key;
        const n = posMap[key];
        if (n) {
          n.y = curY;
          curY += n.h + YGAP;
        }
      });
    });
  }

  // ── 4. Source nodes — placed left of their first consuming recipe ─────────
  // Each source node Y is aligned to the average midY of its consuming recipes.
  const rightX = curX; // where sink/error/surplus nodes go
  let srcColX = 20;    // X for source column

  // Compute the actual flow consumed from each source item per recipe
  // (the consuming recipe's input rate — NOT the full available rate)
  const srcActualRate = {}; // item -> total actually consumed across all recipes
  Object.keys(RESULT.source_nodes || {}).forEach(item => {
    let total = 0;
    (consumers[item] || []).forEach(k => {
      const f = flowMap[k];
      if (f && f.inputs[item] != null) total += f.inputs[item];
    });
    srcActualRate[item] = total > 0 ? total : (RESULT.source_nodes[item] || 0);
  });

  Object.entries(RESULT.source_nodes || {}).forEach(([item, _available]) => {
    const cons = (consumers[item] || []).filter(k => posMap[k]);
    // Y: align to the median midY of all recipes consuming this resource
    let nodeY;
    if (cons.length) {
      const midYs = cons.map(k => posMap[k].y + posMap[k].h / 2).sort((a, b) => a - b);
      const mid   = Math.floor(midYs.length / 2);
      nodeY = midYs[mid] - SRC_H / 2;
    } else {
      nodeY = 60;
    }
    const node = {
      id: 'SRC_' + item, x: srcColX, y: nodeY, w: SRC_W, h: SRC_H,
      type: 'source', data: { item, rate: srcActualRate[item] },
    };
    NODES.push(node);
    posMap['SRC_' + item] = node;
  });

  // Resolve vertical overlaps in source column
  const srcNodes = NODES.filter(n => n.type === 'source').sort((a, b) => a.y - b.y);
  for (let i = 1; i < srcNodes.length; i++) {
    const prev = srcNodes[i - 1], cur = srcNodes[i];
    if (cur.y < prev.y + prev.h + 12) cur.y = prev.y + prev.h + 12;
  }

  // ── 5. Sink / error / surplus nodes — right column ────────────────────────
  let ry = 60;
  const addRight = (id, type, item, rate) => {
    const node = { id, x: rightX, y: ry, w: SRC_W, h: SRC_H, type, data: { item, rate } };
    NODES.push(node); posMap[id] = node; ry += SRC_H + 12;
  };
  Object.entries(RESULT.sink_nodes            || {}).forEach(([i, r]) => addRight('SNK_'    + i, 'sink',        i, r));
  Object.entries(RESULT.error_sinks           || {}).forEach(([i, r]) => addRight('ERRSNK_' + i, 'errorsink',   i, r));
  Object.entries(RESULT.surplus_intermediates || {}).forEach(([i, r]) => addRight('SURP_'   + i, 'surplus',     i, r));
  Object.entries(RESULT.error_sources         || {}).forEach(([i, r]) => addRight('ERRSRC_' + i, 'errorsource', i, r));

  // ── 6. Build edges ────────────────────────────────────────────────────────
  function addEdge(src, tgt, item, rate, color, dashed = false) {
    if (!posMap[src] || !posMap[tgt]) return;
    EDGES.push({ src, tgt, item, rate, color, dashed });
  }

  // BUG FIX: source → recipe edges use the CONSUMING recipe's actual input rate,
  // not the available resource quantity (which may be larger than what's used).
  Object.entries(RESULT.source_nodes || {}).forEach(([item]) => {
    (consumers[item] || []).filter(k => posMap[k]).forEach(k => {
      const consumedRate = flowMap[k]?.inputs[item] ?? 0;
      addEdge('SRC_' + item, k, item, consumedRate, '#cbd5e1');
    });
  });

  // Recipe → recipe: consumer's actual input rate
  flows.forEach(tgtFlow => {
    Object.entries(tgtFlow.inputs || {}).forEach(([item, consumedRate]) => {
      (producers[item] || [])
        .filter(srcKey => srcKey !== tgtFlow.recipe_key && posMap[srcKey])
        .forEach(srcKey => {
          addEdge(srcKey, tgtFlow.recipe_key, item, consumedRate, mCol(flowMap[srcKey]?.machine));
        });
    });
  });

  // Recipe → sink
  Object.entries(RESULT.sink_nodes || {}).forEach(([item, qty]) => {
    (producers[item] || []).filter(k => posMap[k])
      .forEach(k => addEdge(k, 'SNK_' + item, item, qty, mCol(flowMap[k]?.machine)));
  });

  // Recipe → error sink (dashed red)
  Object.entries(RESULT.error_sinks || {}).forEach(([item, qty]) => {
    (producers[item] || []).filter(k => posMap[k])
      .forEach(k => addEdge(k, 'ERRSNK_' + item, item, qty, '#ef4444', true));
  });

  // Recipe → surplus (dashed amber)
  Object.entries(RESULT.surplus_intermediates || {}).forEach(([item, qty]) => {
    (producers[item] || []).filter(k => posMap[k])
      .forEach(k => addEdge(k, 'SURP_' + item, item, qty, '#f59e0b', true));
  });

  // Error source → recipe (dashed red)
  Object.entries(RESULT.error_sources || {}).forEach(([item, qty]) => {
    (consumers[item] || []).filter(k => posMap[k])
      .forEach(k => addEdge('ERRSRC_' + item, k, item, qty, '#ef4444', true));
  });

  fitAll();
}

// ── Fit all nodes in viewport ─────────────────────────────
export function fitAll() {
  if (!NODES.length) { PAN = { x: 0, y: 0 }; ZOOM = 1; draw(); return; }
  const W = CV.clientWidth || 800, H = CV.clientHeight || 600;
  const minX = Math.min(...NODES.map(n => n.x));
  const minY = Math.min(...NODES.map(n => n.y));
  const maxX = Math.max(...NODES.map(n => n.x + n.w));
  const maxY = Math.max(...NODES.map(n => n.y + n.h));
  const pad = 60, bw = maxX - minX, bh = maxY - minY;
  ZOOM = Math.min(2.5, Math.max(0.05,
    Math.min((W - pad * 2) / bw, (H - pad * 2) / bh)
  ));
  PAN.x = (W - bw * ZOOM) / 2 - minX * ZOOM;
  PAN.y = (H - bh * ZOOM) / 2 - minY * ZOOM;
  draw();
}

export function zoomBy(f) {
  const W = CV.clientWidth / 2, H = CV.clientHeight / 2;
  const nz = Math.min(3, Math.max(0.05, ZOOM * f));
  PAN.x = W - (W - PAN.x) * (nz / ZOOM);
  PAN.y = H - (H - PAN.y) * (nz / ZOOM);
  ZOOM = nz;
  draw();
}

// ── Main draw ──────────────────────────────────────────────
export function draw() {
  const W = CV.clientWidth, H = CV.clientHeight;
  C.setTransform(lastDpr, 0, 0, lastDpr, 0, 0);
  C.clearRect(0, 0, W, H);
  C.fillStyle = '#0c0e13';
  C.fillRect(0, 0, W, H);

  // Dot grid
  const gs = 24 * ZOOM, dotR = 0.8;
  const ox = ((PAN.x % gs) + gs) % gs;
  const oy = ((PAN.y % gs) + gs) % gs;
  C.fillStyle = 'rgba(39,45,61,0.8)';
  for (let gx = ox; gx < W; gx += gs)
    for (let gy = oy; gy < H; gy += gs) {
      C.beginPath(); C.arc(gx, gy, dotR, 0, Math.PI * 2); C.fill();
    }

  if (!NODES.length) return;

  C.save();
  C.translate(PAN.x, PAN.y);
  C.scale(ZOOM, ZOOM);

  const nodeMap = Object.fromEntries(NODES.map(n => [n.id, n]));
  EDGES.forEach(e => drawEdge(e, nodeMap));
  NODES.forEach(n => { n.h = nodeH(n); drawNode(n); });

  C.restore();
}

// ── Edge drawing ──────────────────────────────────────────
function drawEdge(e, nodeMap) {
  const sn = nodeMap[e.src], tn = nodeMap[e.tgt];
  if (!sn || !tn) return;
  const x1 = sn.x + sn.w, y1 = sn.y + nodeH(sn) / 2;
  const x2 = tn.x,         y2 = tn.y + nodeH(tn) / 2;

  // Control points: horizontal when edge goes left→right, arc wide when going
  // same-column or backwards so the curve stays readable.
  const dx   = x2 - x1;
  const span = Math.max(Math.abs(dx), 80);  // minimum span for control handles
  const cx1  = x1 + span * 0.45;
  const cx2  = x2 - span * 0.45;

  C.beginPath();
  C.moveTo(x1, y1);
  C.bezierCurveTo(cx1, y1, cx2, y2, x2, y2);
  C.strokeStyle = e.color;
  C.lineWidth   = 1.6 / ZOOM;
  C.globalAlpha = 0.82;
  C.setLineDash(e.dashed ? [5 / ZOOM, 3 / ZOOM] : []);
  C.stroke();
  C.setLineDash([]);
  C.globalAlpha = 1;

  // Arrow head at target
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const al  = 7 / ZOOM, aw = 3.5 / ZOOM;
  const ax  = x2 - Math.cos(ang) * al, ay = y2 - Math.sin(ang) * al;
  C.beginPath();
  C.moveTo(x2, y2);
  C.lineTo(ax - Math.sin(ang) * aw, ay + Math.cos(ang) * aw);
  C.lineTo(ax + Math.sin(ang) * aw, ay - Math.cos(ang) * aw);
  C.closePath();
  C.fillStyle = e.color;
  C.fill();

  // Label at midpoint of the bezier (approx t=0.5)
  const mx  = 0.125*x1 + 0.375*cx1 + 0.375*cx2 + 0.125*x2;
  const my  = 0.125*y1 + 0.375*y1  + 0.375*y2  + 0.125*y2;
  const lbl = `${itemName(e.item)}  ${Number(e.rate).toFixed(1)}/m`;
  const fs  = Math.max(8, 10 / ZOOM);
  C.font    = `${fs}px 'JetBrains Mono',monospace`;
  const tw  = C.measureText(lbl).width;
  const pad = 4 / ZOOM;
  C.fillStyle = 'rgba(25,29,40,0.9)';
  C.fillRect(mx - tw / 2 - pad, my - fs * 0.72 - pad / 2, tw + pad * 2, fs + pad);
  C.fillStyle    = e.color;
  C.textAlign    = 'center';
  C.textBaseline = 'middle';
  C.fillText(lbl, mx, my);
  C.textAlign    = 'left';
  C.textBaseline = 'alphabetic';
}

// ── Node drawing ──────────────────────────────────────────
function drawNode(n) {
  const { x, y, w, type, data } = n;
  const h = nodeH(n);

  if (type === 'source')      return drawSpecNode(n, '#1a1f2e', '#cbd5e1', 'RESOURCE INPUT', true);
  if (type === 'sink')        return drawSpecNode(n, '#0f2318', '#4ade80', 'OUTPUT',          false);
  if (type === 'errorsink')   return drawSpecNode(n, '#1c0a0a', '#ef4444', '⚠ BYPRODUCT',    false);
  if (type === 'errorsource') return drawSpecNode(n, '#1c0a0a', '#ef4444', '⚠ MISSING',      true);
  if (type === 'surplus')     return drawSpecNode(n, '#1c1400', '#f59e0b', 'SURPLUS',         false);

  // ── Recipe node ──────────────────────────────────────────
  const f     = data;
  const color = mCol(f.machine);
  const hover = HIT === n.id;

  // Clip everything to node bounds so no text escapes
  C.save();
  C.beginPath();
  roundRect(x, y, w, h, 10);
  C.clip();

  // Shadow
  C.fillStyle = 'rgba(0,0,0,0.38)';
  roundRectFill(x + 2, y + 2, w, h, 10);

  // Body
  C.fillStyle   = '#191d28';
  roundRectFill(x, y, w, h, 10);
  C.strokeStyle = hover ? '#f59e0b' : '#323a50';
  C.lineWidth   = hover ? 2 : 1;
  roundRectStroke(x, y, w, h, 10);

  // Top colour bar
  C.fillStyle = color;
  roundRectFill(x, y, w, 3, 2);

  let cy = y + 12;

  // -- Badge row --
  C.font = 'bold 9px JetBrains Mono,monospace';
  const abbr  = MABBR[f.machine] || f.machine;
  const abbrW = C.measureText(abbr).width + 12;
  // Machine badge
  C.fillStyle   = color + '33';
  roundRectFill(x + 10, cy, abbrW, 15, 3);
  C.strokeStyle = color + '66';
  C.lineWidth   = 0.5;
  roundRectStroke(x + 10, cy, abbrW, 15, 3);
  C.fillStyle    = color;
  C.textAlign    = 'center';
  C.textBaseline = 'middle';
  C.fillText(abbr, x + 10 + abbrW / 2, cy + 7.5);
  C.textAlign    = 'left';
  C.textBaseline = 'alphabetic';

  // Alt badge
  const isAlt = f.display.includes('(Alt)') || f.display.startsWith('Alternate:');
  if (isAlt) {
    C.font = 'bold 8px JetBrains Mono,monospace';
    const altX = x + 10 + abbrW + 6;
    C.fillStyle = 'rgba(245,158,11,.15)';
    roundRectFill(altX, cy, 24, 15, 3);
    C.strokeStyle = '#f59e0b';
    C.lineWidth   = 0.5;
    roundRectStroke(altX, cy, 24, 15, 3);
    C.fillStyle    = '#f59e0b';
    C.textAlign    = 'center';
    C.textBaseline = 'middle';
    C.fillText('ALT', altX + 12, cy + 7.5);
    C.textAlign    = 'left';
    C.textBaseline = 'alphabetic';
  }

  // Indicator dots (top-right)
  let dotX = x + w - 9;
  if (f.has_sloop) {
    C.fillStyle = '#a855f7';
    circleFill(dotX, cy + 7, 4);
    dotX -= 12;
  }
  if (f.has_shard) {
    C.fillStyle = '#3b82f6';
    circleFill(dotX, cy + 7, 4);
  }

  cy += 20;

  // -- Recipe name --
  const cleanName = f.display.replace(/\(Alt\)/g, '').replace(/^Alternate:\s*/i, '').trim();
  C.font      = '600 12px Inter,sans-serif';
  C.fillStyle = '#e8eaf0';
  C.textBaseline = 'middle';
  C.fillText(measureTrunc(cleanName, w - 22), x + 10, cy + 7);
  cy += 16;

  // -- Machine count --
  C.font      = '10px JetBrains Mono,monospace';
  C.fillStyle = '#616880';
  C.fillText(
    `${f.machines_final} machine${f.machines_final !== 1 ? 's' : ''} (${f.machines_float.toFixed(2)} LP)`,
    x + 10, cy + 7
  );
  cy += 16;

  // -- Stats bar --
  C.fillStyle = '#1f2435';
  C.fillRect(x, cy, w, STATS_H);
  C.strokeStyle = '#272d3d';
  C.lineWidth   = 0.5;
  C.beginPath(); C.moveTo(x, cy); C.lineTo(x + w, cy); C.stroke();

  const clk    = f.clock_pct ?? 100;
  const clkCol = clk > 100.1 ? '#fb923c' : clk < 99.9 ? '#38bdf8' : '#616880';
  C.font         = '10px JetBrains Mono,monospace';
  C.textBaseline = 'middle';
  let sx = x + 7;
  const statTxt = (t, fill) => {
    C.fillStyle = fill;
    C.fillText(t, sx, cy + STATS_H / 2);
    sx += C.measureText(t).width + 7;
  };
  statTxt(`⏱${clk.toFixed(1)}%`, clkCol);
  statTxt(`⚡${f.power_mw.toFixed(0)}MW`, '#fb923c');
  if (f.has_shard) statTxt(`💎${Math.round((f.shards_used) / (f.machines_final || 1))}/m`, '#3b82f6');
  if (f.has_sloop) statTxt(`🔮×${(f.output_multiplier || 1).toFixed(2)}`, '#a855f7');

  // Expand hint (right-aligned)
  C.fillStyle    = '#616880';
  C.textAlign    = 'right';
  C.textBaseline = 'middle';
  C.fillText(n.expanded ? '▲' : '▼', x + w - 7, cy + STATS_H / 2);
  C.textAlign    = 'left';
  C.textBaseline = 'alphabetic';
  cy += STATS_H;

  // -- IO rows --
  const divider = (label) => {
    C.strokeStyle = '#272d3d'; C.lineWidth = 0.5;
    C.beginPath(); C.moveTo(x, cy); C.lineTo(x + w, cy); C.stroke();
    C.font         = '9px Inter,sans-serif';
    C.fillStyle    = '#616880';
    C.textBaseline = 'middle';
    C.fillText(label.toUpperCase(), x + 10, cy + DIV_H / 2);
    C.textBaseline = 'alphabetic';
    cy += DIV_H;
  };

  const ioRow = (label, rate, lc) => {
    C.font         = '11px Inter,sans-serif';
    C.fillStyle    = lc;
    C.textBaseline = 'middle';
    C.fillText(measureTrunc(label, w - 85), x + 12, cy + IO_H / 2);
    C.font      = '10px JetBrains Mono,monospace';
    C.fillStyle = '#9aa0b4';
    C.textAlign = 'right';
    C.fillText(`${Number(rate).toFixed(1)}/m`, x + w - 8, cy + IO_H / 2);
    C.textAlign    = 'left';
    C.textBaseline = 'alphabetic';
    cy += IO_H;
  };

  const ins  = Object.entries(f.inputs  || {});
  const outs = Object.entries(f.outputs || {});
  if (ins.length)  { divider('Inputs');  ins.forEach(([k, r]) => ioRow('← ' + itemName(k), r, '#9aa0b4')); }
  if (outs.length) {
    divider('Outputs' + (f.has_sloop ? ` ×${(f.output_multiplier || 1).toFixed(2)}` : ''));
    outs.forEach(([k, r]) => ioRow('→ ' + itemName(k), r, '#22c55e'));
  }

  // -- Layout options (expanded) --
  if (n.expanded && f.layout_options?.length) {
    C.strokeStyle = '#272d3d'; C.lineWidth = 0.5;
    C.beginPath(); C.moveTo(x, cy); C.lineTo(x + w, cy); C.stroke();
    cy += 4;
    C.font         = '9px Inter,sans-serif';
    C.fillStyle    = '#616880';
    C.textBaseline = 'middle';
    C.fillText('INTEGER LAYOUT OPTIONS', x + 10, cy + 7);
    cy += 14; C.textBaseline = 'alphabetic';

    f.layout_options.forEach(opt => {
      const chosen = f.has_shard ? opt.machines === f.machines_final : opt.shards_needed === 0;
      C.fillStyle = chosen ? 'rgba(245,158,11,.1)' : '#1f2435';
      roundRectFill(x + 6, cy, w - 12, 24, 4);
      C.strokeStyle = chosen ? '#f59e0b' : '#272d3d';
      C.lineWidth   = 0.5;
      roundRectStroke(x + 6, cy, w - 12, 24, 4);
      C.font         = '11px JetBrains Mono,monospace';
      C.fillStyle    = chosen ? '#f59e0b' : '#9aa0b4';
      C.textBaseline = 'middle';
      C.fillText(measureTrunc(opt.label, w - 72), x + 10, cy + 12);
      C.fillStyle = '#fb923c'; C.textAlign = 'right';
      C.fillText(`${opt.power_mw.toFixed(0)} MW`, x + w - 10, cy + 12);
      C.textAlign    = 'left';
      C.textBaseline = 'alphabetic';
      cy += 28;
    });
    C.font         = '9px Inter,sans-serif';
    C.fillStyle    = '#616880';
    C.textBaseline = 'middle';
    C.fillText('Highlighted = chosen. Click to collapse.', x + 10, cy + 7);
    cy += 12;
    C.textBaseline = 'alphabetic';
  }

  C.restore(); // end clip

  // Handles (drawn outside clip so they sit on the border)
  C.fillStyle   = color;
  C.strokeStyle = '#191d28';
  C.lineWidth   = 2;
  circleFill(x,     y + h / 2, 5); C.fill(); C.stroke();
  circleFill(x + w, y + h / 2, 5); C.fill(); C.stroke();
}

function drawSpecNode(n, bg, border, title, isSource) {
  const { x, y, w, h, data } = n;
  const item = data.item, rate = data.rate;

  C.save();
  C.beginPath(); roundRect(x, y, w, h, 8); C.clip();

  C.fillStyle = 'rgba(0,0,0,0.3)'; roundRectFill(x + 1, y + 1, w, h, 8);
  C.fillStyle = bg; roundRectFill(x, y, w, h, 8);
  C.strokeStyle = border; C.lineWidth = 2; roundRectStroke(x, y, w, h, 8);

  C.textAlign = 'center'; C.textBaseline = 'middle';

  C.font      = '9px Inter,sans-serif';
  C.fillStyle = border;
  C.fillText(title, x + w / 2, y + 13);

  C.font      = '600 12px Inter,sans-serif';
  C.fillStyle = '#f1f5f9';
  C.fillText(measureTrunc(itemName(item), w - 10, 'center'), x + w / 2, y + 30);

  C.font      = '11px JetBrains Mono,monospace';
  C.fillStyle = border;
  C.fillText(`${Number(rate).toFixed(1)}/min`, x + w / 2, y + 44);

  C.textAlign    = 'left';
  C.textBaseline = 'alphabetic';
  C.restore();

  C.fillStyle   = border;
  C.strokeStyle = bg;
  C.lineWidth   = 2;
  if (isSource) { circleFill(x + w, y + h / 2, 5); }
  else          { circleFill(x,     y + h / 2, 5); }
  C.fill(); C.stroke();
}

// ── Canvas helpers ────────────────────────────────────────
function rPath(x, y, w, h, r) {
  C.beginPath();
  C.moveTo(x + r, y);
  C.lineTo(x + w - r, y); C.arcTo(x + w, y,     x + w, y + r,     r);
  C.lineTo(x + w, y + h - r); C.arcTo(x + w, y + h, x + w - r, y + h, r);
  C.lineTo(x + r, y + h); C.arcTo(x,     y + h, x,     y + h - r, r);
  C.lineTo(x, y + r); C.arcTo(x, y, x + r, y, r);
  C.closePath();
}
function roundRect(x, y, w, h, r)       { rPath(x, y, w, h, r); }
function roundRectFill(x, y, w, h, r)   { rPath(x, y, w, h, r); C.fill(); }
function roundRectStroke(x, y, w, h, r) { rPath(x, y, w, h, r); C.stroke(); }
function circleFill(x, y, r) { C.beginPath(); C.arc(x, y, r, 0, Math.PI * 2); }

/**
 * measureTrunc(text, maxPx) — truncates `text` so it fits within `maxPx` pixels
 * using the *current canvas font* (no estimation, exact measurement).
 */
function measureTrunc(text, maxPx) {
  if (C.measureText(text).width <= maxPx) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (C.measureText(text.slice(0, mid) + '…').width <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + (lo < text.length ? '…' : '');
}

// ── Mouse interaction ─────────────────────────────────────
function getPos(e) {
  const r = CV.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function hitNode(cx, cy) {
  const wx = (cx - PAN.x) / ZOOM, wy = (cy - PAN.y) / ZOOM;
  for (let i = NODES.length - 1; i >= 0; i--) {
    const n = NODES[i];
    if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + nodeH(n)) return n;
  }
  return null;
}

CV.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const pos = getPos(e);
  const node = hitNode(pos.x, pos.y);
  if (node) {
    DRAG = { node, sx: pos.x, sy: pos.y, ox: node.x, oy: node.y, moved: false };
  } else {
    PANSTART = { x: pos.x, y: pos.y, px: PAN.x, py: PAN.y };
    CV.style.cursor = 'grabbing';
  }
});

window.addEventListener('mousemove', e => {
  const pos = getPos(e);
  if (DRAG) {
    const dx = (pos.x - DRAG.sx) / ZOOM, dy = (pos.y - DRAG.sy) / ZOOM;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) DRAG.moved = true;
    if (DRAG.moved) { DRAG.node.x = DRAG.ox + dx; DRAG.node.y = DRAG.oy + dy; draw(); }
    return;
  }
  if (PANSTART) {
    PAN.x = PANSTART.px + (pos.x - PANSTART.x);
    PAN.y = PANSTART.py + (pos.y - PANSTART.y);
    draw();
    return;
  }
  const node  = hitNode(pos.x, pos.y);
  const newHit = node ? node.id : null;
  if (newHit !== HIT) {
    HIT = newHit;
    CV.style.cursor = HIT ? 'pointer' : 'default';
    draw();
  }
});

window.addEventListener('mouseup', e => {
  if (DRAG) {
    if (!DRAG.moved && DRAG.node.type === 'recipe') {
      DRAG.node.expanded = !DRAG.node.expanded;
      draw();
    }
    DRAG = null;
  }
  PANSTART = null;
  CV.style.cursor = HIT ? 'pointer' : 'default';
});

CV.addEventListener('wheel', e => {
  e.preventDefault();
  const pos   = getPos(e);
  const delta = e.deltaY > 0 ? 0.85 : 1.18;
  const nz    = Math.min(3, Math.max(0.05, ZOOM * delta));
  PAN.x = pos.x - (pos.x - PAN.x) * (nz / ZOOM);
  PAN.y = pos.y - (pos.y - PAN.y) * (nz / ZOOM);
  ZOOM  = nz;
  draw();
}, { passive: false });
