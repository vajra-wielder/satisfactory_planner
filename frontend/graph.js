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
 * Presentation:
 *   Goal bands — recipes grouped by the goal their output mostly feeds;
 *     click a band title to collapse it into one summary node
 *   Hubs — one splitter / merger node per item with fan-in or fan-out
 *   Stubs — taps under 5% of an item's flow drawn as short labelled leads
 *
 * Performance: spatial hash O(1) hit test, cached node heights,
 *   edge geometry rebuilt only on layout change
 */

import { RESULT, mCol, MABBR, itemName, perMin } from './state.js';

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
let BANDCLICK = null;      // {band, x, y} — band header pressed, toggles on release

// ── Animation ────────────────────────────────────────────
let animFrame = null;
function schedDraw() {
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
const HUB_W   = 130;   // splitter / merger node
const HUB_H   = 40;
const MINOR_FRAC = 0.05; // taps below 5% of an item's flow are drawn as stubs

// ── Node height (cached) ──────────────────────────────────
function nodeH(node) {
  if (node.type === 'hub') return HUB_H;
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
// ── Presentation options ──────────────────────────────────
let SHOW_HUBS       = true;    // splitter / merger node for items with fan-in or fan-out
let SHOW_MINOR_FULL = false;   // draw small taps as full edges instead of short stubs
let BANDS = [];                // [{id, label, sub, x, y, w, h, collapsed}] — one per goal
const COLLAPSED = new Set();   // band ids collapsed by the user (kept across re-layouts)

export function toggleHubs()  { SHOW_HUBS = !SHOW_HUBS; initLayout({ keepView: true }); return SHOW_HUBS; }
export function toggleMinor() { SHOW_MINOR_FULL = !SHOW_MINOR_FULL; schedDraw(); return SHOW_MINOR_FULL; }

function toggleBand(id) {
  if (COLLAPSED.has(id)) COLLAPSED.delete(id); else COLLAPSED.add(id);
  initLayout({ keepView: true });
}

// ── Goal bands ────────────────────────────────────────────
// Each recipe is assigned to the goal that receives most of its main output,
// following flows downstream proportionally (a recipe feeding 90% of its output
// into the Turbofuel line belongs to the Turbofuel band). Byproducts are ignored
// here so e.g. Rubber's Heavy Oil Residue doesn't drag it into the fuel band.
const OTHER_BAND = '__other__';

function computeGroups(flows) {
  const sinks = RESULT.sink_nodes || {};
  const prodTot = {}, consOf = {};
  flows.forEach(f => {
    Object.entries(f.outputs || {}).forEach(([i, v]) => { prodTot[i] = (prodTot[i] || 0) + v; });
    Object.entries(f.inputs  || {}).forEach(([i, v]) => (consOf[i] = consOf[i] || []).push([f.recipe_key, v]));
  });

  // share[k][goal] = fraction of k's main output that ends up in that goal
  let share = Object.fromEntries(flows.map(f => [f.recipe_key, {}]));
  for (let it = 0; it < 40; it++) {
    const nxt = {};
    flows.forEach(f => {
      const s = {};
      const main = Object.keys(f.outputs || {})[0];
      if (main) {
        const P = prodTot[main] || 1;
        if (sinks[main] > 0) s[main] = sinks[main] / P;
        (consOf[main] || []).forEach(([c, cin]) => {
          Object.entries(share[c] || {}).forEach(([g, v]) => { s[g] = (s[g] || 0) + (cin / P) * v; });
        });
      }
      nxt[f.recipe_key] = s;
    });
    share = nxt;
  }

  const groupOf = {};
  flows.forEach(f => {
    let best = OTHER_BAND, bv = 1e-6;
    Object.entries(share[f.recipe_key]).forEach(([g, v]) => { if (v > bv) { bv = v; best = g; } });
    groupOf[f.recipe_key] = best;
  });

  const byId = {};
  flows.forEach(f => {
    const id = groupOf[f.recipe_key];
    const g = byId[id] = byId[id] || { id, recipes: 0, machines: 0 };
    g.recipes++; g.machines += f.machines_final || 0;
  });
  const groups = Object.values(byId).map(g => ({
    ...g,
    label: g.id === OTHER_BAND ? 'Other' : itemName(g.id),
    rate:  g.id === OTHER_BAND ? null : sinks[g.id],
  }));
  groups.sort((a, b) => (a.id === OTHER_BAND) - (b.id === OTHER_BAND) || b.machines - a.machines);
  return { groupOf, groups };
}

// Start with the biggest band, then repeatedly place the band that exchanges
// the most material with the band just above it (then with any placed band),
// so cross-band belts stay short.
function orderBands(groups, flows, bandOf) {
  if (groups.length < 3) return groups;
  const prodBand = {};
  flows.forEach(f => Object.keys(f.outputs || {}).forEach(i =>
    (prodBand[i] = prodBand[i] || []).push([bandOf(f.recipe_key), f.outputs[i]])));
  const link = {};   // "a|b" → rate exchanged
  flows.forEach(f => {
    const b = bandOf(f.recipe_key);
    Object.entries(f.inputs || {}).forEach(([i, v]) => {
      const ps = prodBand[i] || [];
      const tot = ps.reduce((s, [, r]) => s + r, 0) || 1;
      ps.forEach(([pb, r]) => {
        if (pb === b) return;
        const key = [pb, b].sort().join('|');
        link[key] = (link[key] || 0) + v * r / tot;
      });
    });
  });
  const w = (a, b) => link[[a, b].sort().join('|')] || 0;
  const rest  = groups.filter(g => g.id !== OTHER_BAND);
  const other = groups.filter(g => g.id === OTHER_BAND);
  const out = [rest.shift()];
  while (rest.length) {
    const last = out[out.length - 1].id;
    let bi = 0, bs = -1;
    rest.forEach((g, i) => {
      const sc = w(last, g.id) * 1e3 + out.reduce((s, o) => s + w(o.id, g.id), 0) + g.machines * 1e-6;
      if (sc > bs) { bs = sc; bi = i; }
    });
    out.push(rest.splice(bi, 1)[0]);
  }
  return [...out, ...other];
}

// Replace every collapsed band's recipes with one summary flow whose inputs and
// outputs are only what crosses the band boundary.
function collapseGroups(flows, groupOf, groups) {
  if (!COLLAPSED.size) return flows;
  const out = flows.filter(f => !COLLAPSED.has(groupOf[f.recipe_key]));
  groups.filter(g => COLLAPSED.has(g.id)).forEach(g => {
    const members = flows.filter(f => groupOf[f.recipe_key] === g.id);
    if (!members.length) return;
    const net = {};
    members.forEach(f => {
      Object.entries(f.inputs  || {}).forEach(([i, v]) => { net[i] = (net[i] || 0) - v; });
      Object.entries(f.outputs || {}).forEach(([i, v]) => { net[i] = (net[i] || 0) + v; });
    });
    const inputs = {}, outputs = {};
    Object.entries(net).forEach(([i, v]) => {
      if (v < -1e-6) inputs[i] = -v; else if (v > 1e-6) outputs[i] = v;
    });
    out.push({
      recipe_key: 'GRP_' + g.id, display: g.label, machine: 'Group',
      isGroup: true, groupId: g.id, memberCount: members.length,
      machines_final: members.reduce((s, f) => s + (f.machines_final || 0), 0),
      machines_float: members.reduce((s, f) => s + (f.machines_float || 0), 0),
      power_mw:       members.reduce((s, f) => s + (f.power_mw || 0), 0),
      clock_pct: 100, hi_machines: 0, layout_options: [],
      has_sloop: false, has_shard: false, inputs, outputs,
    });
  });
  return out;
}

export function initLayout({ keepView = false } = {}) {
  if (!initCanvasRefs()) return;
  NODES = []; EDGES = []; NODEMAP = {}; BANDS = [];
  SPATGRID = null;
  clearFocus();

  if (!RESULT?.flows?.length) {
    GE.classList.remove('hidden');
    schedDraw();
    return;
  }
  GE.classList.add('hidden');

  const { groupOf, groups } = computeGroups(RESULT.flows);
  const flows   = collapseGroups(RESULT.flows, groupOf, groups);
  const flowMap = Object.fromEntries(flows.map(f => [f.recipe_key, f]));
  const bandOf  = k => flowMap[k]?.groupId ?? groupOf[k];

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

  // Columns are shared by all bands so left-to-right position always means
  // "distance from raw resources"; bands stack vertically.
  const YGAP   = 40;
  const firstX = SHOW_HUBS ? 20 + SRC_W + XGAP : SRC_W + 50;
  const colX   = li => firstX + li * (NW + XGAP);
  const posMap = {};
  function midY(key) { const n = posMap[key]; return n ? n.y + n.h / 2 : 0; }

  // Steps 3–7 of the layout, run inside one band starting at y = top.
  // Only neighbours in the same band influence ordering, so bands stay compact.
  // Returns the band's bottom y.
  function placeBand(bLayers, members, top) {
    const bPrev = k => (prev[k] || []).filter(p => members.has(p));
    const bNext = k => (next[k] || []).filter(p => members.has(p));

    // ── 3. Index-based barycenter (8 passes) ────────────────
    const posOrd = {};
    bLayers.forEach(layer => layer.forEach((k, i) => posOrd[k] = i));
    function bcIndex(layer, usePrev) {
      return [...layer].sort((a, b) => {
        const na = usePrev ? bPrev(a) : bNext(a);
        const nb = usePrev ? bPrev(b) : bNext(b);
        const ya = na.length ? na.reduce((s, k) => s + (posOrd[k] ?? 0), 0) / na.length : posOrd[a] ?? 0;
        const yb = nb.length ? nb.reduce((s, k) => s + (posOrd[k] ?? 0), 0) / nb.length : posOrd[b] ?? 0;
        return ya - yb;
      });
    }
    for (let pass = 0; pass < 8; pass++) {
      const fwd = pass % 2 === 0;
      (fwd ? bLayers : [...bLayers].reverse()).forEach(layer => {
        bcIndex(layer, fwd).forEach((k, i) => { layer[i] = k; posOrd[k] = i; });
      });
    }

    // ── 4. Pixel placement — uniform top-down ───────────────
    bLayers.forEach((layer, li) => {
      let curY = top;
      layer.forEach(key => {
        const n = { id: key, x: colX(li), y: curY, w: NW, h: 0,
                    type: 'recipe', data: flowMap[key], expanded: false };
        n.h = nodeH(n);
        NODES.push(n); posMap[key] = n;
        curY += n.h + YGAP;
      });
    });

    // ── 5. Pixel-accurate barycenter + reassign ──────────────
    function bcPixel(layer, usePrev) {
      return [...layer].sort((a, b) => {
        const na = usePrev ? bPrev(a) : bNext(a);
        const nb = usePrev ? bPrev(b) : bNext(b);
        const ya = na.length ? na.reduce((s, k) => s + midY(k), 0) / na.length : midY(a);
        const yb = nb.length ? nb.reduce((s, k) => s + midY(k), 0) / nb.length : midY(b);
        return ya - yb;
      });
    }
    function reassignY(layer) {
      let curY = top;
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
        if (s[i].y + s[i].h > maxBot) s[i].y = Math.max(top, maxBot - s[i].h);
      }
    }
    for (let pass = 0; pass < 6; pass++) {
      const fwd = pass % 2 === 0;
      (fwd ? bLayers : [...bLayers].reverse()).forEach(layer => {
        bcPixel(layer, fwd).forEach((k, i) => layer[i] = k);
        reassignY(layer);
      });
    }

    // ── 6. Compaction — pull toward neighbour midY ───────────
    function idealMidY(key) {
      const all = [...bPrev(key), ...bNext(key)].filter(k => posMap[k]);
      if (!all.length) return null;
      return all.reduce((s, k) => s + midY(k), 0) / all.length;
    }
    for (let pass = 0; pass < 6; pass++) {
      const fwd = pass % 2 === 0;
      (fwd ? bLayers : [...bLayers].reverse()).forEach(layer => {
        layer.forEach(key => {
          const n = posMap[key]; if (!n) return;
          const im = idealMidY(key); if (im === null) return;
          n.y = Math.max(top, n.y + (im - n.h / 2 - n.y) * 0.6);
        });
        resolveCollisions(layer.map(k => posMap[k]).filter(Boolean));
      });
    }

    // ── 7. Chain alignment ───────────────────────────────────
    // A node with exactly one predecessor that feeds only this node (linear
    // chain) is snapped to its predecessor's Y-centre. Eliminates staircases.
    function chainAlign(fwd) {
      (fwd ? bLayers : [...bLayers].reverse()).forEach(layer => {
        layer.forEach(key => {
          const ns = fwd ? bPrev(key) : bNext(key);
          if (ns.length !== 1) return;
          const other = ns[0];
          if ((fwd ? bNext(other) : bPrev(other)).length !== 1) return;
          const n = posMap[key], o = posMap[other]; if (!n || !o) return;
          n.y = Math.max(top, o.y + o.h / 2 - n.h / 2);
        });
        resolveCollisions(layer.map(k => posMap[k]).filter(Boolean));
      });
    }
    chainAlign(true);
    chainAlign(false);
    chainAlign(true); // one more fwd pass to propagate bwd corrections

    // ── 8. Vertical centring of each column within the band ──
    const spans = bLayers.map(layer => {
      const ns = layer.map(k => posMap[k]).filter(Boolean);
      if (!ns.length) return null;
      return { top: Math.min(...ns.map(n => n.y)), bot: Math.max(...ns.map(n => n.y + n.h)) };
    });
    const valid = spans.filter(Boolean);
    const bTop = Math.min(...valid.map(s => s.top));
    const bBot = Math.max(...valid.map(s => s.bot));
    const bMid = (bTop + bBot) / 2;
    bLayers.forEach((layer, li) => {
      const sp = spans[li]; if (!sp) return;
      const shift = bMid - (sp.top + sp.bot) / 2;
      if (Math.abs(shift) > 2)
        layer.forEach(k => { const n = posMap[k]; if (n) n.y = Math.max(top, n.y + shift); });
    });
    // Close any gap left above the band's content by the centring
    const ms = [...members].map(k => posMap[k]);
    const lift = Math.min(...ms.map(n => n.y)) - top;
    if (lift > 0) ms.forEach(n => { n.y -= lift; });
    return Math.max(...ms.map(n => n.y + n.h));
  }

  const BAND_HDR = 34, BAND_PAD = 18, BAND_GAP = 56;
  let bandTop = TOP_PAD;
  orderBands(groups, flows, bandOf).forEach(g => {
    const members = new Set(flows.filter(f => bandOf(f.recipe_key) === g.id).map(f => f.recipe_key));
    if (!members.size) return;
    const bLayers = layers.map(layer => layer.filter(k => members.has(k)));
    const bot = placeBand(bLayers, members, bandTop + BAND_HDR);
    const ns  = [...members].map(k => posMap[k]);
    const x   = Math.min(...ns.map(n => n.x)) - BAND_PAD;
    const sub = [
      g.rate != null ? `${Number(g.rate).toFixed(2)}/min` : null,
      `${g.recipes} recipe${g.recipes !== 1 ? 's' : ''}`,
      `${g.machines} machine${g.machines !== 1 ? 's' : ''}`,
    ].filter(Boolean).join('  ·  ');
    BANDS.push({
      id: g.id, label: g.label, sub, collapsed: COLLAPSED.has(g.id),
      x, y: bandTop,
      w: Math.max(...ns.map(n => n.x + n.w)) + BAND_PAD - x,
      h: bot + BAND_PAD - bandTop,
    });
    bandTop = bot + BAND_PAD + BAND_GAP;
  });
  const gMidFinal = (TOP_PAD + bandTop - BAND_GAP) / 2;
  const curX = colX(layers.length);

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
      // Rate-weighted, so a 414/min consumer outweighs three 5/min side taps
      let wy = 0, ws = 0;
      cons.forEach(k => { const r = flowMap[k].inputs[item] || 0; wy += (posMap[k].y + posMap[k].h / 2) * r; ws += r; });
      ty = (ws ? wy / ws : gMidFinal) - SRC_H / 2;
    } else { ty = gMidFinal - SRC_H / 2; }
    NODES.push({ id: 'SRC_' + item, x: 20, y: Math.max(TOP_PAD, ty),
                 w: SRC_W, h: SRC_H, type: 'source', data: { item, rate: srcActual[item] } });
    posMap['SRC_' + item] = NODES[NODES.length - 1];
  });
  spreadColumn(NODES.filter(n => n.type === 'source'), 10);

  // ── 10. Sink/output nodes — Y-aligned to producers ─────────
  const sinkDefs = [
    ...Object.entries(RESULT.sink_nodes            || {}).map(([i, r]) => ({ id: 'SNK_'    + i, type: 'sink',        item: i, rate: r })),
    ...Object.entries(RESULT.error_sinks           || {}).map(([i, r]) => ({ id: 'ERRSNK_' + i, type: 'errorsink',   item: i, rate: r })),
    ...Object.entries(RESULT.surplus_intermediates || {}).map(([i, r]) => ({ id: 'SURP_'   + i, type: 'surplus',     item: i, rate: r })),
    ...Object.entries(RESULT.error_sources         || {}).map(([i, r]) => ({ id: 'ERRSRC_' + i, type: 'errorsource', item: i, rate: r })),
  ];
  sinkDefs.forEach(({ id, type, item, rate }) => {
    const related = ((type === 'errorsource' ? consumers[item] : producers[item]) || []).filter(k => posMap[k]);
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
  spreadColumn(sinkDefs.map(e => posMap[e.id]).filter(Boolean), 10);

  // ── 11. Edges ──────────────────────────────────────────────
  NODES.forEach(n => { NODEMAP[n.id] = n; n.h = nodeH(n); });

  // addEdge: rate = this edge's actual flow; totalRate = full demand/supply at
  // the destination end (used by the label renderer for split-flow annotation).
  // minor = small share of the item's total flow → drawn as a short tap stub.
  function addEdge(src, tgt, item, rate, totalRate, color, dashed = false, minor = false) {
    if (!posMap[src] || !posMap[tgt]) return;
    EDGES.push({ src, tgt, item, rate, totalRate, color, dashed, minor });
  }
  const colorOf = id => id.startsWith('SRC_') ? '#cbd5e1' : mCol(flowMap[id]?.machine);
  const takerStyle = (id, color) =>
      id.startsWith('SURP_')   ? ['#f59e0b', true]
    : id.startsWith('ERRSNK_') ? ['#ef4444', true]
    : [color, false];

  if (SHOW_HUBS) buildHubEdges(); else buildDirectEdges();

  // ── ERROR SOURCE → RECIPE ─────────────────────────────────────────────────
  Object.entries(RESULT.error_sources || {}).forEach(([item, qty]) => {
    (consumers[item] || []).filter(k => posMap[k]).forEach(k =>
      addEdge('ERRSRC_' + item, k, item, qty, qty, '#ef4444', true));
  });

  // Stack stubs that leave / enter the same node so their labels don't overlap
  const sIdx = {}, tIdx = {};
  EDGES.filter(e => e.minor).forEach(e => {
    e._sIdx = sIdx[e.src] = (sIdx[e.src] ?? -1) + 1;
    e._tIdx = tIdx[e.tgt] = (tIdx[e.tgt] ?? -1) + 1;
  });

  NODES.forEach(n => { NODEMAP[n.id] = n; });
  buildSpatialHash();
  cacheEdgePaths();
  if (keepView) schedDraw(); else fitAll();

  // One splitter / merger / manifold node per item with more than one
  // supplier or more than one taker; single-path items keep a direct edge.
  function buildHubEdges() {
    const sinkMaps = [['SNK_', RESULT.sink_nodes], ['SURP_', RESULT.surplus_intermediates],
                      ['ERRSNK_', RESULT.error_sinks]];
    const items = new Set([...Object.keys(producers), ...Object.keys(consumers)]);
    const hubs = [];
    items.forEach(item => {
      const takers = (consumers[item] || []).map(k => ({ id: k, rate: flowMap[k].inputs[item] || 0 }));
      sinkMaps.forEach(([p, m]) => { if (m?.[item] > 0) takers.push({ id: p + item, rate: m[item] }); });
      const suppliers = (producers[item] || []).map(k => ({ id: k, rate: flowMap[k].outputs[item] || 0 }));
      const need = takers.reduce((s, t) => s + t.rate, 0);
      const made = suppliers.reduce((s, t) => s + t.rate, 0);
      if (need - made > 1e-6) suppliers.push({ id: 'SRC_' + item, rate: need - made });
      const ts = takers.filter(t => t.rate > 1e-9 && posMap[t.id]);
      const ss = suppliers.filter(s => s.rate > 1e-9 && posMap[s.id]);
      if (!ts.length || !ss.length) return;

      if (ts.length === 1 && ss.length === 1) {
        const [c, d] = takerStyle(ts[0].id, colorOf(ss[0].id));
        addEdge(ss[0].id, ts[0].id, item, ts[0].rate, ts[0].rate, c, d);
        return;
      }

      const total = Math.max(need, made);
      const main  = ss.reduce((a, b) => (b.rate > a.rate ? b : a));
      const color = colorOf(main.id);
      const right = Math.max(...ss.map(s => posMap[s.id].x + posMap[s.id].w));
      // Rate-weighted Y so the hub sits on the main line, not between side taps
      let wy = 0, ws = 0;
      [...ss, ...ts].forEach(p => { const n = posMap[p.id]; wy += (n.y + n.h / 2) * p.rate; ws += p.rate; });
      const hub = {
        id: 'HUB_' + item, type: 'hub', w: HUB_W, h: HUB_H,
        x: right + (XGAP - HUB_W) / 2, y: Math.max(TOP_PAD, wy / ws - HUB_H / 2),
        data: { item, rate: total, color, nIn: ss.length, nOut: ts.length },
      };
      NODES.push(hub); posMap[hub.id] = hub; hubs.push(hub);
      ss.forEach(s => addEdge(s.id, hub.id, item, s.rate, made, colorOf(s.id), false,
                              s.rate < MINOR_FRAC * total));
      // A lone supplier's edge would just repeat the hub's own rate
      if (ss.length === 1) EDGES[EDGES.length - 1].noLabel = true;
      ts.forEach(t => {
        const [c, d] = takerStyle(t.id, color);
        addEdge(hub.id, t.id, item, t.rate, need, c, d, t.rate < MINOR_FRAC * total);
      });
    });
    // Hubs sharing a gap column must not overlap each other
    const cols = {};
    hubs.forEach(h => (cols[Math.round(h.x)] = cols[Math.round(h.x)] || []).push(h));
    Object.values(cols).forEach(col => spreadColumn(col, 10));
  }

  // Original presentation: producer → consumer edges with greedy capacity
  // matching (largest producer first), so a consumer fully covered by one
  // producer gets exactly one edge.
  function buildDirectEdges() {
    Object.entries(RESULT.source_nodes || {}).forEach(([item]) => {
      (consumers[item] || []).filter(k => posMap[k]).forEach(k => {
        const rate = flowMap[k]?.inputs[item] ?? 0;
        addEdge('SRC_' + item, k, item, rate, rate, '#cbd5e1');
      });
    });

    const recipeItems = new Set();
    flows.forEach(f => {
      Object.keys(f.inputs  || {}).forEach(i => recipeItems.add(i));
      Object.keys(f.outputs || {}).forEach(i => recipeItems.add(i));
    });
    recipeItems.forEach(item => {
      const prodKeys = (producers[item] || []).filter(k => posMap[k]);
      const consKeys = (consumers[item] || []).filter(k => posMap[k]);
      if (!prodKeys.length || !consKeys.length) return;
      const supply = {};
      prodKeys.forEach(k => { supply[k] = flowMap[k]?.outputs[item] ?? 0; });
      const sortedProds = [...prodKeys].sort((a, b) => supply[b] - supply[a]);
      consKeys.forEach(tgtKey => {
        let remaining = flowMap[tgtKey]?.inputs[item] ?? 0;
        const totalConsumed = remaining;
        for (const srcKey of sortedProds) {
          if (remaining <= 1e-9) break;
          const avail = supply[srcKey] ?? 0;
          if (avail <= 1e-9) continue;
          const drawn = Math.min(avail, remaining);
          supply[srcKey] -= drawn;
          remaining      -= drawn;
          addEdge(srcKey, tgtKey, item, drawn, totalConsumed, colorOf(srcKey));
        }
      });
    });

    function addSinkEdges(itemMap, idPrefix, color, dashed) {
      Object.entries(itemMap || {}).forEach(([item, qty]) => {
        const prodKeys = (producers[item] || []).filter(k => posMap[k]);
        const supply = {};
        prodKeys.forEach(k => { supply[k] = flowMap[k]?.outputs[item] ?? 0; });
        let remaining = qty;
        [...prodKeys].sort((a, b) => supply[b] - supply[a]).forEach(k => {
          if (remaining <= 1e-9 || supply[k] <= 1e-9) return;
          const drawn = Math.min(supply[k], remaining);
          remaining -= drawn;
          addEdge(k, idPrefix + item, item, drawn, qty, color ?? colorOf(k), dashed);
        });
      });
    }
    addSinkEdges(RESULT.sink_nodes,            'SNK_',    null,      false);
    addSinkEdges(RESULT.error_sinks,           'ERRSNK_', '#ef4444', true);
    addSinkEdges(RESULT.surplus_intermediates, 'SURP_',   '#f59e0b', true);

    // Small shares of an item that fans out to several places become stubs
    const itemTot = {}, itemCnt = {};
    EDGES.forEach(e => { itemTot[e.item] = (itemTot[e.item] || 0) + e.rate; itemCnt[e.item] = (itemCnt[e.item] || 0) + 1; });
    EDGES.forEach(e => { e.minor = itemCnt[e.item] > 1 && e.rate < MINOR_FRAC * itemTot[e.item]; });
  }
}

// Push overlapping nodes in one column apart (top-down), keeping order by y.
function spreadColumn(nodes, gap) {
  nodes.sort((a, b) => a.y - b.y).forEach((n, i, arr) => {
    if (i > 0 && n.y < arr[i-1].y + arr[i-1].h + gap) n.y = arr[i-1].y + arr[i-1].h + gap;
  });
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

function edgeInChain(e) {
  return (e.src === FOCUSED || FOCUS_UP.has(e.src) || FOCUS_DN.has(e.src)) &&
         (e.tgt === FOCUSED || FOCUS_UP.has(e.tgt) || FOCUS_DN.has(e.tgt));
}

function edgeFocusAlpha(e) {
  if (!FOCUSED) return 0.82;
  return edgeInChain(e) ? 1 : 0.06;
}

function edgeFocusWidth(e) {
  if (!FOCUSED) return 1.6 / ZOOM;
  return edgeInChain(e) ? 2.4 / ZOOM : 1 / ZOOM;
}

// Small taps are stubs unless toggled on, hovered, or part of the focused chain
function edgeIsStub(e) {
  if (!e.minor || SHOW_MINOR_FULL) return false;
  if (HIT && (e.src === HIT || e.tgt === HIT)) return false;
  if (FOCUSED && edgeInChain(e)) return false;
  return true;
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
  const boxes = [...NODES.map(n => ({ x: n.x, y: n.y, w: n.w, h: nodeH(n) })), ...BANDS];
  const minX = Math.min(...boxes.map(b => b.x));
  const minY = Math.min(...boxes.map(b => b.y));
  const maxX = Math.max(...boxes.map(b => b.x + b.w));
  const maxY = Math.max(...boxes.map(b => b.y + b.h));
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

  // Goal bands behind everything
  BANDS.forEach(b => { if (b.x + b.w >= vp.x1 && b.x <= vp.x2 && b.y + b.h >= vp.y1 && b.y <= vp.y2) drawBand(b); });

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
  if (edgeIsStub(e)) { drawStub(e); return; }
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
  if (ZOOM >= 0.35 && alpha > 0.3 && !e.noLabel) {
    const rateStr = perMin(e.item, e.rate, 2, true);
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

// ── Small tap stub ───────────────────────────────────────
// A short dashed lead out of the source and into the target, each labelled,
// instead of a long curve across the canvas. Hover either end to see it in full.
function drawStub(e) {
  const L  = 26;
  const sy = e._y1 + 12 + (e._sIdx || 0) * 13;
  const ty = e._y2 - 12 - (e._tIdx || 0) * 13;
  C.globalAlpha = FOCUSED ? 0.06 : 0.75;
  C.strokeStyle = e.color; C.fillStyle = e.color;
  C.lineWidth   = 1.2 / ZOOM;
  C.setLineDash([3 / ZOOM, 2 / ZOOM]);
  C.beginPath(); C.moveTo(e._x1, e._y1); C.quadraticCurveTo(e._x1 + L * 0.5, e._y1, e._x1 + L, sy); C.stroke();
  C.beginPath(); C.moveTo(e._x2 - L, ty); C.quadraticCurveTo(e._x2 - L * 0.5, e._y2, e._x2, e._y2); C.stroke();
  C.setLineDash([]);
  circleFill(e._x1 + L, sy, 2.2); C.fill();
  circleFill(e._x2 - L, ty, 2.2); C.fill();

  if (ZOOM >= 0.45 && !FOCUSED) {
    const rate = perMin(e.item, e.rate, 2, true);
    const tn = NODEMAP[e.tgt];
    const tLabel = tn?.type === 'recipe' ? cleanDisplay(tn.data.display) : itemName(tn?.data?.item || '');
    C.font = `9px 'JetBrains Mono',monospace`; C.textBaseline = 'middle';
    C.textAlign = 'left';  C.fillText(`→ ${tLabel}  ${rate}`, e._x1 + L + 5, sy);
    C.textAlign = 'right'; C.fillText(`${itemName(e.item)}  ${rate} →`, e._x2 - L - 5, ty);
    C.textAlign = 'left';  C.textBaseline = 'alphabetic';
  }
  C.globalAlpha = 1;
}

function cleanDisplay(d) {
  return (d || '').replace(/\(Alt\)/g, '').replace(/^Alternate:\s*/i, '').trim();
}

// ── Goal band ────────────────────────────────────────────
function drawBand(b) {
  C.globalAlpha = FOCUSED ? 0.4 : 1;
  C.fillStyle = 'rgba(255,255,255,0.018)';
  roundRectFill(b.x, b.y, b.w, b.h, 14);
  C.strokeStyle = '#232838'; C.lineWidth = 1 / ZOOM;
  roundRectStroke(b.x, b.y, b.w, b.h, 14);
  const hy = b.y + 18;
  C.textBaseline = 'middle';
  C.font = '600 13px Inter,sans-serif'; C.fillStyle = '#f59e0b';
  const title = `${b.collapsed ? '▸' : '▾'}  ${b.label}`;
  C.fillText(title, b.x + 14, hy);
  const tw = C.measureText(title).width;
  C.font = '11px JetBrains Mono,monospace'; C.fillStyle = '#616880';
  C.fillText(b.sub, b.x + 14 + tw + 14, hy);
  b._hdr = { x: b.x, y: b.y, w: Math.max(b.w, tw + C.measureText(b.sub).width + 42), h: 34 };
  C.textBaseline = 'alphabetic';
  C.globalAlpha = 1;
}

function hitBandHeader(cx, cy) {
  const wx = (cx - PAN.x) / ZOOM, wy = (cy - PAN.y) / ZOOM;
  return BANDS.find(b => b._hdr && wx >= b._hdr.x && wx <= b._hdr.x + b._hdr.w &&
                         wy >= b._hdr.y && wy <= b._hdr.y + b._hdr.h) || null;
}

// ── Splitter / merger node ───────────────────────────────
function drawHub(n) {
  const { x, y, w, h, data } = n;
  const col = data.color;
  const kind = data.nIn > 1 && data.nOut > 1 ? 'MANIFOLD' : data.nOut > 1 ? 'SPLIT' : 'MERGE';
  C.fillStyle = 'rgba(0,0,0,0.35)'; roundRectFill(x + 1, y + 1, w, h, h / 2);
  C.fillStyle = '#151923';          roundRectFill(x, y, w, h, h / 2);
  C.strokeStyle = (n.id === FOCUSED || n.id === HIT) ? '#f59e0b' : col + '99';
  C.lineWidth = n.id === FOCUSED ? 2 : 1.2;
  roundRectStroke(x, y, w, h, h / 2);
  C.textBaseline = 'middle';
  C.font = 'bold 8px JetBrains Mono,monospace'; C.fillStyle = col;
  C.textAlign = 'left';  C.fillText(kind, x + 14, y + 12);
  C.font = '9px JetBrains Mono,monospace'; C.fillStyle = '#9aa0b4';
  C.textAlign = 'right'; C.fillText(perMin(data.item, data.rate, 2, true), x + w - 14, y + 12);
  C.font = '600 11px Inter,sans-serif'; C.fillStyle = '#e8eaf0';
  C.textAlign = 'center'; C.fillText(measureTrunc(itemName(data.item), w - 20), x + w / 2, y + 27);
  C.textAlign = 'left'; C.textBaseline = 'alphabetic';
  C.fillStyle = col; C.strokeStyle = '#151923'; C.lineWidth = 2;
  circleFill(x,     y + h / 2, 4); C.fill(); C.stroke();
  circleFill(x + w, y + h / 2, 4); C.fill(); C.stroke();
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
  if (type === 'hub')         { drawHub(n); C.globalAlpha = 1; return; }

  const f     = data;
  const color = f.isGroup ? '#f59e0b' : mCol(f.machine);
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
  const abbr  = f.isGroup ? 'GROUP' : (MABBR[f.machine] || f.machine);
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
  const cleanName = cleanDisplay(f.display);
  C.font = '600 12px Inter,sans-serif'; C.fillStyle = '#e8eaf0'; C.textBaseline = 'middle';
  C.fillText(measureTrunc(cleanName, w - 22), x + 10, cy + 7);
  cy += 16;

  // Machine count — layouts can mix groups, e.g. "2×250% + 1×133.3% 🔮2 + 3×100%"
  const layout  = f.layout || [];
  const isMixed = layout.length > 1;
  const pct = v => `${Number(v).toFixed(1).replace(/\.0$/, '')}%`;
  C.font = '10px JetBrains Mono,monospace'; C.fillStyle = '#616880';
  {
    const machineLabel = f.isGroup
      ? `${f.memberCount} recipes  ·  ${f.machines_final} machines`
      : isMixed
      ? `${layout.map(g => `${g.count}×${pct(g.clock_pct)}${g.sloops ? ` 🔮${g.sloops}` : ''}`).join(' + ')}  (${f.machines_float.toFixed(2)} LP)`
      : `${f.machines_final} machine${f.machines_final !== 1 ? 's' : ''}  (${f.machines_float.toFixed(2)} LP)`;
    C.fillText(measureTrunc(machineLabel, w - 22), x + 10, cy + 7);
  }
  cy += 16;

  // Stats bar
  C.fillStyle = '#1f2435'; C.fillRect(x, cy, w, STATS_H);
  C.strokeStyle = '#272d3d'; C.lineWidth = 0.5;
  C.beginPath(); C.moveTo(x, cy); C.lineTo(x + w, cy); C.stroke();

  // Mixed layouts show every group's clock ("250/133/100%") and the total shard count
  const clk    = f.clock_pct ?? 100;
  // Clock colour: orange if any machine is overclocked, blue if all underclocked, grey if 100%
  const clkCol = clk > 100.1 ? '#fb923c' : clk < 99.9 ? '#38bdf8' : '#616880';
  const clkLabel = isMixed
    ? `⏱${layout.map(g => Number(g.clock_pct).toFixed(0)).join('/')}%`
    : `⏱${clk.toFixed(1)}%`;
  C.font = '10px JetBrains Mono,monospace'; C.textBaseline = 'middle';
  let sx = x + 7;
  const stat = (t, fill) => { C.fillStyle = fill; C.fillText(t, sx, cy + STATS_H / 2); sx += C.measureText(t).width + 7; };
  if (!f.isGroup) stat(clkLabel, clkCol);
  stat(`⚡${f.power_mw.toFixed(0)}MW`, '#fb923c');
  if (f.has_shard) {
    const shardLabel = isMixed
      ? `💎${f.shards_used}`
      : `💎${Math.round(f.shards_used / (f.machines_final || 1))}/m`;
    stat(shardLabel, '#3b82f6');
  }
  if (f.has_sloop) stat(`🔮${f.sloops_used} ×${(f.output_multiplier || 1).toFixed(2)}`, '#a855f7');
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
  const ioRow = (label, rate, lc, item) => {
    C.font = '11px Inter,sans-serif'; C.fillStyle = lc; C.textBaseline = 'middle';
    C.fillText(measureTrunc(label, w - 85), x + 12, cy + IO_H / 2);
    C.font = '10px JetBrains Mono,monospace'; C.fillStyle = '#9aa0b4';
    C.textAlign = 'right'; C.fillText(perMin(item, rate, 2, true), x + w - 8, cy + IO_H / 2);
    C.textAlign = 'left'; C.textBaseline = 'alphabetic'; cy += IO_H;
  };

  const ins  = Object.entries(f.inputs  || {});
  const outs = Object.entries(f.outputs || {});
  if (ins.length)  { divider('Inputs');  ins.forEach(([k, r]) => ioRow('← ' + itemName(k), r, '#9aa0b4', k)); }
  if (outs.length) {
    divider('Outputs' + (f.has_sloop ? ` ×${(f.output_multiplier || 1).toFixed(2)}` : ''));
    outs.forEach(([k, r]) => ioRow('→ ' + itemName(k), r, '#22c55e', k));
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
  C.fillText(perMin(data?.item, data?.rate), x + w / 2, y + 44);
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
    const band = hitBandHeader(pos.x, pos.y);
    BANDCLICK = band ? { band, x: pos.x, y: pos.y } : null;
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
      schedDraw();
    }
    CV.style.cursor = (HIT || hitBandHeader(pos.x, pos.y)) ? 'pointer' : 'default';
  });

  window.addEventListener('mouseup', e => {
    if (BANDCLICK && !DRAG) {
      const pos = getPos(e);
      const clicked = Math.hypot(pos.x - BANDCLICK.x, pos.y - BANDCLICK.y) < 4;
      const id = BANDCLICK.band.id;
      BANDCLICK = null;
      PANSTART = null;
      if (clicked) { toggleBand(id); return; }
    }
    BANDCLICK = null;
    if (DRAG) {
      if (!DRAG.moved) {
        const n = DRAG.node;
        setFocus(n.id);
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
      if (node.data?.isGroup) { toggleBand(node.data.groupId); return; }
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
