/**
 * splits.js — splitter/merger designs for dividing one belt into exact shares.
 *
 * Satisfactory splitters divide evenly into 2 or 3; mergers join up to 3.
 * An exact split into shares p₁ : p₂ : … (summing to d) is built by splitting
 * the belt into N equal streams with a tree of splitters, N = 2^a·3^b ≥ d, and
 * handing each output pᵢ streams; the N − d spare streams loop back into the
 * input (so every stream carries input ÷ d). Outputs take whole sub-trees,
 * biggest first, so few splitters and mergers are needed.
 *
 * Pure functions — no DOM — so they can be checked on their own.
 */

// Shares as small whole numbers: rates → integers (to 0.001) ÷ their gcd
export function shares(rates) {
  const scale = 1000;
  const ints = rates.map(r => Math.round(r * scale));
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = ints.filter(x => x > 0).reduce(gcd, 0) || 1;
  return ints.map(x => x / g);
}

// Smallest N = 2^a·3^b ≥ d, splitting by 2 first (smaller trees)
export function streamCount(d) {
  let best = null;
  for (let b = 0, p3 = 1; p3 <= 2 * d + 2; b++, p3 *= 3) {
    let a = 0, n = p3;
    while (n < d) { n *= 2; a++; }
    if (!best || n < best.n || (n === best.n && b < best.b)) best = { n, a, b };
  }
  return best;
}

/**
 * Exact balancer for `input` /min into `outputs` /min. Input the outputs don't
 * use leaves on a last "rest" output (rest: true). Returns { streams,
 * perStream, factors, splitters, steps, mergers, loopback, inputLoad,
 * outputs: [{ rate, streams, pieces, mergers, rest? }] } or null.
 */
export function exactSplit(input, outputs, maxStreams = 6561) {
  const want = outputs.filter(r => r > 0);
  const total = want.reduce((s, r) => s + r, 0);
  if (!(input > 0) || !want.length || total > input + 1e-9) return null;
  const rest = input - total > 1e-9 ? input - total : 0;
  if (rest) want.push(rest);                         // what's left leaves on its own belt
  const parts = shares(want);
  const d = parts.reduce((s, p) => s + p, 0);
  const { n: N, a, b } = streamCount(d);
  if (N > maxStreams) return null;
  const factors = [...Array(a).fill(2), ...Array(b).fill(3)];

  // Free sub-trees as [size, depth]; splitting one costs a splitter
  const free = [[N, 0]];
  let splitters = 0;
  const splits = [];                                 // [size split, ways], in build order
  const take = amount => {
    const pieces = [];
    let left = amount;
    while (left > 0) {
      free.sort((x, y) => y[0] - x[0]);
      const i = free.findIndex(([s]) => s <= left);
      if (i >= 0) {
        const [s] = free.splice(i, 1)[0];
        pieces.push(s); left -= s;
      } else {
        // split the smallest sub-tree still bigger than what's needed
        let j = -1;
        free.forEach(([s], k) => { if (s > left && (j < 0 || s < free[j][0])) j = k; });
        const [s, depth] = free.splice(j, 1)[0];
        const f = factors[depth];
        for (let c = 0; c < f; c++) free.push([s / f, depth + 1]);
        splitters++;
        splits.push([s, f]);
      }
    }
    return pieces;
  };
  const merge = k => Math.ceil(Math.max(0, k - 1) / 2);   // 3-way mergers to join k streams

  const loop = N - d;                                // padding streams, sent back to the input
  const order = parts.map((p, i) => [p, i]).sort((x, y) => y[0] - x[0]);
  const outs = new Array(parts.length);
  order.forEach(([p, i]) => {
    const pieces = take(p);
    outs[i] = { rate: want[i], streams: p, pieces, mergers: merge(pieces.length),
                ...(rest && i === want.length - 1 ? { rest: true } : {}) };
  });
  const loopPieces = loop ? take(loop) : [];
  const perStream = input / d;
  // Merge the same splits into steps: "split a 135/min belt 3 ways (×2)"
  const steps = [];
  splits.forEach(([size, ways]) => {
    const last = steps[steps.length - 1];
    if (last && last.size === size && last.ways === ways) last.count++;
    else steps.push({ size, ways, count: 1 });
  });
  steps.forEach(st => { st.rate = st.size * perStream; st.into = st.rate / st.ways; });
  return {
    streams: N, perStream, factors, splitters, steps,
    mergers: outs.reduce((s, o) => s + o.mergers, 0) + (loop ? merge(loopPieces.length + 1) : 0),
    loopback: { streams: loop, rate: loop * perStream, pieces: loopPieces },
    inputLoad: input + loop * perStream,              // belt into the first splitter
    outputs: outs,
  };
}

// Lanes of a given capacity for a rate (at least 1)
export const lanes = (rate, cap) => Math.max(1, Math.ceil(rate / cap - 1e-9));

// The slowest tier whose capacity covers `rate`, from { Mk1: 60, … }
export function tierFor(rate, tiers) {
  const t = Object.entries(tiers).sort((x, y) => x[1] - y[1]).find(([, c]) => c >= rate - 1e-9);
  return t ? t[0] : null;
}
