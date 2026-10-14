// Belt splits (frontend/splits.js): every output gets exactly its rate, with few structures.
//   node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { design, parseSplit, splitBelt, splitSVG, streamCount, feedPattern } from '../frontend/splits.js';

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
