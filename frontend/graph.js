/**
 * graph.js — Canvas DAG renderer, v2
 *
 * Layout: full Sugiyama pipeline
 *   1. Longest-path rank assignment
 *   2. Barycenter crossing reduction (4 alternating passes)
 *   3. Brandes-Köpf-inspired coordinate assignment with compaction
 *   4. Collision resolution sweeps
 *   5. Edge-aware vertical spacing (fan-out scaling)
 *   6. Multi-column source placement (aligned to consuming recipes)
 *   7. Vertical centring per layer
 *
 * Navigation: pan, zoom, drag, double-click-centre, Ctrl+F search
 *
 * Focus mode: click recipe node → upstream/downstream chains glow,
 *   edges along the chain pulse, everything else fades
 *
 * Performance: spatial hash O(1) hit test, cached node heights,
 *   edge geometry rebuilt only on layout change
 */

import { RESULT, mCol, MABBR, itemName } from './state.js';
import { isPinboardActive } from './pinboard.js';

// ── Canvas refs (lazy — resolved on first use, not at module parse time) ──────
let CV = null, C = null, GE = null;
function initCanvasRefs() {
  if (CV) return true;
  CV = document.getElementById('gc');
  GE = document.getElementById('ge');
  if (!CV || !GE) return false;
  C = CV.getContext('2d');
  return true;
}

// ── Viewport ──────────────────────────────────────────────
let PAN  = { x: 0, y: 0 };
let ZOOM = 1;
let lastDpr = 1;

// ── Scene ─────────────────────────────────────────────────
let NODES   = [];  // {id, x, y, w, h, type, data, expanded, _hcache}
let EDGES   = [];  // {src, tgt, item, rate, color, dashed, _path}
let NODEMAP = {};  // id → node  (rebuilt each layout)
let SPATGRID = null; // spatial hash

// ── Interaction state ─────────────────────────────────────
let DRAG     = null;   // {node, sx, sy, ox, oy, moved}
let PANSTART = null;   // {x,y,px,py}
let HIT      = null;   // hovered node id
let FOCUSED  = null;   // focused node id (click to focus)
let FOCUS_UP = new Set();  // upstream ids of focused node
let FOCUS_DN = new Set();  // downstream ids of focused node

// ── Animation ────────────────────────────────────────────
let animFrame = null;
function schedDraw() {
  if (isPinboardActive()) return;
  if (animFrame) return;
  animFrame = requestAnimationFrame(() => { animFrame = null; draw(); });
}

// ── Search ────────────────────────────────────────────────
let searchActive = false;
let searchQuery  = '';
let searchResults = [];  // node ids matching current query
let searchIdx    = 0;

// ── Cached geometry ───────────────────────────────────────
// Edge paths are S-curves; pre-compute once per layout so draw() is fast.
// Stored on each edge as _x1,_y1,_cx1,_cy1,_cx2,_cy2,_x2,_y2

// ── Constants ─────────────────────────────────────────────
const NW      = 258;   // recipe node width
const IO_H    = 18;    // per IO row
const DIV_H   = 15;    // section divider height
const STATS_H = 20;    // stats bar height
const HDR_H   = 20 + 16 + 16; // badge + name + machines rows
const PAD_BOT = 10;
const SRC_W   = 168;
const SRC_H   = 56;
const XGAP    = 175;   // horizontal gap between recipe columns
const YGAP_BASE = 36;  // base vertical gap; scaled by fan-out
const TOP_PAD = 70;

// ── Node height (cached) ──────────────────────────────────
function nodeH(node) {
  if (node.type !== 'recipe') return SRC_H;
  if (node._hcache != null && !node._hcache_exp_dirty) return node._hcache;
  const f    = node.data;
  const ins  = Object.keys(f.inputs  || {}).length;
  const outs = Object.keys(f.outputs || {}).length;
  const ioPart = (ins  > 0 ? DIV_H + ins  * IO_H : 0)
               + (outs > 0 ? DIV_H + outs * IO_H : 0);
  let h = HDR_H + STATS_H + ioPart + PAD_BOT;
  if (node.expanded && f.layout_options?.length) {
    h += 14 + f.layout_options.length * 28 + 16;
  }
  node._hcache = h;
  node._hcache_exp_dirty = false;
  return h;
}

// ── DPI resize ───────────────────────────────────────────
export function resize() {
  if (isPinboardActive()) return;
  if (!initCanvasRefs()) return;
  const dpr  = window.devicePixelRatio || 1;
  const rect = CV.parentElement.getBoundingClientRect();
  C.setTransform(1, 0, 0, 1, 0, 0);
  CV.width  = rect.width  * dpr;
  CV.height = rect.height * dpr;
  CV.style.width  = rect.width  + 'px';
  CV.style.height = rect.height + 'px';
  C.scale(dpr, dpr);
  lastDpr = dpr;
  schedDraw();
}
window.addEventListener('resize', resize);

