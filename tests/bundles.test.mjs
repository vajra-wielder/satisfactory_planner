// Bands between factories (frontend/bundles.js): one band per pair, its
// items as stripes side by side, as wide as their rates.
//   node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle, bandStripes, bandScale, sankeyLayout } from '../frontend/bundles.js';

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
