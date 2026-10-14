// Geometry (frontend/geometry.js): belt splits — every output gets exactly its
// rate, with few structures — and the bands between factories — one per pair,
// its items as stripes side by side, as wide as their rates.
//   node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { design, parseSplit, splitBelt, splitSVG, streamCount, feedPattern,
         bundle, bandStripes, bandScale, sankeyLayout } from '../frontend/geometry.js';

// ── Belt splits ──
const ev = t => { const v = Number(t); return Number.isFinite(v) ? v : null; };

// Every output gets exactly its rate: follow the graph from the belts in
function check(d, ins, outs) {
  const g = d.graph, into = g.nodes.map(() => 0), from = g.nodes.map(() => 0);
  g.edges.forEach(e => { into[e.b] += e.rate; from[e.a] += e.rate; });
  g.nodes.forEach(n => {
    if (n.kind === 'in') assert.ok(Math.abs(from[n.id] - n.rate) < 1e-6, 'a belt in sends all it has');
    if (n.kind === 'out') assert.ok(Math.abs(into[n.id] - n.rate) < 1e-6, `output ${n.rate} gets ${into[n.id]}`);
    if (n.kind === 'split' || n.kind === 'merge') assert.ok(Math.abs(into[n.id] - from[n.id]) < 1e-6, 'nothing lost');
    if (n.kind === 'split') {
      const outs = g.edges.filter(e => e.a === n.id);
      assert.ok(outs.length === 2 || outs.length === 3);
      outs.forEach(e => assert.ok(Math.abs(e.rate - into[n.id] / outs.length) < 1e-6, 'a splitter divides evenly'));
    }
    if (n.kind === 'merge') assert.ok(g.edges.filter(e => e.b === n.id).length <= 3);
  });
  assert.equal(g.nodes.filter(n => n.kind === 'split').length, d.splitters);
  assert.equal(g.nodes.filter(n => n.kind === 'merge').length, d.mergers);
  const want = [...outs].sort((a, b) => a - b), got = g.nodes.filter(n => n.kind === 'out' && !n.rest).map(n => n.rate).sort((a, b) => a - b);
  assert.deepEqual(got, want);
  assert.equal(g.nodes.filter(n => n.kind === 'in').length, ins.length);
}

test('streams are 2^a·3^b and cover the shares', () => {
  for (const d of [1, 5, 7, 8, 13, 80]) {
    const { n } = streamCount(d);
    assert.ok(n >= d);
    let m = n; while (m % 2 === 0) m /= 2; while (m % 3 === 0) m /= 3;
    assert.equal(m, 1);
  }
});

test('one belt into exact shares', () => {
  assert.equal(splitBelt(780, [260, 260, 260]).splitters, 1);   // thirds: one splitter, nothing back
  assert.equal(splitBelt(780, [260, 260, 260]).loop, 0);
  for (const [i, o] of [[400, [395, 5]], [480, [300, 180]], [270, [45, 90, 135]], [60, [13.5, 46.5]], [120, [13.5, 46.5, 60]]]) {
    const d = design([i], o);
    check(d, [i], o);
  }
});

test('several belts: each feeds a few outputs, no big balancer', () => {
  const ins = [120, 120, 120, 120], outs = [80, 80, 80, 80, 80, 40, 20, 20];
  const d = design(ins, outs);
  check(d, ins, outs);
  assert.equal(d.merged, false);
  assert.ok(d.splitters + d.mergers <= 10, `${d.splitters} + ${d.mergers}`);
  const same = design([270, 270, 270], [405, 405]);
  check(same, [270, 270, 270], [405, 405]);
  assert.equal(same.splitters, 1);                // the middle belt halves
  const direct = design([120, 60], [60, 120]);    // belts that match go straight through
  assert.equal(direct.splitters + direct.mergers, 0);
});

test('left over leaves on its own; more out than in is an error', () => {
  const d = design([400], [100]);
  check(d, [400], [100]);
  assert.equal(d.rest, 300);
  assert.ok(design([100], [60, 50]).error);
});

test('belts over the tier show', () => {
  const d = design([780, 780], [1200, 360], { cap: 780 });
  assert.ok(d.over > 0);
  assert.ok(d.graph.edges.some(e => e.over));
});

test('parsing: belts, counts, sums', () => {
  assert.deepEqual(parseSplit('4 x 120 into 5 x 80 + 40 + 20 + 20', ev), { ins: [120, 120, 120, 120], outs: [80, 80, 80, 80, 80, 40, 20, 20] });
  assert.deepEqual(parseSplit('480 -> 300, 180', ev), { ins: [480], outs: [300, 180] });
  assert.deepEqual(parseSplit('2×60 → 120', ev), { ins: [60, 60], outs: [120] });
  assert.equal(parseSplit('Iron Plate', ev), null);
  assert.equal(parseSplit('480 into', ev), null);
});