// ═══════════════════════════════════════════════════════════
// LAYOUT PIPELINE
// ═══════════════════════════════════════════════════════════
export function initLayout() {
  if (isPinboardActive()) return;
  if (!initCanvasRefs()) return;
  NODES = []; EDGES = []; NODEMAP = {};
  SPATGRID = null;
  clearFocus();

  if (!RESULT?.flows?.length) {
    GE.classList.remove('hidden');
    schedDraw();
    return;
  }
  GE.classList.add('hidden');

  const flows   = RESULT.flows;
  const flowMap = Object.fromEntries(flows.map(f => [f.recipe_key, f]));

  const producers = {}, consumers = {};
  flows.forEach(f => {
    Object.keys(f.outputs || {}).forEach(item =>
      (producers[item] = producers[item] || []).push(f.recipe_key));
    Object.keys(f.inputs  || {}).forEach(item =>
      (consumers[item] = consumers[item] || []).push(f.recipe_key));
  });

  // ── 1. Rank assignment ─────────────────────────────────────
  const rank = {};
  flows.forEach(f => rank[f.recipe_key] = 0);
  for (let it = 0; it < 60; it++) {
    let changed = false;
    flows.forEach(f => {
      let maxR = 0;
      Object.keys(f.inputs || {}).forEach(item =>
        (producers[item] || []).filter(k => k !== f.recipe_key)
          .forEach(k => { maxR = Math.max(maxR, (rank[k] ?? 0) + 1); }));
      if (maxR !== rank[f.recipe_key]) { rank[f.recipe_key] = maxR; changed = true; }
    });
    if (!changed) break;
  }

  const byRank = {};
  flows.forEach(f => {
    const r = rank[f.recipe_key] ?? 0;
    (byRank[r] = byRank[r] || []).push(f.recipe_key);
  });
  const layers = Object.keys(byRank).sort((a, b) => +a - +b).map(r => byRank[r]);

  // ── 2. Directed adjacency ──────────────────────────────────
  const prev = {}, next = {};
  flows.forEach(f => {
    Object.keys(f.inputs || {}).forEach(item => {
      (producers[item] || [])
        .filter(p => p !== f.recipe_key && (rank[p] ?? 0) < (rank[f.recipe_key] ?? 0))
        .forEach(p => {
          (prev[f.recipe_key] = prev[f.recipe_key] || []).push(p);
          (next[p] = next[p] || []).push(f.recipe_key);
        });
    });
  });
  Object.keys(prev).forEach(k => { prev[k] = [...new Set(prev[k])]; });
  Object.keys(next).forEach(k => { next[k] = [...new Set(next[k])]; });

  // ── 3. Index-based barycenter (8 passes) ──────────────────
  const posOrd = {};
  layers.forEach(layer => layer.forEach((k, i) => posOrd[k] = i));
  function bcIndex(layer, usePrev) {
    return [...layer].sort((a, b) => {
      const na = (usePrev ? prev[a] : next[a]) || [];
      const nb = (usePrev ? prev[b] : next[b]) || [];
      const ya = na.length ? na.reduce((s, k) => s + (posOrd[k] ?? 0), 0) / na.length : posOrd[a] ?? 0;
      const yb = nb.length ? nb.reduce((s, k) => s + (posOrd[k] ?? 0), 0) / nb.length : posOrd[b] ?? 0;
      return ya - yb;
    });
  }
  for (let pass = 0; pass < 8; pass++) {
    const fwd = pass % 2 === 0;
    (fwd ? layers : [...layers].reverse()).forEach(layer => {
      bcIndex(layer, fwd).forEach((k, i) => { layer[i] = k; posOrd[k] = i; });
    });
  }

  // ── 4. Pixel placement — uniform top-down ─────────────────
  const YGAP = 40;
  let curX = SRC_W + 50;
  const posMap = {};
  layers.forEach(layer => {
    let curY = TOP_PAD;
    layer.forEach(key => {
      const n = { id: key, x: curX, y: curY, w: NW, h: 0,
                  type: 'recipe', data: flowMap[key], expanded: false };
      n.h = nodeH(n);
      NODES.push(n); posMap[key] = n;
      curY += n.h + YGAP;
    });
    curX += NW + XGAP;
  });

  // ── 5. Pixel-accurate barycenter + reassign ────────────────
  function midY(key) { const n = posMap[key]; return n ? n.y + n.h / 2 : 0; }

  function bcPixel(layer, usePrev) {
    return [...layer].sort((a, b) => {
      const na = (usePrev ? prev[a] : next[a]) || [];
      const nb = (usePrev ? prev[b] : next[b]) || [];
      const ya = na.length ? na.reduce((s, k) => s + midY(k), 0) / na.length : midY(a);
      const yb = nb.length ? nb.reduce((s, k) => s + midY(k), 0) / nb.length : midY(b);
      return ya - yb;
    });
  }
  function reassignY(layer) {
    let curY = TOP_PAD;
    layer.forEach(key => { const n = posMap[key]; if (!n) return; n.y = curY; curY += n.h + YGAP; });
  }
  function resolveCollisions(nodeList) {
    const s = [...nodeList].sort((a, b) => a.y - b.y);
    for (let i = 1; i < s.length; i++) {
      const minY = s[i-1].y + s[i-1].h + YGAP;
      if (s[i].y < minY) s[i].y = minY;
    }
    for (let i = s.length - 2; i >= 0; i--) {
      const maxBot = s[i+1].y - YGAP;
      if (s[i].y + s[i].h > maxBot) s[i].y = Math.max(TOP_PAD, maxBot - s[i].h);
    }
  }
  for (let pass = 0; pass < 6; pass++) {
    const fwd = pass % 2 === 0;
    (fwd ? layers : [...layers].reverse()).forEach(layer => {
      bcPixel(layer, fwd).forEach((k, i) => layer[i] = k);
      reassignY(layer);
    });
  }

  // ── 6. Compaction — pull toward neighbour midY ─────────────
  function idealMidY(key) {
    const all = [...(prev[key] || []), ...(next[key] || [])].filter(k => posMap[k]);
    if (!all.length) return null;
    return all.reduce((s, k) => s + midY(k), 0) / all.length;
  }
  for (let pass = 0; pass < 6; pass++) {
    const fwd = pass % 2 === 0;
    (fwd ? layers : [...layers].reverse()).forEach(layer => {
      layer.forEach(key => {
        const n = posMap[key]; if (!n) return;
        const im = idealMidY(key); if (im === null) return;
        n.y = Math.max(TOP_PAD, n.y + (im - n.h / 2 - n.y) * 0.6);
      });
      resolveCollisions(layer.map(k => posMap[k]).filter(Boolean));
    });
  }

  // ── 7. Chain alignment ─────────────────────────────────────
  // A node that has exactly one predecessor, and that predecessor
  // feeds exactly this node (linear chain), is snapped to the same
  // Y-centre as its predecessor. Eliminates staircase patterns.
  function chainAlignFwd() {
    layers.forEach(layer => {
      layer.forEach(key => {
        const ps = prev[key] || [];
        if (ps.length !== 1) return;
        const pKey = ps[0];
        if ((next[pKey] || []).length !== 1) return;
        const n = posMap[key], p = posMap[pKey]; if (!n || !p) return;
        n.y = Math.max(TOP_PAD, p.y + p.h / 2 - n.h / 2);
      });
      resolveCollisions(layer.map(k => posMap[k]).filter(Boolean));
    });
  }
  function chainAlignBwd() {
    [...layers].reverse().forEach(layer => {
      layer.forEach(key => {
        const ns = next[key] || [];
        if (ns.length !== 1) return;
        const nKey = ns[0];
        if ((prev[nKey] || []).length !== 1) return;
        const n = posMap[key], c = posMap[nKey]; if (!n || !c) return;
        n.y = Math.max(TOP_PAD, c.y + c.h / 2 - n.h / 2);
      });
      resolveCollisions(layer.map(k => posMap[k]).filter(Boolean));
    });
  }
  chainAlignFwd();
  chainAlignBwd();
  chainAlignFwd(); // one more fwd pass to propagate bwd corrections

  // ── 8. Global vertical centring ───────────────────────────
  const spans = layers.map(layer => {
    const ns = layer.map(k => posMap[k]).filter(Boolean);
    if (!ns.length) return null;
    return { top: Math.min(...ns.map(n => n.y)), bot: Math.max(...ns.map(n => n.y + n.h)) };
  });
  const validSpans = spans.filter(Boolean);
  let gMidFinal = TOP_PAD;
  if (validSpans.length) {
    const gTop = Math.min(...validSpans.map(s => s.top));
    const gBot = Math.max(...validSpans.map(s => s.bot));
    gMidFinal = (gTop + gBot) / 2;
    layers.forEach((layer, li) => {
      const sp = spans[li]; if (!sp) return;
      const shift = gMidFinal - (sp.top + sp.bot) / 2;
      if (Math.abs(shift) > 2)
        layer.forEach(k => { const n = posMap[k]; if (n) n.y = Math.max(TOP_PAD, n.y + shift); });
    });
  }

  // ── 9. Source nodes ────────────────────────────────────────
  const srcActual = {};
  Object.keys(RESULT.source_nodes || {}).forEach(item => {
    let total = 0;
    (consumers[item] || []).forEach(k => { total += flowMap[k]?.inputs[item] || 0; });
    srcActual[item] = total || RESULT.source_nodes[item];
  });
  Object.entries(RESULT.source_nodes || {}).forEach(([item]) => {
    const cons = (consumers[item] || []).filter(k => posMap[k]);
    let ty;
    if (cons.length === 1) {
      const cn = posMap[cons[0]]; ty = cn.y + cn.h / 2 - SRC_H / 2;
    } else if (cons.length > 1) {
      const mys = cons.map(k => posMap[k].y + posMap[k].h / 2).sort((a, b) => a - b);
      ty = mys[Math.floor(mys.length / 2)] - SRC_H / 2;
    } else { ty = gMidFinal - SRC_H / 2; }
    NODES.push({ id: 'SRC_' + item, x: 20, y: Math.max(TOP_PAD, ty),
                 w: SRC_W, h: SRC_H, type: 'source', data: { item, rate: srcActual[item] } });
    posMap['SRC_' + item] = NODES[NODES.length - 1];
  });
  NODES.filter(n => n.type === 'source').sort((a, b) => a.y - b.y)
    .forEach((n, i, arr) => { if (i > 0 && n.y < arr[i-1].y + arr[i-1].h + 10) n.y = arr[i-1].y + arr[i-1].h + 10; });

  // ── 10. Sink/output nodes — Y-aligned to producers ─────────
  const sinkDefs = [
    ...Object.entries(RESULT.sink_nodes            || {}).map(([i, r]) => ({ id: 'SNK_'    + i, type: 'sink',        item: i, rate: r })),
    ...Object.entries(RESULT.error_sinks           || {}).map(([i, r]) => ({ id: 'ERRSNK_' + i, type: 'errorsink',   item: i, rate: r })),
    ...Object.entries(RESULT.surplus_intermediates || {}).map(([i, r]) => ({ id: 'SURP_'   + i, type: 'surplus',     item: i, rate: r })),
    ...Object.entries(RESULT.error_sources         || {}).map(([i, r]) => ({ id: 'ERRSRC_' + i, type: 'errorsource', item: i, rate: r })),
  ];
  sinkDefs.forEach(({ id, type, item, rate }) => {
    const related = (type === 'errorsource' ? consumers[item] : producers[item] || []).filter(k => posMap[k]);
    let ty;
    if (related.length === 1) {
      const rn = posMap[related[0]]; ty = rn.y + rn.h / 2 - SRC_H / 2;
    } else if (related.length > 1) {
      const mys = related.map(k => posMap[k].y + posMap[k].h / 2).sort((a, b) => a - b);
      ty = mys[Math.floor(mys.length / 2)] - SRC_H / 2;
    } else { ty = gMidFinal - SRC_H / 2; }
    const n = { id, x: curX, y: Math.max(TOP_PAD, ty), w: SRC_W, h: SRC_H, type, data: { item, rate } };
    NODES.push(n); posMap[id] = n;
  });
  sinkDefs.map(e => posMap[e.id]).filter(Boolean).sort((a, b) => a.y - b.y)
    .forEach((n, i, arr) => { if (i > 0 && n.y < arr[i-1].y + arr[i-1].h + 10) n.y = arr[i-1].y + arr[i-1].h + 10; });

  // ── 11. Finalise ───────────────────────────────────────────
  NODES.forEach(n => { NODEMAP[n.id] = n; n.h = nodeH(n); });
  buildSpatialHash();

  // addEdge: rate = this edge's actual flow; totalRate = full demand/supply at
  // the destination end (used by the label renderer for split-flow annotation).
  function addEdge(src, tgt, item, rate, totalRate, color, dashed = false) {
    if (!posMap[src] || !posMap[tgt]) return;
    EDGES.push({ src, tgt, item, rate, totalRate, color, dashed });
  }

  // Return { recipeKey: outputRate } for all producers of an item.
  function producerOutputRates(item, prodKeys) {
    const out = {};
    prodKeys.forEach(k => { out[k] = flowMap[k]?.outputs[item] ?? 0; });
    return out;
  }

  // ── SOURCE → RECIPE ───────────────────────────────────────────────────────
  Object.entries(RESULT.source_nodes || {}).forEach(([item]) => {
    (consumers[item] || []).filter(k => posMap[k]).forEach(k => {
      const rate = flowMap[k]?.inputs[item] ?? 0;
      addEdge('SRC_' + item, k, item, rate, rate, '#cbd5e1');
    });
  });

  // ── RECIPE → RECIPE ───────────────────────────────────────────────────────
  // Greedy capacity-matching: assign producer supply to consumers one at a
  // time, largest-producer first. This minimises split edges — a consumer
  // whose full demand can be met by a single producer gets exactly one edge
  // from that producer, rather than fractional edges from every producer.
  //
  // Algorithm (per item):
  //   1. Sort producers descending by output rate.
  //   2. Sort consumers descending by input demand.
  //   3. Maintain a remaining-capacity bucket per producer.
  //   4. For each consumer in order, drain from producers in order until
  //      the consumer's demand is satisfied; emit one edge per producer
  //      segment actually used.  If a producer fully covers a consumer,
  //      only one edge appears; genuine splits only appear when no single
  //      producer has enough remaining capacity.
  {
    // Collect all items that flow between recipe nodes
    const recipeItems = new Set();
    flows.forEach(f => {
      Object.keys(f.inputs  || {}).forEach(i => recipeItems.add(i));
      Object.keys(f.outputs || {}).forEach(i => recipeItems.add(i));
    });

    recipeItems.forEach(item => {
      const prodKeys = (producers[item] || []).filter(k => posMap[k]);
      const consKeys = (consumers[item] || []).filter(k => posMap[k]);
      if (!prodKeys.length || !consKeys.length) return;

      // Remaining supply per producer (mutable copy)
      const supply = {};
      prodKeys.forEach(k => { supply[k] = flowMap[k]?.outputs[item] ?? 0; });

      // Sort producers largest-first so we drain the biggest pool first,
      // which tends to satisfy whole consumers in one shot.
      const sortedProds = [...prodKeys].sort((a, b) => supply[b] - supply[a]);

      // For each consumer, greedily assign supply
      consKeys.forEach(tgtKey => {
        if (tgtKey === undefined) return;
        const tgtFlow = flowMap[tgtKey];
        if (!tgtFlow) return;
        let remaining = tgtFlow.inputs[item] ?? 0;
        if (remaining <= 0) return;
        const totalConsumed = remaining;

        for (const srcKey of sortedProds) {
          if (remaining <= 1e-9) break;
          const avail = supply[srcKey] ?? 0;
          if (avail <= 1e-9) continue;

          const drawn = Math.min(avail, remaining);
          supply[srcKey] -= drawn;
          remaining      -= drawn;

          addEdge(srcKey, tgtKey, item, drawn, totalConsumed,
                  mCol(flowMap[srcKey]?.machine));
        }
      });
    });
  }

  // ── RECIPE → SINK / SURPLUS / ERROR ──────────────────────────────────────
  function addSinkEdges(itemMap, idPrefix, color, dashed) {
    Object.entries(itemMap || {}).forEach(([item, qty]) => {
      const prodKeys = (producers[item] || []).filter(k => posMap[k]);
      if (!prodKeys.length) return;
      // Greedy: drain from largest producer first so one producer
      // covers the whole sink when it has enough output.
      const supply = {};
      prodKeys.forEach(k => { supply[k] = flowMap[k]?.outputs[item] ?? 0; });
      const sorted = [...prodKeys].sort((a, b) => supply[b] - supply[a]);
      let remaining = qty;
      sorted.forEach(k => {
        if (remaining <= 1e-9) return;
        const avail = supply[k] ?? 0;
        if (avail <= 1e-9) return;
        const drawn = Math.min(avail, remaining);
        remaining -= drawn;
        addEdge(k, idPrefix + item, item, drawn, qty, color, dashed);
      });
    });
  }
  addSinkEdges(RESULT.sink_nodes,            'SNK_',    null,      false);
  addSinkEdges(RESULT.error_sinks,           'ERRSNK_', '#ef4444', true);
  addSinkEdges(RESULT.surplus_intermediates, 'SURP_',   '#f59e0b', true);
  // Sink edges with color=null get the producer's machine colour.
  EDGES.forEach(e => {
    if (e.color === null && e.src in flowMap)
      e.color = mCol(flowMap[e.src]?.machine);
  });

  // ── ERROR SOURCE → RECIPE ─────────────────────────────────────────────────
  Object.entries(RESULT.error_sources || {}).forEach(([item, qty]) => {
    (consumers[item] || []).filter(k => posMap[k]).forEach(k =>
      addEdge('ERRSRC_' + item, k, item, qty, qty, '#ef4444', true));
  });

  cacheEdgePaths();
  fitAll();
}


