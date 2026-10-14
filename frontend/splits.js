/**
 * splits.js — splitters and mergers that turn some belts into exact others.
 *
 * Satisfactory splitters divide evenly into 2 or 3; mergers join up to 3.
 * One belt into exact shares p₁ : p₂ : … (summing to d) is a tree of splitters
 * into N equal streams, N = 2^a·3^b ≥ d, each output taking pᵢ of them; the
 * N − d spare streams loop back into the belt (so every stream carries
 * belt ÷ d). Outputs take whole sub-trees, biggest first, so few structures.
 *
 * Several belts in: each feeds some of the outputs (an output may take from
 * several), so most belts need one splitter or none. The ways of sharing the
 * belts out are searched (every order of the belts and outputs, filled in
 * turn), and merging them all into one first; the fewest splitters and
 * mergers wins — then no belt over its tier, then the fewest loop-backs.
 *
 * Pure functions — no DOM — so they can be checked on their own.
 */

const r6 = v => Math.round(v * 1e6) / 1e6;
const MAX_STREAMS = 6561;

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

// ── Building a design: a graph of belts, splitters and mergers ──
const node = (g, kind, extra = {}) => { g.nodes.push({ id: g.nodes.length, kind, ...extra }); return g.nodes.length - 1; };
const edge = (g, a, b, rate, back = false) => g.edges.push({ a, b, rate: r6(rate), back });
// Join belts with 3-way mergers, down to `to` belts (null when counting: just how many)
function join(g, list, to = 1) {
  let n = 0;
  list = [...list];
  while (list.length > to) {
    const k = Math.min(3, list.length - to + 1);
    const take = list.splice(0, k), rate = take.reduce((s, p) => s + p.rate, 0);
    n++;
    if (g) { const m = node(g, 'merge'); take.forEach(p => edge(g, p.src, m, p.rate, p.back)); list.push({ src: m, rate, back: take.some(p => p.back) }); }
    else list.push({ rate });
  }
  return { n, list };
}

/**
 * One belt of `rate` into exact `amounts` (summing to it). g: draw into it
 * from node `src`; null: count only. Returns { splitters, mergers, pieces:
 * [[{src, rate}] per amount], loop: streams looped back, load: the belt into
 * the first splitter } or null (too many streams).
 */
export function splitBelt(rate, amounts, g = null, src = null) {
  if (amounts.length === 1) return { splitters: 0, mergers: 0, pieces: [[{ src, rate }]], loop: 0, load: rate };
  const parts = shares(amounts);
  const d = parts.reduce((s, p) => s + p, 0);
  const { n: N, a, b } = streamCount(d);
  if (N > MAX_STREAMS) return null;
  const factors = [...Array(a).fill(2), ...Array(b).fill(3)];
  const per = rate / d, loop = N - d;
  const m0 = g && loop ? node(g, 'merge') : null;          // where the spare streams come back in
  if (m0 != null) edge(g, src, m0, rate);
  const free = [{ size: N, depth: 0, src: m0 ?? src }];
  let splitters = 0;
  const take = amount => {
    const got = [];
    let left = amount;
    while (left > 0) {
      free.sort((x, y) => y.size - x.size);
      const i = free.findIndex(f => f.size <= left);
      if (i >= 0) {
        const f = free.splice(i, 1)[0];
        got.push({ src: f.src, rate: f.size * per }); left -= f.size;
      } else {
        // split the smallest sub-tree still bigger than what's needed
        let j = -1;
        free.forEach((f, k) => { if (f.size > left && (j < 0 || f.size < free[j].size)) j = k; });
        const f = free.splice(j, 1)[0], ways = factors[f.depth];
        const s = g ? node(g, 'split') : null;
        if (g) edge(g, f.src, s, f.size * per);
        for (let c = 0; c < ways; c++) free.push({ size: f.size / ways, depth: f.depth + 1, src: s });
        splitters++;
      }
    }
    return got;
  };
  const pieces = new Array(parts.length);
  parts.map((p, i) => [p, i]).sort((x, y) => y[0] - x[0]).forEach(([p, i]) => { pieces[i] = take(p); });
  let mergers = 0;
  if (loop) {
    const back = take(loop).map(p => ({ ...p, back: true }));
    const j = join(g, back, 2);                             // the input merger takes the belt and two more
    mergers = 1 + j.n;
    if (g) j.list.forEach(p => edge(g, p.src, m0, p.rate, true));
  }
  return { splitters, mergers, pieces, loop: loop * per, load: rate + loop * per };
}

