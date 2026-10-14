/**
 * build-sheet.js — what to place, line by line, from the last solve.
 *
 * One line per recipe the plan runs, in the order you'd build them (what's
 * made from your resources first): its machines and their clock — the even
 * clock the plan uses (least power), or all but one at 100% (easiest to set)
 * — what comes in and goes out, each with the belt (or pipe) it needs, and
 * for each input the splitters and mergers that feed every machine exactly
 * its share (splits.js), a click away.
 */
import { RESULT, RECIPES, itemName, mCol, MABBR, TRANSPORT, FLUIDS, PROGRESS, MACHINE_SIZE } from './state.js';
import { design, splitSVG } from './splits.js';
import { itemColor } from './bundles.js';

const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = v => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : +v.toFixed(v < 10 ? 2 : 1)).toLocaleString();
const pct = v => `${+(+v).toFixed(2)}%`;
const rname = f => (RECIPES[f.recipe_key]?.display || f.display || f.recipe_key).replace(/^Alternate:\s*/i, 'Alt: ');

// The slowest belt (or pipe) that carries a rate, and how many it takes at your best
function carrier(item, rate) {
  const fluid = FLUIDS.has(item);
  const tiers = Object.entries((fluid ? TRANSPORT.pipes : TRANSPORT.belts) || {}).sort((a, b) => a[1] - b[1]);
  if (!tiers.length) return { label: '', n: 1, cap: Infinity };
  const best = fluid ? tiers[tiers.length - 1] : (tiers.find(([t]) => t === PROGRESS.belt) || tiers[tiers.length - 1]);
  const fits = tiers.find(([, c]) => c >= rate - 1e-9 && c <= best[1]);
  const kind = fluid ? 'pipe' : 'belt';
  if (fits) return { label: `${fits[0].replace('Mk', 'Mk.')} ${kind}`, n: 1, cap: fits[1] };
  const n = Math.ceil(rate / best[1] - 1e-9);
  return { label: `${n} × ${best[0].replace('Mk', 'Mk.')} ${kind}s`, n, cap: best[1], over: true };
}

// Build order: a line comes after the lines that make what it takes
function ordered(flows) {
  const makers = {};
  flows.forEach((f, i) => Object.keys(f.outputs || {}).forEach(o => (makers[o] = makers[o] || []).push(i)));
  const depth = new Map();
  const d = (i, seen = new Set()) => {
    if (depth.has(i)) return depth.get(i);
    if (seen.has(i)) return 0;
    seen.add(i);
    const ins = Object.keys(flows[i].inputs || {}).flatMap(it => (makers[it] || []).filter(j => j !== i));
    const v = ins.length ? 1 + Math.max(...ins.map(j => d(j, seen))) : 0;
    depth.set(i, v); return v;
  };
  return flows.map((f, i) => [f, d(i)]).sort((a, b) => a[1] - b[1] || (b[0].machines_float || 0) - (a[0].machines_float || 0)).map(x => x[0]);
}

// Each machine's share of a line's input: by its group's count and clock
function shares(f, rate) {
  const groups = f.layout?.length ? f.layout : [{ count: f.machines_final, clock_pct: f.clock_pct }];
  const w = groups.reduce((s, g) => s + g.count * g.clock_pct, 0) || 1;
  return groups.flatMap(g => Array(g.count).fill(rate * g.clock_pct / w));
}

// The machines: even clocks, or the easy way (all at 100% but the last)
function clocks(f) {
  const groups = f.layout?.length ? f.layout : [{ count: f.machines_final, clock_pct: f.clock_pct }];
  const even = groups.map(g => `${g.count} × ${pct(g.clock_pct)}${g.shards ? ` ⚡${g.shards}` : ''}${g.sloops ? ` 🔮${g.sloops}` : ''}`).join(' + ');
  if (groups.length !== 1 || groups[0].shards || groups[0].sloops) return { even };
  const total = groups[0].count * groups[0].clock_pct / 100, full = Math.floor(total + 1e-6), rest = (total - full) * 100;
  if (rest < 0.01 || full < 1) return { even };
  return { even, easy: `${full} × 100% + 1 × ${pct(rest)}` };
}