// ── Pre-compute bezier control points for all edges ───────
function cacheEdgePaths() {
  EDGES.forEach(e => {
    const sn = NODEMAP[e.src], tn = NODEMAP[e.tgt];
    if (!sn || !tn) return;
    const x1 = sn.x + sn.w, y1 = sn.y + nodeH(sn) / 2;
    const x2 = tn.x,         y2 = tn.y + nodeH(tn) / 2;
    const span = Math.max(Math.abs(x2 - x1), 80);
    e._x1 = x1; e._y1 = y1;
    e._cx1 = x1 + span * 0.45; e._cy1 = y1;
    e._cx2 = x2 - span * 0.45; e._cy2 = y2;
    e._x2 = x2; e._y2 = y2;
    // Bezier midpoint (t=0.5)
    e._mx = 0.125*x1 + 0.375*e._cx1 + 0.375*e._cx2 + 0.125*x2;
    e._my = 0.125*y1 + 0.375*y1     + 0.375*y2     + 0.125*y2;
  });
}

// ── Spatial hash for O(1) hit testing ────────────────────
const CELL = 200;  // world-space grid cell size
function buildSpatialHash() {
  SPATGRID = {};
  NODES.forEach(n => {
    const x0 = Math.floor(n.x / CELL), x1 = Math.floor((n.x + n.w) / CELL);
    const y0 = Math.floor(n.y / CELL), y1 = Math.floor((n.y + n.h) / CELL);
    for (let gx = x0; gx <= x1; gx++)
      for (let gy = y0; gy <= y1; gy++) {
        const key = `${gx},${gy}`;
        (SPATGRID[key] = SPATGRID[key] || []).push(n);
      }
  });
}