// Every distinct order of a list (equal values aren't told apart), at most `cap`
function* orders(vals, cap) {
  const keys = [...new Set(vals)], count = new Map(keys.map(k => [k, vals.filter(v => v === k).length]));
  const cur = [];
  let n = 0;
  function* rec() {
    if (n >= cap) return;
    if (cur.length === vals.length) { n++; yield [...cur]; return; }
    for (const k of keys) {
      if (!count.get(k)) continue;
      count.set(k, count.get(k) - 1); cur.push(k);
      yield* rec();
      cur.pop(); count.set(k, count.get(k) + 1);
    }
  }
  yield* rec();
}

// Share the belts out in turn: belt i fills outputs in order until it runs out
function fill(ins, outs, io, oo) {
  const inLeft = ins.map(r => r), outLeft = outs.map(o => o.rate), alloc = ins.map(() => []);
  let p = 0, q = 0;
  while (p < io.length && q < oo.length) {
    const i = io[p], j = oo[q], amt = r6(Math.min(inLeft[i], outLeft[j]));
    if (amt > 1e-9) alloc[i].push([j, amt]);
    inLeft[i] = r6(inLeft[i] - amt); outLeft[j] = r6(outLeft[j] - amt);
    if (inLeft[i] <= 1e-9) p++;
    if (outLeft[j] <= 1e-9) q++;
  }
  return alloc;
}

// How good a way of sharing is: [belts over the tier, structures, loop-backs, heaviest belt]
function score(belts, outs, alloc, cap, memo) {
  let splitters = 0, mergers = 0, loop = 0, over = 0, load = 0;
  const pieces = outs.map(() => 0);
  for (let i = 0; i < belts.length; i++) {
    const t = alloc[i];
    if (!t.length) continue;
    const key = belts[i] + '|' + t.map(x => x[1]).join(',');
    let r = memo.get(key);
    if (r === undefined) { r = splitBelt(belts[i], t.map(x => x[1])); memo.set(key, r && { ...r, pieces: r.pieces.map(p => p.length) }); r = memo.get(key); }
    if (!r) return null;
    splitters += r.splitters; mergers += r.mergers; loop += r.loop;
    load = Math.max(load, r.load);
    if (r.load > cap + 1e-6) over++;
    t.forEach(([j], k) => { pieces[j] += r.pieces[k]; });
  }
  outs.forEach((o, j) => { if (!o.rest) mergers += Math.max(0, Math.ceil((pieces[j] - 1) / 2)); });
  return { splitters, mergers, key: [over, splitters + mergers, loop, load] };
}
const better = (a, b) => { for (let k = 0; k < a.length; k++) if (Math.abs(a[k] - b[k]) > 1e-9) return a[k] < b[k]; return false; };

/**
 * Belts `ins` (/min each) into exact `outs`. What comes in beyond the outputs
 * leaves as an overflow (rest: true). cap: the belt tier's /min.
 * Returns { error } or { graph: {nodes, edges}, splitters, mergers, rest,
 * loop, over, tried, merged: whether the belts are merged into one first }.
 */
