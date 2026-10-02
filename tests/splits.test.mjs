// Belt splits (frontend/splits.js): every output gets exactly its rate.
//   node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exactSplit, recommend, streamCount } from '../frontend/splits.js';

const exact = (input, outs) => {
  const r = exactSplit(input, outs);
  assert.ok(r, `${input} → ${outs}`);
  r.outputs.filter(o => !o.rest).forEach((o, i) => assert.ok(Math.abs(o.streams * r.perStream - outs[i]) < 1e-6));
  assert.ok(Math.abs(r.outputs.reduce((s, o) => s + o.streams, 0) + r.loopback.streams - r.streams) < 1e-9);
  return r;
};

test('streams are 2^a·3^b and cover the shares', () => {
  for (const d of [1, 5, 7, 8, 13, 80]) {
    const { n } = streamCount(d);
    assert.ok(n >= d);
    let m = n; while (m % 2 === 0) m /= 2; while (m % 3 === 0) m /= 3;
    assert.equal(m, 1);
  }
});

test('exact splits', () => {
  exact(400, [395, 5]);
  exact(480, [300, 180]);                  // 5/8
  const r = exact(780, [260, 260, 260]);    // thirds: one splitter, nothing back
  assert.equal(r.splitters, 1);
  assert.equal(r.loopback.streams, 0);
  exact(270, [45, 90, 135]);
  exact(60, [13.5, 46.5]);
  const rest = exactSplit(400, [100]);       // what's left leaves on its own belt
  assert.equal(rest.outputs.at(-1).rest, true);
  assert.equal(exactSplit(100, [60, 50]), null);   // more out than in
});

test('machine-fed outputs are manifolded, not balanced', () => {
  const m = recommend(400, [{ rate: 120, machines: true }, { rate: 120, machines: true }]);
  assert.equal(m.exact, null);
  assert.equal(m.splitters, 1);
  const one = recommend(400, [{ rate: 300, machines: true }, { rate: 100, machines: false }]);
  assert.equal(one.exact, null);             // the main line is the exact rest
  const two = recommend(400, [{ rate: 100, machines: true }, { rate: 150, machines: false }, { rate: 150, machines: false }]);
  assert.ok(two.exact);
});