function hitNode(cx, cy) {
  const wx = (cx - PAN.x) / ZOOM, wy = (cy - PAN.y) / ZOOM;
  if (!SPATGRID) {
    // fallback linear
    for (let i = NODES.length - 1; i >= 0; i--) {
      const n = NODES[i];
      if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + nodeH(n)) return n;
    }
    return null;
  }
  const gx = Math.floor(wx / CELL), gy = Math.floor(wy / CELL);
  const candidates = SPATGRID[`${gx},${gy}`] || [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const n = candidates[i];
    if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + nodeH(n)) return n;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// FOCUS MODE
// ═══════════════════════════════════════════════════════════
function buildChains(nodeId) {
  const up = new Set(), dn = new Set();
  // Walk upstream (following incoming edges)
  const qUp = [nodeId];
  while (qUp.length) {
    const id = qUp.pop();
    EDGES.forEach(e => {
      if (e.tgt === id && !up.has(e.src)) { up.add(e.src); qUp.push(e.src); }
    });
  }
  // Walk downstream (following outgoing edges)
  const qDn = [nodeId];
  while (qDn.length) {
    const id = qDn.pop();
    EDGES.forEach(e => {
      if (e.src === id && !dn.has(e.tgt)) { dn.add(e.tgt); qDn.push(e.tgt); }
    });
  }
  return { up, dn };
}

function setFocus(nodeId) {
  if (FOCUSED === nodeId) { clearFocus(); return; }
  FOCUSED = nodeId;
  const { up, dn } = buildChains(nodeId);
  FOCUS_UP = up;
  FOCUS_DN = dn;
  schedDraw();
}

function clearFocus() {
  FOCUSED = null;
  FOCUS_UP = new Set();
  FOCUS_DN = new Set();
  schedDraw();
}

function focusAlpha(nodeId) {
  if (!FOCUSED) return 1;
  if (nodeId === FOCUSED || FOCUS_UP.has(nodeId) || FOCUS_DN.has(nodeId)) return 1;
  return 0.10;
}

function edgeFocusAlpha(e) {
  if (!FOCUSED) return 0.82;
  const inChain = (e.src === FOCUSED || FOCUS_UP.has(e.src) || FOCUS_DN.has(e.src)) &&
                  (e.tgt === FOCUSED || FOCUS_UP.has(e.tgt) || FOCUS_DN.has(e.tgt));
  return inChain ? 1 : 0.06;
}

function edgeFocusWidth(e) {
  if (!FOCUSED) return 1.6 / ZOOM;
  const inChain = (e.src === FOCUSED || FOCUS_UP.has(e.src) || FOCUS_DN.has(e.src)) &&
                  (e.tgt === FOCUSED || FOCUS_UP.has(e.tgt) || FOCUS_DN.has(e.tgt));
  return inChain ? 2.4 / ZOOM : 1 / ZOOM;
}

// ═══════════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════════
export function openSearch() {
  searchActive = true;
  searchQuery  = '';
  searchResults = [];
  searchIdx    = 0;
  renderSearchUI();
}