export function linesHTML() {
  const flows = (RESULT?.flows || []).filter(f => f.machines_final > 0);
  if (!flows.length) return '';
  return `<div class="bc-h bc-top"><span>Lines — what to place, in order</span><button class="bsm" id="bs-plan" title="Each line's machines at their real footprint, and how many foundations">📐 Floor plan</button></div>`
    + (fp => `<div class="n-hint" style="margin:-2px 0 4px">About ${Math.round(fp.W)} × ${Math.round(fp.L)} m on one floor · ${fp.found} foundations</div>`)(floorPlan()) + ordered(flows).map((f, li) => {
    const c = mCol(f.machine), k = clocks(f);
    const io = (items, dir) => Object.entries(items || {}).filter(([, r]) => r > 1e-6).map(([it, r]) => {
      const cr = carrier(it, r);
      return `<div class="bs-io ${dir}"><span><i class="bs-c" style="background:${itemColor(it, FLUIDS.has(it))}"></i>${dir === 'in' ? '←' : '→'} ${esc(itemName(it))} <b>${num(r)}</b>/min</span>
        <span class="n-hint ${cr.over ? 'n-warn' : ''}">${cr.label}</span>
        ${dir === 'in' && f.machines_final > 1 ? `<button class="bsm bs-sp" data-line="${li}" data-item="${it}" title="The splitters and mergers that give each machine exactly its share">⑂</button>` : ''}</div>
        ${dir === 'in' ? `<div class="bs-d" data-for="${li}|${it}"></div>` : ''}`;
    }).join('');
    return `<div class="bs-l" data-line="${li}">
      <div class="bs-h"><span class="rl-m" style="background:${c}22;color:${c};border:1px solid ${c}44">${MABBR[f.machine] || f.machine}</span>
        <span class="bs-n">${esc(rname(f))}</span><span class="bs-k" title="${k.easy ? `Or ${k.easy} — easier to set, a little more power` : 'Every machine at this clock'}">${k.even}</span></div>
      ${k.easy ? `<div class="n-hint bs-alt">or ${k.easy}</div>` : ''}
      ${io(f.inputs, 'in')}${io(f.outputs, 'out')}</div>`;
  }).join('');
}

/** The lines as plain text, for the copied list. */
export function linesText() {
  return ordered((RESULT?.flows || []).filter(f => f.machines_final > 0)).map(f =>
    `  ${f.machine.replace(/_/g, ' ')} ${clocks(f).even} — ${rname(f)}: ${Object.entries(f.inputs || {}).map(([i, r]) => `${num(r)} ${itemName(i)}`).join(' + ')} → ${
      Object.entries(f.outputs || {}).map(([i, r]) => `${num(r)} ${itemName(i)}`).join(' + ')}`);
}

/** Wire the ⑂ buttons in `el` (after linesHTML). */
export function wireLines(el) {
  const flows = ordered((RESULT?.flows || []).filter(f => f.machines_final > 0));
  el.querySelectorAll('.bs-sp').forEach(b => b.addEventListener('click', () => {
    const f = flows[+b.dataset.line], it = b.dataset.item, box = el.querySelector(`.bs-d[data-for="${b.dataset.line}|${CSS.escape(it)}"]`);
    if (!box) return;
    if (box.innerHTML) { box.innerHTML = ''; b.classList.remove('on'); return; }
    const rate = f.inputs[it], cr = carrier(it, rate);
    const ins = Array(cr.n).fill(rate / cr.n), outs = shares(f, rate);
    const d = design(ins, outs, { cap: cr.cap });
    b.classList.add('on');
    box.dataset.title = `${itemName(it)} ${num(rate)}/min → ${outs.length} × ${f.machine.replace(/_/g, ' ')}`;
    box.innerHTML = d?.graph ? `<div class="n-hint">${d.splitters} splitter${d.splitters === 1 ? '' : 's'} · ${d.mergers} merger${d.mergers === 1 ? '' : 's'} — each of the ${outs.length} machines gets exactly its share.
        A manifold (a splitter per machine along the belt) works too: they back up and take their share, only slower to fill.</div>
      <div class="sp-d">${splitSVG(d.graph, num, itemColor(it, FLUIDS.has(it)))}</div>` : `<p class="n-warn">${esc(d?.error || 'No design for these numbers.')}</p>`;
  }));
}