export function design(ins, outs, { cap = Infinity, limit = 4000 } = {}) {
  ins = ins.filter(r => r > 0).map(r6); outs = outs.filter(r => r > 0).map(r6);
  if (!ins.length || !outs.length) return null;
  const I = r6(ins.reduce((s, r) => s + r, 0)), O = r6(outs.reduce((s, r) => s + r, 0));
  if (O > I + 1e-6) return { error: `${+O.toFixed(3)}/min out, only ${+I.toFixed(3)}/min in` };
  const want = outs.map(rate => ({ rate }));
  const rest = I - O > 1e-6 ? r6(I - O) : 0;
  if (rest) want.push({ rate: rest, rest: true });
  const memo = new Map();
  let best = null, tried = 0;
  const consider = (belts, alloc, merged) => {
    const s = score(belts, want, alloc, cap, memo);
    tried++;
    if (!s) return;
    if (merged) { s.mergers += Math.ceil((ins.length - 1) / 2); s.key[1] = s.splitters + s.mergers; if (I > cap + 1e-6) s.key[0]++; }
    if (!best || better(s.key, best.key)) best = { ...s, belts, alloc, merged };
  };
  // the belts in every order, the outputs in every order (big lists: as many as `limit` allows)
  const idx = a => a.map((_, i) => i);
  const inOrders = [...orders(ins, 50)], outCap = Math.max(20, Math.floor(limit / inOrders.length));
  const wantRates = want.map(o => o.rate + (o.rest ? 1e-7 : 0));   // the rest is its own kind
  const asIdx = (vals, src) => { const used = new Set(); return vals.map(v => { const k = src.findIndex((x, n) => x === v && !used.has(n)); used.add(k); return k; }); };
  const outOrders = [[...idx(want)].sort((a, b) => want[b].rate - want[a].rate), [...idx(want)].sort((a, b) => want[a].rate - want[b].rate),
    ...[...orders(wantRates, outCap)].map(v => asIdx(v, wantRates))];
  inOrders.forEach(iv => { const io = asIdx(iv, ins); outOrders.forEach(oo => consider(ins, fill(ins, want, io, oo), false)); });
  if (ins.length > 1) consider([I], fill([I], want, [0], idx(want)), true);
  if (!best) return { error: 'These rates need too many streams for a practical balancer — round them.' };

  // Draw the winner
  const g = { nodes: [], edges: [] };
  const inNodes = ins.map(rate => node(g, 'in', { rate }));
  const outNodes = want.map(o => node(g, 'out', { rate: o.rate, rest: !!o.rest }));
  let srcs = inNodes.map((n, i) => ({ src: n, rate: ins[i] }));
  if (best.merged) {
    const j = join(g, srcs);
    srcs = j.list;
  }
  const got = want.map(() => []);
  best.alloc.forEach((t, i) => {
    if (!t.length) return;
    const r = splitBelt(best.belts[i], t.map(x => x[1]), g, srcs[i].src);
    t.forEach(([j], k) => got[j].push(...r.pieces[k]));
  });
  let over = 0;
  want.forEach((o, j) => {
    if (o.rest) { got[j].forEach(p => edge(g, p.src, outNodes[j], p.rate)); return; }
    const one = join(g, got[j]).list[0];
    edge(g, one.src, outNodes[j], one.rate);
  });
  g.edges.forEach(e => { e.over = e.rate > cap + 1e-6; if (e.over) over++; });
  return { graph: g, splitters: best.splitters, mergers: best.mergers, rest, over, tried, merged: best.merged,
           loop: r6(best.alloc.reduce((s, t, i) => s + (t.length > 1 ? splitBelt(best.belts[i], t.map(x => x[1])).loop : 0), 0)) };
}

/**
 * "4 x 120 into 5 x 80 + 40 + 20 + 20": belts in, belts out. Either side is
 * rates joined by + (or commas); "n x rate" is n belts of it; each rate may be
 * a sum (ev: text → number or null). Returns { ins, outs } or null.
 */
export function parseSplit(text, ev) {
  const m = String(text).split(/\s+(?:into|to)\s+|\s*(?:->|→|=>|>)\s*/i);
  if (m.length !== 2 || !m[0].trim() || !m[1].trim()) return null;
  const side = s => {
    const out = [];
    for (const term of s.split(/[+,](?![^(]*\))/)) {
      const t = term.trim();
      if (!t) return null;
      const c = t.match(/^(\d+)\s*[x×]\s*(.+)$/i);
      const n = c ? +c[1] : 1, v = ev(c ? c[2] : t);
      if (!(v > 0) || !(n >= 1) || n > 64) return null;
      for (let k = 0; k < n; k++) out.push(v);
    }
    return out.length ? out : null;
  };
  const ins = side(m[0]), outs = side(m[1]);
  return ins && outs ? { ins, outs } : null;
}