function closeSearch() {
  searchActive  = false;
  searchQuery   = '';
  searchResults = [];
  const el = document.getElementById('graph-search');
  if (el) el.style.display = 'none';
  schedDraw();
}

function renderSearchUI() {
  let el = document.getElementById('graph-search');
  if (!el) {
    el = document.createElement('div');
    el.id = 'graph-search';
    el.style.cssText = `
      position:absolute;top:12px;left:50%;transform:translateX(-50%);
      z-index:30;display:flex;align-items:center;gap:8px;
      background:var(--p2);border:1px solid var(--b2);border-radius:var(--rlg);
      padding:8px 14px;box-shadow:0 8px 32px rgba(0,0,0,.7);
      min-width:320px;backdrop-filter:blur(8px);
    `;
    el.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9aa0b4" stroke-width="2">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
      </svg>
      <input id="graph-search-inp" type="text" placeholder="Search recipe or item…"
        style="flex:1;background:transparent;border:none;color:var(--t);font-family:var(--mono);
               font-size:12px;outline:none;min-width:200px" autocomplete="off"/>
      <span id="graph-search-count" style="font-size:11px;color:var(--t3);font-family:var(--mono)"></span>
      <button id="graph-search-prev" style="background:none;border:none;color:var(--t2);cursor:pointer;font-size:14px;padding:0 2px">‹</button>
      <button id="graph-search-next" style="background:none;border:none;color:var(--t2);cursor:pointer;font-size:14px;padding:0 2px">›</button>
      <button id="graph-search-close" style="background:none;border:none;color:var(--t3);cursor:pointer;font-size:16px;padding:0 2px;line-height:1">✕</button>
    `;
    document.getElementById('graph').appendChild(el);
    document.getElementById('graph-search-inp').addEventListener('input', e => {
      searchQuery = e.target.value.trim().toLowerCase();
      runSearch();
    });
    document.getElementById('graph-search-inp').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.shiftKey ? prevResult() : nextResult(); }
      if (e.key === 'Escape') closeSearch();
    });
    document.getElementById('graph-search-prev').addEventListener('click', prevResult);
    document.getElementById('graph-search-next').addEventListener('click', nextResult);
    document.getElementById('graph-search-close').addEventListener('click', closeSearch);
  }
  el.style.display = 'flex';
  setTimeout(() => document.getElementById('graph-search-inp')?.focus(), 50);
}

function runSearch() {
  if (!searchQuery) { searchResults = []; updateSearchCount(); schedDraw(); return; }
  searchResults = NODES
    .filter(n => {
      const label = n.type === 'recipe'
        ? (n.data.display || '').toLowerCase()
        : itemName(n.data?.item || '').toLowerCase();
      return label.includes(searchQuery) ||
             (n.id || '').toLowerCase().includes(searchQuery);
    })
    .map(n => n.id);
  searchIdx = 0;
  if (searchResults.length) centreOnNode(searchResults[0]);
  updateSearchCount();
  schedDraw();
}

function nextResult() {
  if (!searchResults.length) return;
  searchIdx = (searchIdx + 1) % searchResults.length;
  centreOnNode(searchResults[searchIdx]);
  updateSearchCount();
}

function prevResult() {
  if (!searchResults.length) return;
  searchIdx = (searchIdx - 1 + searchResults.length) % searchResults.length;
  centreOnNode(searchResults[searchIdx]);
  updateSearchCount();
}

function updateSearchCount() {
  const el = document.getElementById('graph-search-count');
  if (!el) return;
  el.textContent = searchResults.length
    ? `${searchIdx + 1}/${searchResults.length}`
    : (searchQuery ? 'no results' : '');
}

// ═══════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════
export function fitAll() {
  if (!NODES.length) { PAN = { x: 0, y: 0 }; ZOOM = 1; schedDraw(); return; }
  const W = CV.clientWidth || 800, H = CV.clientHeight || 600;
  const minX = Math.min(...NODES.map(n => n.x));
  const minY = Math.min(...NODES.map(n => n.y));
  const maxX = Math.max(...NODES.map(n => n.x + n.w));
  const maxY = Math.max(...NODES.map(n => n.y + nodeH(n)));
  const pad = 60, bw = maxX - minX, bh = maxY - minY;
  if (bw < 1 || bh < 1) return;
  ZOOM = Math.min(2, Math.max(0.05, Math.min((W - pad * 2) / bw, (H - pad * 2) / bh)));
  PAN.x = (W - bw * ZOOM) / 2 - minX * ZOOM;
  PAN.y = (H - bh * ZOOM) / 2 - minY * ZOOM;
  schedDraw();
}

export function zoomBy(f) {
  const W = CV.clientWidth / 2, H = CV.clientHeight / 2;
  const nz = Math.min(3, Math.max(0.05, ZOOM * f));
  PAN.x = W - (W - PAN.x) * (nz / ZOOM);
  PAN.y = H - (H - PAN.y) * (nz / ZOOM);
  ZOOM  = nz;
  schedDraw();
}

function centreOnNode(nodeId, animate = true) {
  const n = NODEMAP[nodeId];
  if (!n) return;
  const W  = CV.clientWidth, H = CV.clientHeight;
  const tx = W / 2 - (n.x + n.w / 2) * ZOOM;
  const ty = H / 2 - (n.y + nodeH(n) / 2) * ZOOM;
  if (!animate) { PAN.x = tx; PAN.y = ty; schedDraw(); return; }
  // Smooth pan animation
  const startX = PAN.x, startY = PAN.y;
  const dx = tx - startX, dy = ty - startY;
  const dur = 320, start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
    PAN.x = startX + dx * e;
    PAN.y = startY + dy * e;
    schedDraw();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ═══════════════════════════════════════════════════════════
// DRAW
// ═══════════════════════════════════════════════════════════
export function draw() {
  if (isPinboardActive()) return;
  if (!initCanvasRefs()) return;
  try {
    _draw();
  } catch (err) {
    console.error('Graph draw error:', err);
    // Show a non-fatal message on the canvas instead of a blank screen
    const W = CV.clientWidth, H = CV.clientHeight;
    C.setTransform(lastDpr, 0, 0, lastDpr, 0, 0);
    C.clearRect(0, 0, W, H);
    C.fillStyle = '#0c0e13';
    C.fillRect(0, 0, W, H);
    C.fillStyle = 'rgba(239,68,68,0.85)';
    C.font = '13px monospace';
    C.textAlign = 'center';
    C.fillText('Graph render error — check console for details', W / 2, H / 2);
    C.textAlign = 'left';
  }
}

// ── Viewport culling helpers ──────────────────────────────
// Returns the visible world-space bounding box given current PAN/ZOOM.
// Used to skip draw calls for off-screen nodes and edges.
function viewportBounds(W, H, margin = 40) {
  return {
    x1: (-PAN.x / ZOOM) - margin,
    y1: (-PAN.y / ZOOM) - margin,
    x2: (-PAN.x + W) / ZOOM + margin,
    y2: (-PAN.y + H) / ZOOM + margin,
  };
}

function nodeInView(n, vp) {
  const h = nodeH(n);
  return n.x + n.w >= vp.x1 && n.x <= vp.x2 &&
         n.y + h   >= vp.y1 && n.y <= vp.y2;
}

function edgeInView(e, vp) {
  if (e._x1 == null) return false;
  const minX = Math.min(e._x1, e._x2, e._cx1, e._cx2);
  const maxX = Math.max(e._x1, e._x2, e._cx1, e._cx2);
  const minY = Math.min(e._y1, e._y2, e._cy1, e._cy2);
  const maxY = Math.max(e._y1, e._y2, e._cy1, e._cy2);
  return maxX >= vp.x1 && minX <= vp.x2 &&
         maxY >= vp.y1 && minY <= vp.y2;
}

function _draw() {
  const W = CV.clientWidth, H = CV.clientHeight;
  C.setTransform(lastDpr, 0, 0, lastDpr, 0, 0);
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

  if (!NODES.length) return;

  C.save();
  C.translate(PAN.x, PAN.y);
  C.scale(ZOOM, ZOOM);

  // Compute visible world-space bounds once per frame for culling
  const vp = viewportBounds(W, H);

  // Draw edges first (behind nodes) — skip fully off-screen edges
  EDGES.forEach(e => { if (edgeInView(e, vp)) drawEdge(e); });

  // Draw nodes — skip fully off-screen nodes; specials drawn first
  const specials = NODES.filter(n => n.type !== 'recipe' && nodeInView(n, vp));
  const recipes  = NODES.filter(n => n.type === 'recipe' && nodeInView(n, vp));
  specials.forEach(drawNode);
  recipes.forEach(drawNode);

  // Search highlight ring — only for visible nodes
  if (searchResults.length) {
    const activeId = searchResults[searchIdx];
    NODES.forEach(n => {
      if (!searchResults.includes(n.id)) return;
      if (!nodeInView(n, vp)) return;
      const isActive = n.id === activeId;
      C.strokeStyle = isActive ? '#f59e0b' : 'rgba(245,158,11,0.4)';
      C.lineWidth   = isActive ? 3 / ZOOM : 1.5 / ZOOM;
      C.setLineDash(isActive ? [] : [4 / ZOOM, 3 / ZOOM]);
      roundRectStroke(n.x - 3, n.y - 3, n.w + 6, nodeH(n) + 6, 12);
      C.setLineDash([]);
    });
  }

  C.restore();
}

// ── Edge ─────────────────────────────────────────────────
function drawEdge(e) {
  if (e._x1 == null) return;
  const alpha = edgeFocusAlpha(e);
  const lw    = edgeFocusWidth(e);

  C.globalAlpha = alpha;
  C.beginPath();
  C.moveTo(e._x1, e._y1);
  C.bezierCurveTo(e._cx1, e._cy1, e._cx2, e._cy2, e._x2, e._y2);
  C.strokeStyle = e.color;
  C.lineWidth   = lw;
  C.setLineDash(e.dashed ? [5 / ZOOM, 3 / ZOOM] : []);
  C.stroke();
  C.setLineDash([]);

  // Arrow head
  const ang = Math.atan2(e._y2 - e._y1, e._x2 - e._x1);
  const al  = 7 / ZOOM, aw = 3.5 / ZOOM;
  const ax  = e._x2 - Math.cos(ang) * al, ay = e._y2 - Math.sin(ang) * al;
  C.beginPath();
  C.moveTo(e._x2, e._y2);
  C.lineTo(ax - Math.sin(ang) * aw, ay + Math.cos(ang) * aw);
  C.lineTo(ax + Math.sin(ang) * aw, ay - Math.cos(ang) * aw);
  C.closePath();
  C.fillStyle = e.color;
  C.fill();

  // Edge label — always "ItemName  rate/m", same format for split and non-split edges.
  if (ZOOM >= 0.35 && alpha > 0.3) {
    const rateStr = `${Number(e.rate).toFixed(1)}/m`;
    const lbl     = `${itemName(e.item)}  ${rateStr}`;

    const fs  = 10;
    C.font    = `${fs}px 'JetBrains Mono',monospace`;
    const tw  = C.measureText(lbl).width;
    const pad = 4;

    C.fillStyle = 'rgba(25,29,40,0.92)';
    C.fillRect(e._mx - tw / 2 - pad, e._my - fs * 0.72 - pad / 2, tw + pad * 2, fs + pad);
    C.fillStyle    = e.color;
    C.textAlign    = 'center';
    C.textBaseline = 'middle';
    C.fillText(lbl, e._mx, e._my);
    C.textAlign    = 'left';
    C.textBaseline = 'alphabetic';
  }

  C.globalAlpha = 1;
}

// ── Recipe node ───────────────────────────────────────────
function drawNode(n) {
  const { x, y, w, type, data } = n;
  const h     = nodeH(n);
  const alpha = focusAlpha(n.id);
  const hover = HIT === n.id;

  C.globalAlpha = alpha;

  if (type === 'source')      { drawSpecNode(n, '#1a1f2e', '#cbd5e1', 'RESOURCE INPUT', true);  C.globalAlpha = 1; return; }
  if (type === 'sink')        { drawSpecNode(n, '#0f2318', '#4ade80', 'OUTPUT',          false); C.globalAlpha = 1; return; }
  if (type === 'errorsink')   { drawSpecNode(n, '#1c0a0a', '#ef4444', '⚠ BYPRODUCT',    false); C.globalAlpha = 1; return; }
  if (type === 'errorsource') { drawSpecNode(n, '#1c0a0a', '#ef4444', '⚠ MISSING',      true);  C.globalAlpha = 1; return; }
  if (type === 'surplus')     { drawSpecNode(n, '#1c1400', '#f59e0b', 'SURPLUS',         false); C.globalAlpha = 1; return; }

  const f     = data;
  const color = mCol(f.machine);
  const isFoc = n.id === FOCUSED;

  // Clip
  C.save();
  C.beginPath(); roundRect(x, y, w, h, 10); C.clip();

  // Shadow
  C.fillStyle = 'rgba(0,0,0,0.4)';
  roundRectFill(x + 2, y + 2, w, h, 10);

  // Body
  C.fillStyle   = '#191d28';
  roundRectFill(x, y, w, h, 10);
  const borderCol = isFoc ? '#f59e0b' : hover ? '#616880' : '#323a50';
  C.strokeStyle = borderCol;
  C.lineWidth   = isFoc ? 2.5 : hover ? 1.5 : 1;
  roundRectStroke(x, y, w, h, 10);

  // Top colour bar
  C.fillStyle = color;
  roundRectFill(x, y, w, 3, 2);

  let cy = y + 12;

  // Machine badge
  C.font = 'bold 9px JetBrains Mono,monospace';
  const abbr  = MABBR[f.machine] || f.machine;
  const abbrW = C.measureText(abbr).width + 12;
  C.fillStyle = color + '33'; roundRectFill(x + 10, cy, abbrW, 15, 3);
  C.strokeStyle = color + '66'; C.lineWidth = 0.5; roundRectStroke(x + 10, cy, abbrW, 15, 3);
  C.fillStyle = color; C.textAlign = 'center'; C.textBaseline = 'middle';
  C.fillText(abbr, x + 10 + abbrW / 2, cy + 7.5);
  C.textAlign = 'left'; C.textBaseline = 'alphabetic';

  // Alt badge
  const isAlt = f.display.includes('(Alt)') || f.display.startsWith('Alternate:');
  if (isAlt) {
    C.font = 'bold 8px JetBrains Mono,monospace';
    const ax2 = x + 10 + abbrW + 6;
    C.fillStyle = 'rgba(245,158,11,.15)'; roundRectFill(ax2, cy, 24, 15, 3);
    C.strokeStyle = '#f59e0b'; C.lineWidth = 0.5; roundRectStroke(ax2, cy, 24, 15, 3);
    C.fillStyle = '#f59e0b'; C.textAlign = 'center'; C.textBaseline = 'middle';
    C.fillText('ALT', ax2 + 12, cy + 7.5);
    C.textAlign = 'left'; C.textBaseline = 'alphabetic';
  }

  // Indicator dots
  let dotX = x + w - 9;
  if (f.has_sloop) { C.fillStyle = '#a855f7'; circleFill(dotX, cy + 7, 4); C.fill(); dotX -= 12; }
  if (f.has_shard) { C.fillStyle = '#3b82f6'; circleFill(dotX, cy + 7, 4); C.fill(); }

  cy += 20;

  // Recipe name
  const cleanName = f.display.replace(/\(Alt\)/g, '').replace(/^Alternate:\s*/i, '').trim();
  C.font = '600 12px Inter,sans-serif'; C.fillStyle = '#e8eaf0'; C.textBaseline = 'middle';
  C.fillText(measureTrunc(cleanName, w - 22), x + 10, cy + 7);
  cy += 16;

  // Machine count — show mixed layout split when some machines overclock and rest run at 100%
  C.font = '10px JetBrains Mono,monospace'; C.fillStyle = '#616880';
  {
    const hi_n = f.hi_machines ?? 0;
    const lo_n = f.machines_final - hi_n;
    const machineLabel = (hi_n > 0 && lo_n > 0)
      ? `${hi_n}×${(f.clock_pct ?? 100).toFixed(0)}% + ${lo_n}×100%  (${f.machines_float.toFixed(2)} LP)`
      : `${f.machines_final} machine${f.machines_final !== 1 ? 's' : ''}  (${f.machines_float.toFixed(2)} LP)`;
    C.fillText(measureTrunc(machineLabel, w - 22), x + 10, cy + 7);
  }
  cy += 16;

  // Stats bar
  C.fillStyle = '#1f2435'; C.fillRect(x, cy, w, STATS_H);
  C.strokeStyle = '#272d3d'; C.lineWidth = 0.5;
  C.beginPath(); C.moveTo(x, cy); C.lineTo(x + w, cy); C.stroke();

  // For mixed layouts: clock shown as "Hi%/100%" and shard count is just the hi-machine count
  const clk    = f.clock_pct ?? 100;
  const hi_n   = f.hi_machines ?? 0;
  const isMixed = hi_n > 0 && hi_n < f.machines_final;
  // Clock colour: orange if any machine is overclocked, blue if all underclocked, grey if 100%
  const clkCol = clk > 100.1 ? '#fb923c' : clk < 99.9 ? '#38bdf8' : '#616880';
  const clkLabel = isMixed ? `⏱${clk.toFixed(0)}%/${(100).toFixed(0)}%` : `⏱${clk.toFixed(1)}%`;
  C.font = '10px JetBrains Mono,monospace'; C.textBaseline = 'middle';
  let sx = x + 7;
  const stat = (t, fill) => { C.fillStyle = fill; C.fillText(t, sx, cy + STATS_H / 2); sx += C.measureText(t).width + 7; };
  stat(clkLabel, clkCol);
  stat(`⚡${f.power_mw.toFixed(0)}MW`, '#fb923c');
  if (f.has_shard) {
    // For mixed layouts, shards_used is the count on hi_machines only; show "N shard" total
    const shardLabel = isMixed
      ? `💎${f.shards_used}`
      : `💎${Math.round(f.shards_used / (f.machines_final || 1))}/m`;
    stat(shardLabel, '#3b82f6');
  }
  if (f.has_sloop) stat(`🔮×${(f.output_multiplier || 1).toFixed(2)}`, '#a855f7');
  C.fillStyle = '#616880'; C.textAlign = 'right'; C.textBaseline = 'middle';
  C.fillText(n.expanded ? '▲' : '▼', x + w - 7, cy + STATS_H / 2);
  C.textAlign = 'left'; C.textBaseline = 'alphabetic';
  cy += STATS_H;

  // IO rows
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

  const ins  = Object.entries(f.inputs  || {});
  const outs = Object.entries(f.outputs || {});
  if (ins.length)  { divider('Inputs');  ins.forEach(([k, r]) => ioRow('← ' + itemName(k), r, '#9aa0b4')); }
  if (outs.length) {
    divider('Outputs' + (f.has_sloop ? ` ×${(f.output_multiplier || 1).toFixed(2)}` : ''));
    outs.forEach(([k, r]) => ioRow('→ ' + itemName(k), r, '#22c55e'));
  }

  // Expanded layout options
  if (n.expanded && f.layout_options?.length) {
    C.strokeStyle = '#272d3d'; C.lineWidth = 0.5;
    C.beginPath(); C.moveTo(x, cy); C.lineTo(x + w, cy); C.stroke();
    cy += 4;
    C.font = '9px Inter,sans-serif'; C.fillStyle = '#616880'; C.textBaseline = 'middle';
    C.fillText('INTEGER LAYOUT OPTIONS', x + 10, cy + 7);
    cy += 14; C.textBaseline = 'alphabetic';
    f.layout_options.forEach(opt => {
      // A layout option is "chosen" when its shard count and machine count match what the solver picked.
      // Mixed layouts keep machines_final == ceil(LP) but use fewer shards than the all-or-nothing option.
      const chosen = opt.shards_needed === f.shards_used && opt.machines === f.machines_final;
      C.fillStyle = chosen ? 'rgba(245,158,11,.1)' : '#1f2435'; roundRectFill(x + 6, cy, w - 12, 24, 4);
      C.strokeStyle = chosen ? '#f59e0b' : '#272d3d'; C.lineWidth = 0.5; roundRectStroke(x + 6, cy, w - 12, 24, 4);
      C.font = '11px JetBrains Mono,monospace'; C.fillStyle = chosen ? '#f59e0b' : '#9aa0b4'; C.textBaseline = 'middle';
      C.fillText(measureTrunc(opt.label, w - 72), x + 10, cy + 12);
      C.fillStyle = '#fb923c'; C.textAlign = 'right';
      C.fillText(`${opt.power_mw.toFixed(0)} MW`, x + w - 10, cy + 12);
      C.textAlign = 'left'; C.textBaseline = 'alphabetic'; cy += 28;
    });
    C.font = '9px Inter,sans-serif'; C.fillStyle = '#616880'; C.textBaseline = 'middle';
    C.fillText('Highlighted = chosen. Click to collapse.', x + 10, cy + 7);
    cy += 12; C.textBaseline = 'alphabetic';
  }

  C.restore(); // end clip

  // Connection handles
  C.fillStyle = color; C.strokeStyle = '#191d28'; C.lineWidth = 2;
  circleFill(x,     y + h / 2, 5); C.fill(); C.stroke();
  circleFill(x + w, y + h / 2, 5); C.fill(); C.stroke();

  C.globalAlpha = 1;
}

function drawSpecNode(n, bg, border, title, isSource) {
  const { x, y, w, h, data } = n;
  C.save();
  C.beginPath(); roundRect(x, y, w, h, 8); C.clip();
  C.fillStyle = 'rgba(0,0,0,0.3)'; roundRectFill(x + 1, y + 1, w, h, 8);
  C.fillStyle = bg; roundRectFill(x, y, w, h, 8);
  C.strokeStyle = border; C.lineWidth = 2; roundRectStroke(x, y, w, h, 8);
  C.textAlign = 'center'; C.textBaseline = 'middle';
  C.font = '9px Inter,sans-serif'; C.fillStyle = border;
  C.fillText(title, x + w / 2, y + 13);
  C.font = '600 12px Inter,sans-serif'; C.fillStyle = '#f1f5f9';
  C.fillText(measureTrunc(itemName(data?.item || ''), w - 10), x + w / 2, y + 30);
  C.font = '11px JetBrains Mono,monospace'; C.fillStyle = border;
  C.fillText(`${Number(data?.rate || 0).toFixed(1)}/min`, x + w / 2, y + 44);
  C.textAlign = 'left'; C.textBaseline = 'alphabetic';
  C.restore();
  C.fillStyle = border; C.strokeStyle = bg; C.lineWidth = 2;
  if (isSource) { circleFill(x + w, y + h / 2, 5); } else { circleFill(x, y + h / 2, 5); }
  C.fill(); C.stroke();
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
function roundRect(x, y, w, h, r)       { rPath(x, y, w, h, r); }
function roundRectFill(x, y, w, h, r)   { rPath(x, y, w, h, r); C.fill(); }
function roundRectStroke(x, y, w, h, r) { rPath(x, y, w, h, r); C.stroke(); }
function circleFill(x, y, r) { C.beginPath(); C.arc(x, y, r, 0, Math.PI * 2); }

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

// ═══════════════════════════════════════════════════════════
// MOUSE / KEYBOARD INTERACTION
// ═══════════════════════════════════════════════════════════
function getPos(e) {
  const r = CV.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// ── Input event wiring ────────────────────────────────────
// Called once from main.js after the DOM is ready, so CV is guaranteed to exist.
export function initGraphEvents() {
  initCanvasRefs();

  // When a node is focused, only nodes in its chain (self + upstream + downstream)
  // are interactable. Clicks/hovers on faded nodes are silently ignored so they
  // stay visible in the background without being accidentally dragged or selected.
  function isFocusable(node) {
    if (!FOCUSED) return true;
    return node.id === FOCUSED || FOCUS_UP.has(node.id) || FOCUS_DN.has(node.id);
  }

  CV.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const pos  = getPos(e);
    const node = hitNode(pos.x, pos.y);
    if (node && isFocusable(node)) {
      DRAG = { node, sx: pos.x, sy: pos.y, ox: node.x, oy: node.y, moved: false };
    } else {
      // Clicking on a faded node or empty canvas always pans (never focuses faded)
      PANSTART = { x: pos.x, y: pos.y, px: PAN.x, py: PAN.y };
      CV.style.cursor = 'grabbing';
    }
  });

  window.addEventListener('mousemove', e => {
    const pos = getPos(e);
    if (DRAG) {
      const dx = (pos.x - DRAG.sx) / ZOOM, dy = (pos.y - DRAG.sy) / ZOOM;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) DRAG.moved = true;
      if (DRAG.moved) {
        DRAG.node.x = DRAG.ox + dx;
        DRAG.node.y = DRAG.oy + dy;
        buildSpatialHash();
        cacheEdgePaths();
        schedDraw();
      }
      return;
    }
    if (PANSTART) {
      PAN.x = PANSTART.px + (pos.x - PANSTART.x);
      PAN.y = PANSTART.py + (pos.y - PANSTART.y);
      schedDraw();
      return;
    }
    const node   = hitNode(pos.x, pos.y);
    const newHit = (node && isFocusable(node)) ? node.id : null;
    if (newHit !== HIT) {
      HIT = newHit;
      CV.style.cursor = HIT ? 'pointer' : 'default';
      schedDraw();
    }
  });

  window.addEventListener('mouseup', () => {
    if (DRAG) {
      if (!DRAG.moved) {
        const n = DRAG.node;
        if (n.type === 'recipe') setFocus(n.id);
      }
      DRAG = null;
    }
    PANSTART = null;
    CV.style.cursor = HIT ? 'pointer' : 'default';
  });

  CV.addEventListener('dblclick', e => {
    const pos  = getPos(e);
    const node = hitNode(pos.x, pos.y);
    if (node && isFocusable(node)) {
      if (node.type === 'recipe') {
        node.expanded = !node.expanded;
        node._hcache_exp_dirty = true;
        node.h = nodeH(node);
        buildSpatialHash();
        cacheEdgePaths();
      }
      centreOnNode(node.id);
    } else {
      // Double-clicking empty canvas or a faded node exits focus mode
      clearFocus();
    }
  });

  CV.addEventListener('wheel', e => {
    e.preventDefault();
    const pos = getPos(e);
    const nz  = Math.min(3, Math.max(0.05, ZOOM * (e.deltaY > 0 ? 0.85 : 1.18)));
    PAN.x = pos.x - (pos.x - PAN.x) * (nz / ZOOM);
    PAN.y = pos.y - (pos.y - PAN.y) * (nz / ZOOM);
    ZOOM  = nz;
    schedDraw();
  }, { passive: false });

  // Ctrl+F → graph node search (Ctrl+Q is topbar recipe lookup, handled in main.js)
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      const graphEl = document.getElementById('graph');
      if (!graphEl || graphEl.style.display === 'none') return;
      e.preventDefault();
      openSearch();
    }
    if (e.key === 'Escape') {
      if (searchActive) { closeSearch(); return; }
      clearFocus();
    }
  });
}