/** A splitter design, large, in its own window (the panel's is small). */
export function openSplit(title, inner) {
  document.getElementById('sp-full-t').textContent = title;
  document.getElementById('sp-full-b').innerHTML = inner;
  document.querySelectorAll('.far.show').forEach(f => f.classList.remove('show'));
  document.getElementById('sp-full').classList.add('show');
}
// any drawn design, clicked: large
document.addEventListener('click', e => {
  const svg = e.target.closest('.sp-d svg');
  if (!svg || svg.closest('#sp-full')) return;
  const box = svg.closest('#gt-split, .bs-d');
  openSplit(box?.querySelector('.sp-h')?.firstChild?.textContent?.trim() || box?.dataset.title || 'Splitters and mergers', box ? box.innerHTML : svg.outerHTML);
});

// ── Floor plan: a rough one, to judge the room a factory needs ──
// Each line a row of its machines at their real footprint, side by side with
// GAP between them and a LANE for belts on either side of the row; long rows
// fold in two (or more) so the plan stays roughly square. Foundations: 8 m.
const GAP = 1, LANE = 4, FOUND = 8, ROW_MAX = 120;
export function floorPlan() {
  const flows = ordered((RESULT?.flows || []).filter(f => f.machines_final > 0));
  const rows = [];
  flows.forEach(f => {
    const [w, l] = MACHINE_SIZE[f.machine] || [8, 8];
    const n = f.machines_final, per = Math.max(1, Math.floor((ROW_MAX + GAP) / (w + GAP)));
    for (let k = 0; k < n; k += per) rows.push({ f, w, l, count: Math.min(per, n - k), first: k === 0 });
  });
  let y = 0, W = 0;
  rows.forEach(r => { r.y = y + LANE; r.len = r.count * r.w + (r.count - 1) * GAP; W = Math.max(W, r.len); y = r.y + r.l + LANE; });
  return { rows, W: W + 2 * LANE, L: y, found: Math.ceil((W + 2 * LANE) / FOUND) * Math.ceil(y / FOUND) };
}
export function floorPlanHTML() {
  const p = floorPlan();
  if (!p.rows.length) return '<p class="n-hint">Solve first.</p>';
  const k = Math.min(6, 900 / Math.max(p.W, 1)), pad = 150;
  let g = '';
  for (let x = 0; x <= p.W; x += FOUND) g += `<line class="fp-g" x1="${pad + x * k}" y1="0" x2="${pad + x * k}" y2="${p.L * k}"/>`;
  for (let y = 0; y <= p.L; y += FOUND) g += `<line class="fp-g" x1="${pad}" y1="${y * k}" x2="${pad + p.W * k}" y2="${y * k}"/>`;
  p.rows.forEach(r => {
    const c = mCol(r.f.machine);
    g += `<rect class="fp-lane" x="${pad + (LANE - 1) * k}" y="${(r.y - LANE + 0.5) * k}" width="${(r.len + 2) * k}" height="${(LANE - 1) * k}"/>`;
    for (let i = 0; i < r.count; i++)
      g += `<rect x="${pad + (LANE + i * (r.w + GAP)) * k}" y="${r.y * k}" width="${r.w * k}" height="${r.l * k}" rx="2" style="fill:${c}33;stroke:${c}"/>`;
    if (r.first) g += `<text class="fp-t" x="${pad - 8}" y="${(r.y + r.l / 2) * k + 4}" text-anchor="end">${esc(rname(r.f))}</text>
      <text class="fp-s" x="${pad - 8}" y="${(r.y + r.l / 2) * k + 16}" text-anchor="end">${r.f.machines_final} × ${esc(r.f.machine.replace(/_/g, ' '))}</text>`;
  });
  return `<p class="n-hint" style="margin:0 0 6px">About <b>${Math.round(p.W)} × ${Math.round(p.L)} m</b> — <b>${p.found}</b> foundations (8 m), one floor.
      Machines side by side ${GAP} m apart, a ${LANE} m belt lane either side of each row; long rows fold. A guide to the room it needs, not a layout.</p>
    <svg class="fp" width="${pad + p.W * k + 10}" height="${p.L * k + 10}">${g}</svg>`;
}
document.addEventListener('click', e => {
  if (e.target.closest('#bs-plan')) openSplit(`Floor plan — ${RESULT?.scenario_name || 'this factory'}`, floorPlanHTML());
});