// ── Drawing: columns from the belts in to the belts out ──
/** The design as SVG markup (fmt: a number as text; color: the belts', its item's). */
export function splitSVG(g, fmt, color = null) {
  const CW = 96, RH = 40, PW = 58, PH = 22, S = 20;
  const depth = g.nodes.map(() => 0), into = g.nodes.map(() => []);
  g.edges.forEach(e => { if (!e.back) into[e.b].push(e.a); });
  const seen = new Map();
  const dep = n => {
    if (seen.has(n)) return seen.get(n);
    seen.set(n, 0);
    const d = into[n].length ? 1 + Math.max(...into[n].map(dep)) : 0;
    seen.set(n, d); return d;
  };
  g.nodes.forEach(n => { depth[n.id] = dep(n.id); });
  const last = Math.max(...g.nodes.map(n => depth[n.id]), 1);
  g.nodes.forEach(n => { if (n.kind === 'out') depth[n.id] = last; if (n.kind === 'in') depth[n.id] = 0; });
  // rows: each column ordered by where what feeds it sits
  const cols = [];
  g.nodes.forEach(n => (cols[depth[n.id]] = cols[depth[n.id]] || []).push(n.id));
  const row = new Map();
  cols.forEach(c => c.forEach((id, k) => row.set(id, k)));
  for (let pass = 0; pass < 3; pass++) {
    cols.forEach((c, d) => {
      if (!d || !c) return;
      const at = id => (into[id].length ? into[id].reduce((s, a) => s + row.get(a), 0) / into[id].length : row.get(id));
      c.sort((x, y) => at(x) - at(y) || x - y);
      // spread out so nothing overlaps, as near its feeders as it can be
      let next = 0;
      c.forEach(id => { const r = Math.max(next, Math.round(at(id) * 2) / 2); row.set(id, r); next = r + 1; });
    });
  }
  const H = Math.max(...[...row.values()]) + 1;
  const xy = id => [20 + depth[id] * CW, 20 + row.get(id) * RH];
  const W = 40 + last * CW + PW, Hpx = 30 + H * RH + (g.edges.some(e => e.back) ? 24 : 0);
  const half = n => (n.kind === 'in' || n.kind === 'out' ? PW / 2 : S / 2);
  let s = '';
  g.edges.forEach(e => {
    const A = g.nodes[e.a], B = g.nodes[e.b];
    let [x1, y1] = xy(e.a), [x2, y2] = xy(e.b);
    x1 += half(A); x2 -= half(B);
    const cls = `sp-e${e.over ? ' over' : ''}${e.back ? ' back' : ''}`;
    let d, lx, ly;
    if (e.back) {
      const yb = Hpx - 12;
      d = `M${x1},${y1} C${x1 + 40},${yb} ${x2 - 40},${yb} ${x2},${y2}`;
      lx = (x1 + x2) / 2; ly = yb - 4;
    } else {
      const mx = (x1 + x2) / 2;
      d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
      lx = mx; ly = (y1 + y2) / 2 - 4;
    }
    // a rate the box at either end already shows isn't written again
    const said = (A.kind === 'in' || B.kind === 'out') && Math.abs((A.kind === 'in' ? A.rate : B.rate) - e.rate) < 1e-6;
    s += `<path class="${cls}" d="${d}"${color && !e.over && !e.back ? ` style="stroke:${color}"` : ''}/>${said && !e.over ? '' : `<text class="sp-r${e.over ? ' over' : ''}" x="${lx}" y="${ly}" text-anchor="middle">${fmt(e.rate)}</text>`}`;
  });
  g.nodes.forEach(n => {
    const [x, y] = xy(n.id);
    if (n.kind === 'in' || n.kind === 'out') {
      s += `<rect class="sp-b ${n.kind}${n.rest ? ' rest' : ''}" x="${x - PW / 2}" y="${y - PH / 2}" width="${PW}" height="${PH}" rx="11"/>
        <text class="sp-bt" x="${x}" y="${y + 4}" text-anchor="middle">${n.rest ? '↯ ' : ''}${fmt(n.rate)}</text>`;
    } else {
      s += `<rect class="sp-n ${n.kind}" x="${x - S / 2}" y="${y - S / 2}" width="${S}" height="${S}" rx="4"/>
        <text class="sp-nt" x="${x}" y="${y + 4}" text-anchor="middle">${n.kind === 'split' ? 'S' : 'M'}</text>`;
    }
  });
  return `<svg class="sp-svg" width="${W}" height="${Hpx}" viewBox="0 0 ${W} ${Hpx}">${s}</svg>`;
}

/**
 * One belt of `rate` evenly into `n` machines, as a pattern you can repeat:
 * split 2 or 3 ways, then each of those again, until there's a belt per
 * machine. n isn't 2^a·3^b: the next one up, the spare belts merged back into
 * the start (so each carries rate ÷ n). Smallest splits first: fewest splitters.
 * Returns { splits: [2, 2, 3…], ends, spare, each, load, splitters }.
 */
export function feedPattern(rate, n) {
  const { n: ends, a, b } = streamCount(n);
  const splits = [...Array(a).fill(2), ...Array(b).fill(3)];
  let belts = 1, splitters = 0;
  splits.forEach(f => { splitters += belts; belts *= f; });
  const spare = ends - n, each = rate / n;
  return { splits, ends, spare, each, load: each * ends, splitters };
}