test('drawn without gaps', () => {
  const d = design([120, 120, 120, 120], [80, 80, 80, 80, 80, 40, 20, 20]);
  const svg = splitSVG(d.graph, v => String(+v.toFixed(2)));
  assert.ok(!svg.includes('NaN') && !svg.includes('undefined'));
  assert.equal((svg.match(/class="sp-e/g) || []).length, d.graph.edges.length);
});

test('feeding n machines: a pattern that repeats', () => {
  const nine = feedPattern(270, 9);                 // 3 ways, then each 3 ways: 9 belts of 30
  assert.deepEqual(nine.splits, [3, 3]); assert.equal(nine.spare, 0); assert.equal(nine.splitters, 4); assert.equal(nine.each, 30);
  const ten = feedPattern(400, 10);                 // 12 ends, 2 looped back: each carries 40, the start 480
  assert.deepEqual(ten.splits, [2, 2, 3]); assert.equal(ten.spare, 2); assert.equal(ten.load, 480); assert.equal(ten.splitters, 7);
  assert.equal(feedPattern(480, 16).splitters, 15);
});

// ── Bands between factories ──
const flows = [
  { from: 'oil', to: 'cat', item: 'Plastic', rate: 40 },
  { from: 'oil', to: 'cat', item: 'Rubber', rate: 20 },
  { from: 'cat', to: 'oil', item: 'Quickwire', rate: 60 },
  { from: 'oil', to: 'iron', item: 'Fuel', rate: 10 },
  { from: 'oil', to: 'cat', item: 'Dust', rate: 0 },          // nothing moves: left out
];
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('one bundle per pair, both ways together; directed keeps them apart', () => {
  const g = bundle(flows);
  assert.equal(g.length, 2);
  const oc = g.find(x => x.items.length === 3);
  assert.equal(oc.total, 120);
  assert.deepEqual(oc.items.map(f => f.item), ['Quickwire', 'Plastic', 'Rubber']);   // widest first
  assert.equal(bundle(flows, true).length, 3);
});

test('stripes sit side by side across the band, centred, as wide as their rates', () => {
  const items = bundle(flows)[0].items;
  const p = [0, 0], q = [100, 0];                 // horizontal: across = y
  const { width, stripes } = bandStripes(p, q, items, 0.5);
  near(width, 60);                                // 120/min × 0.5 px
  assert.equal(stripes.length, 3);
  near(stripes[0].y1 - stripes[0].w / 2, -width / 2);           // first edge on one side
  near(stripes.at(-1).y1 + stripes.at(-1).w / 2, width / 2);    // last on the other
  for (let i = 1; i < stripes.length; i++)                      // touching, no gaps or overlaps
    near(stripes[i - 1].y1 + stripes[i - 1].w / 2, stripes[i].y1 - stripes[i].w / 2);
  stripes.forEach(s => { near(s.x1, 0); near(s.x2, 100); near(s.y1, s.y2); });   // parallel to the band
  // a diagonal band: every stripe parallel, the band as wide as before
  const d = bandStripes([0, 0], [30, 40], items, 0.5);
  d.stripes.forEach(s => near((s.x2 - s.x1) * 40 - (s.y2 - s.y1) * 30, 0, 1e-6));
  const s0 = d.stripes[0], sN = d.stripes.at(-1);
  near(Math.hypot(sN.x1 - s0.x1, sN.y1 - s0.y1) + (s0.w + sN.w) / 2, d.width, 1e-6);
  // thin flows still show
  assert.ok(bandStripes(p, q, [{ item: 'x', rate: 0.1 }], 0.5).stripes[0].w >= 2);
});

test('the fullest band is at most maxPx wide', () => {
  near(bandScale(bundle(flows), 30) * 120, 30);
  assert.equal(bandScale([{ total: 5 }], 30), 1);   // never wider than 1 px per item/min
});

test('sankey: a band per pair, stripes stacked at both ends, nothing overlapping', () => {
  const links = [...flows.filter(f => f.rate > 0), { from: 'cat', to: '@storage', item: 'Computer', rate: 30 }];
  const L = sankeyLayout(links, { W: 900, H: 500 });
  assert.equal(L.bundles.length, 4);                 // directed: oil→cat, cat→oil, oil→iron, cat→storage
  const oc = L.bundles.find(b => b.from === 'oil' && b.to === 'cat');
  assert.equal(oc.stripes.length, 2);
  near(oc.w, oc.stripes.reduce((s, x) => s + x.w, 0));
  oc.stripes.forEach((s, i) => { if (i) { near(s.y1, oc.stripes[i - 1].y1 + oc.stripes[i - 1].w); near(s.y2, oc.stripes[i - 1].y2 + oc.stripes[i - 1].w); } });
  // at every node, bands leaving (and arriving) tile it from the top without overlap
  for (const [key, n] of Object.entries(L.nodes)) {
    for (const [side, y] of [['from', 'y1'], ['to', 'y2']]) {
      const bs = L.bundles.filter(b => b[side] === key).sort((a, b) => a[y] - b[y]);
      let at = n.y;
      bs.forEach(b => { near(b[y], at, 1e-6); at += b.w; });
      assert.ok(at <= n.y + n.h + 1e-6);
    }
  }
  // storage is the last column; a cycle (oil ⇄ cat) still lays out
  const storeCol = L.cols.findIndex(c => c.includes('@storage'));
  assert.equal(storeCol, L.cols.length - 1);
});
