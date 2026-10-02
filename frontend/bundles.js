/**
 * bundles.js — everything moving between two factories as one band.
 *
 * One band per pair of factories, as thick as all it carries; inside, one
 * stripe per item, side by side, each as wide as its rate and in the item's
 * colour. Used for the routes on the Blackboard and for the Flows Sankey.
 * Pure functions — no DOM — so they can be checked on their own.
 */

// A colour per item, the same wherever it moves: one of twelve that read apart
// on the dark board (fluids from their own blues)
const PALETTE = ['#e6a23c', '#4fb3a9', '#d9616f', '#8f7cf0', '#7bc96f', '#e07f3a',
                 '#5aa0e8', '#c977c9', '#c9b458', '#6dc3d6', '#e58fb0', '#9aa6b8'];
const FLUIDS = ['#3fa7f5', '#5bc8f0', '#2f7fd8', '#7fb7d9'];
const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export const itemColor = (item, fluid = false) =>
  (fluid ? FLUIDS : PALETTE)[hash(item) % (fluid ? FLUIDS.length : PALETTE.length)];

/** Flows [{from, to, item, rate}] grouped into one bundle per pair of ends
 *  (either direction, unless `directed`), items widest first. */
export function bundle(flows, directed = false) {
  const by = new Map();
  flows.forEach(f => {
    if (!(f.rate > 0)) return;
    const [a, b] = directed || f.from < f.to ? [f.from, f.to] : [f.to, f.from];
    const k = `${a}\u0000${b}`;
    if (!by.has(k)) by.set(k, { a, b, total: 0, items: [] });
    const g = by.get(k);
    g.total += f.rate;
    g.items.push(f);
  });
  const out = [...by.values()];
  out.forEach(g => g.items.sort((x, y) => y.rate - x.rate || x.item.localeCompare(y.item)));
  return out;
}

/**
 * The stripes of a straight band from point p to point q: each item a line
 * of its own width, side by side across the band, centred on p–q.
 * scale: px per item/min; minPx: the thinnest a stripe is drawn.
 * Returns { width, stripes: [{ flow, w, x1, y1, x2, y2 }] }.
 */
export function bandStripes(p, q, items, scale, minPx = 2) {
  const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;                 // across the band
  const ws = items.map(f => Math.max(minPx, f.rate * scale));
  const width = ws.reduce((s, w) => s + w, 0);
  let off = -width / 2;
  const stripes = items.map((f, i) => {
    const c = off + ws[i] / 2;
    off += ws[i];
    return { flow: f, w: ws[i], x1: p[0] + nx * c, y1: p[1] + ny * c, x2: q[0] + nx * c, y2: q[1] + ny * c };
  });
  return { width, stripes };
}

/** px per item/min so the fullest band is at most maxPx wide. */
export const bandScale = (bundles, maxPx = 30) =>
  Math.min(1, maxPx / Math.max(1e-9, ...bundles.map(g => g.total)));

/**
 * A Sankey of flows between factories (and STORE): columns left to right by
 * who takes from whom, a node as tall as what passes through it, and one
 * band per pair of factories made of its items' stripes.
 * Returns { cols, nodes: {key: {x, y, h, size}}, bundles: [{from, to, total, y1, y2, w, stripes: [{flow, y1, y2, w}]}], k }.
 */
export function sankeyLayout(links, { W, H, nodeW = 14, gap = 26, padL = 8, padR = 150, store = '@storage' }) {
  const keys = [...new Set(links.flatMap(l => [l.from, l.to]))];
  const col = Object.fromEntries(keys.map(k => [k, 0]));
  for (let pass = 0; pass < keys.length; pass++)   // a cycle stops after a pass per node
    links.forEach(l => { if (l.to !== store && col[l.to] < col[l.from] + 1) col[l.to] = col[l.from] + 1; });
  const last = Math.max(0, ...keys.filter(k => k !== store).map(k => col[k]));
  if (store in col) col[store] = last + 1;
  const cols = [];
  keys.forEach(k => (cols[col[k]] = cols[col[k]] || []).push(k));
  for (let i = 0; i < cols.length; i++) cols[i] = cols[i] || [];
  const sum = (k, side) => links.filter(l => l[side] === k).reduce((s, l) => s + l.rate, 0);
  const size = k => Math.max(sum(k, 'to'), sum(k, 'from'));
  const big = Math.max(1e-9, ...keys.map(size));
  // one scale for every band: the fullest column fits, and no node takes more than ~40% of the height
  const k = Math.min(0.4 * H / big, ...cols.filter(c => c.length).map(c => (H - gap * (c.length - 1)) / c.reduce((s, n) => s + size(n), 0)));
  const nodes = {};
  cols.forEach((c, ci) => {
    let y = 0;
    const x = padL + (cols.length === 1 ? 0 : ci * (W - padL - padR - nodeW) / (cols.length - 1));
    c.forEach(n => { const h = Math.max(4, size(n) * k); nodes[n] = { x, y, h, size: size(n), inY: y, outY: y }; y += h + gap; });
  });
  // Bands in the order their ends sit, so a pair's stripes stay together at both ends
  const groups = bundle(links, true).sort((g, h) => nodes[g.a].y - nodes[h.a].y || nodes[g.b].y - nodes[h.b].y);
  const bundles = groups.map(g => {
    const a = nodes[g.a], b = nodes[g.b], y1 = a.outY, y2 = b.inY;
    const stripes = g.items.map(f => {
      const w = Math.max(1, f.rate * k);
      const s = { flow: f, y1: a.outY, y2: b.inY, w };
      a.outY += w; b.inY += w;
      return s;
    });
    return { from: g.a, to: g.b, total: g.total, items: g.items, y1, y2, w: a.outY - y1, stripes };
  });
  return { cols, nodes, bundles, k, nodeW };
}
