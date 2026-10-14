/**
 * ui.js — the results bar, build cost and the build sheet, Analysis,
 * warnings, saved factories; comparing two plans; and re-solving factories
 * in order (the chain).
 */
import { itemColor, design, splitSVG, feedPattern } from './geometry.js';
import { RESULT, RECIPES, itemName, perMin, PROGRESS, MINER_TIERS, FLUIDS, BUILT, SC, mCol, MABBR, TRANSPORT, MACHINE_SIZE, fetchDuals } from './state.js';
import { openDock, setBadge, closeDock, dockTab } from './nav.js';
import { freeNodes, takeNode, setSupplyTotal, goalOf, setGoal } from './sidebar.js';

const TIERS = ['Mk1', 'Mk2', 'Mk3'];

// ══════════════════════════════════════════════════════════
// WARNINGS MODAL
// ══════════════════════════════════════════════════════════
// Issues: drawn in the right panel's Issues tab (renderIssues after every
// solve), opened there (openWarn) when a solve has something to say
export function openWarn() { renderIssues(); openDock('issues'); }
export function renderIssues() {
  const list = document.getElementById('wmit-list');
  if (!list) return;
  if (!RESULT) { list.innerHTML = '<p class="n-hint">Solve to see what it couldn\'t do.</p>'; return; }
  const items = [
    ...Object.entries(RESULT.error_sources       ?? {}).map(([k, v]) => ({ t: 'error',   txt: `Missing: ${itemName(k)} — needs ${Number(v).toFixed(1)}/min` })),
    ...Object.entries(RESULT.error_sinks         ?? {}).map(([k, v]) => ({ t: 'error',   txt: `Byproduct: ${itemName(k)} — surplus ${Number(v).toFixed(1)}/min` })),
    ...Object.entries(RESULT.surplus_intermediates ?? {}).map(([k, v]) => ({ t: 'surplus', txt: `Reusable surplus: ${itemName(k)} — +${Number(v).toFixed(1)}/min` })),
    ...(RESULT.conflict_hints ?? []).map(t => ({ t: 'warning', txt: t })),
    ...(RESULT.warnings       ?? []).map(t => ({ t: 'info',    txt: t })),
  ];
  const COL = { error:'var(--err)', warning:'var(--warn)', info:'var(--t3)', surplus:'#f59e0b' };
  const BG  = { error:'var(--err-dim)', warning:'var(--warn-dim)', info:'var(--p3)', surplus:'rgba(245,158,11,.1)' };
  const ICO = { error:'✕', warning:'⚠', info:'ℹ', surplus:'↗' };
  list.innerHTML = items.length ? '' : '<p class="n-hint">Nothing to fix — the last solve did everything asked.</p>';
  // What would make it work, one click each (they change the factory, then it solves again)
  const fixes = fixesOf(RESULT.diagnosis);
  if (fixes.length) {
    const box = document.createElement('div'); box.className = 'wm-fix';
    box.innerHTML = '<div class="wm-fix-t">Any one of these makes it work</div>' + fixes.map((f, i) =>
      `<div class="wm-fix-r"><span>${f.label}</span><button class="bsm act" data-fix="${i}">Apply</button></div>`).join('');
    box.querySelectorAll('[data-fix]').forEach(b => b.addEventListener('click', () => {
      closeWarn();
      document.dispatchEvent(new CustomEvent('apply-fix', { detail: fixes[+b.dataset.fix] }));
    }));
    list.appendChild(box);
  }
  items.forEach(({ t, txt }) => {
    const d = document.createElement('div'); d.className = 'wmit';
    d.style.cssText = `border:1px solid ${COL[t]};background:${BG[t]};color:${COL[t]}`;
    d.innerHTML = `<span style="flex-shrink:0">${ICO[t]}</span><span>${txt}</span>`;
    list.appendChild(d);
  });
}
// The diagnosis of a plan that can't be made, as changes to try: each goal
// lowered to what fits with the rest, the alternates that would close the gap
function fixesOf(d) {
  if (!d) return [];
  const f = v => (Math.round(v * 10) / 10).toLocaleString();
  const out = Object.entries(d.most || {}).map(([g, [most]]) =>
    ({ kind: 'goal', item: g, rate: most, label: `Lower ${itemName(g)} to ${f(most)}/min` }));
  if (d.alts?.use?.length && !Object.keys(d.alts.short || {}).length)
    out.push({ kind: 'alts', keys: d.alts.use,
      label: `Turn on ${d.alts.use.map(k => RECIPES[k]?.display?.replace(/^Alternate: /, '') || k).join(', ')} (an alternate you haven't unlocked)` });
  return out;
}
export function closeWarn() { /* the Issues tab stays where it is */ }

// ══════════════════════════════════════════════════════════
// RESULTS BAR + BUILD COST
// ══════════════════════════════════════════════════════════
let _rbLastHTML = null;
// Machine space in Smelter units (a Smelter = 1; see machine_space in solver.py)
export const _fmtSpace = v => v >= 1e4 ? `${(v / 1e3).toFixed(1)}k u` : `${Math.round(v)} u`;
export function renderResultsBar() {
  const rb = document.getElementById('rb');
  if (!RESULT?.status?.startsWith('Optimal')) {
    rb.style.display = 'none';
    _rbLastHTML = null;
    return;
  }
  // against the pinned plan (📌): how each number moved
  const A = pinned()?.s;
  const dl = (now, was, more) => { const d = A && delta(now, was, more); return d && d.text !== '=' ? `<div class="rbd ${d.cls}">${d.text}</div>` : ''; };
  const st  = (label, val, color = 'var(--acc)', title = '', d = '') =>
    `<div class="rbs"${title ? ` title="${title}"` : ''}><div class="rbv" style="color:${color}">${val}</div>${d}<div class="rbl">${label}</div></div>`;
  const sep = '<div class="rbsep"></div>';

  const objItems = Object.entries(RESULT.objective_items || {})
    .filter(([, v]) => v > 0.01)
    .sort(([, a], [, b]) => b - a);

  // Power: what the factory draws (its machines and extractors) — what it
  // takes to start it, from batteries or the grid. Its generators' output is
  // a goal like any item, shown as power made.
  const used = (RESULT.flows || []).reduce((a, f) => a + Math.max(0, f.power_mw || 0), 0) + (RESULT.extractor_power_mw || 0);
  const made = (RESULT.flows || []).reduce((a, f) => a + (f.outputs?.Power || 0), 0) + (RESULT.geothermal_mw || 0);
  const capMw = RESULT.max_power_mw;
  const net = made - used;
  const powTip = made > 0 ? `Draws ${used.toFixed(0)} MW (extractors ${(RESULT.extractor_power_mw || 0).toFixed(0)}); makes ${made.toFixed(0)} MW — ${
    net >= 0 ? `${net.toFixed(0)} MW to spare` : `${(-net).toFixed(0)} MW short`}` : `Machines and extractors (${(RESULT.extractor_power_mw || 0).toFixed(0)} MW)`;
  const mwTxt = v => `${Math.round(v).toLocaleString()} MW`;
  const useSt = capMw ? st(`Power use · ${(100 * (RESULT.total_power_mw ?? 0) / capMw).toFixed(1)}% of cap`, mwTxt(used), 'var(--warn)', powTip, dl(used, A?.used, 'worse'))
                      : st('Power use', mwTxt(used), 'var(--warn)', powTip, dl(used, A?.used, 'worse'));

  let h = useSt + sep;
  objItems.forEach(([k, v], i) => {
    h += k === 'Power' ? st('Power made', mwTxt(v), 'var(--ok)', powTip, dl(v, A?.goals[k] ?? 0, 'better'))
                       : st(itemName(k), perMin(k, v, 1, true), 'var(--ok)', '', dl(v, A?.goals[k] ?? 0, 'better'));
    if (i < objItems.length - 1) h += sep;
  });
  if (objItems.length) h += sep;
  h += st('Machines', RESULT.total_machines, undefined, '', dl(RESULT.total_machines, A?.machines, 'worse')) + sep;
  // Room the machines take — what the planner minimises (w×l×h per machine)
  if (RESULT.total_space != null) h += st('Space · smelters', _fmtSpace(RESULT.total_space), undefined, '', dl(RESULT.total_space, A?.space, 'worse'));
  if (RESULT.shards_used > 0) h += sep + st('Shards', RESULT.shards_used, '#3b82f6');
  if (RESULT.sloops_used > 0) h += sep + st('Sloops', RESULT.sloops_used, '#a855f7');
  // The plan against the fractional ceiling: the goal with whole machines,
  // shards and sloops relaxed — no buildable plan beats it, so this is a floor
  // on how close the plan is to the best (whole machines alone can cost a little)
  const pct = RESULT.ceiling_pct, cert = RESULT.certified_pct;
  if (pct != null) {
    const fmtc = v => (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : +v.toFixed(2)).toLocaleString();
    const tip = `Goal ${fmtc(RESULT.objective_value)} of a fractional ceiling of ${fmtc(RESULT.ceiling)} — the most any plan could reach with machines, shards and sloops in fractions.`
      + (cert != null && cert > pct + 0.05 ? ` Proven against whole machines: at least ${cert.toFixed(1)}% of the best.` : '');
    h += sep + st('Of ceiling', `${pct >= 99.995 ? '100' : pct.toFixed(2)}%`, pct >= 95 ? 'var(--ok)' : 'var(--warn)', tip);
  }

  // pin this plan, or (pinned) compare against it
  h += sep + (A ? `<div class="rb-pin"><button class="bsm act" data-rb="compare" title="The pinned plan and this one side by side">📌 Compare</button>
      <button class="bsm" data-rb="unpin" title="Unpin">✕</button></div>`
    : `<div class="rb-pin"><button class="bsm" data-rb="pin" title="Keep this plan to compare the next ones against (P)">📌 Pin</button></div>`);
  if (h === _rbLastHTML) { rb.style.display = 'flex'; return; }
  _rbLastHTML = h;
  rb.style.display = 'flex';
  rb.innerHTML = h;
}

// ══════════════════════════════════════════════════════════
// BUILD COST — this factory's plan, plus any saved factories you add
// ══════════════════════════════════════════════════════════
let BC_SELF = null, BC_NAME = '';     // the open factory: its live plan stands in for its saved one
let BL = null, BL_ASKED = false;      // /api/build-list: every saved factory (and the grid)
const BL_PICK = new Set();
let _bcLastKey = null;
/** Which saved factory the planner has open (null: a new one). */
export function setBuildSelf(key, name) { BC_SELF = key; BC_NAME = name || ''; BUILT.key = key; }
// A save read: what it has built, a fetch away
const askBuilt = () => fetch('/api/build-progress').then(r => r.json()).then(d => { BUILT.p = d.read ? d : null; _bcLastKey = null; renderBuildCost(); }).catch(() => {});
document.addEventListener('save-read', askBuilt);
export function toggleBC() { openDock('build'); }
const machName = m => m.replace(/_/g, ' ').replace(/Mk(\d)/, 'Mk.$1');
const fmtN = v => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : +v.toFixed(2)).toLocaleString();

/** Redraw; fresh=true also re-reads the saved factories (when the tab opens). */
export function renderBuildCost(fresh = false) {
  const body = document.getElementById('bcb');
  if (fresh || (!BL && !BL_ASKED)) {
    BL_ASKED = true;
    fetch('/api/build-list').then(r => r.json()).then(d => { BL = d.factories || []; renderBuildCost(); }).catch(() => {});
    askBuilt();
  }
  // this factory, from the last solve: its machines, extractors and what they take
  const self = { key: '@self', name: BC_NAME || 'This factory', machines: {}, extractors: {}, materials: { ...(RESULT?.build_cost ?? {}) },
    shards: RESULT?.build_cost_shards ?? 0, sloops: RESULT?.build_cost_sloops ?? 0, solved: !!RESULT?.flows?.length };
  (RESULT?.flows || []).forEach(f => { self.machines[f.machine] = (self.machines[f.machine] || 0) + (f.machines_final || 0); });
  Object.entries(RESULT?.extractor_build ?? {}).forEach(([m, e]) => {
    self.extractors[m] = e.count;
    Object.entries(e.cost || {}).forEach(([k, v]) => { self.materials[k] = (self.materials[k] || 0) + v; });
  });
  const others = (BL || []).filter(f => f.key !== BC_SELF);
  const pick = [...(self.solved ? [self] : []), ...others.filter(f => f.solved && BL_PICK.has(f.key))];
  const sum = field => {
    const out = {};
    pick.forEach(f => Object.entries(f[field] || {}).forEach(([k, v]) => {
      if (!v) return;
      (out[k] = out[k] || { total: 0, by: [] }).total += v;
      out[k].by.push(`${f.name} ${fmtN(v)}`);
    }));
    return Object.entries(out).sort((a, b) => b[1].total - a[1].total);
  };
  const machines = sum('machines'), extractors = sum('extractors'), mats = sum('materials');
  // From the save: this factory's machines built, line by line (its saved plan's count, up to what this plan needs)
  const bp = BUILT.p, mine = bp && BC_SELF ? bp.factories[BC_SELF] : null;
  const left = {};
  if (mine) (RESULT?.flows || []).forEach(f => {
    const got = Math.min(f.machines_final || 0, mine.lines[f.recipe_key]?.[1] || 0);
    left[f.machine] = (left[f.machine] || 0) + (f.machines_final || 0) - got;
  });
  const shards = pick.reduce((t, f) => t + (f.shards || 0), 0), sloops = pick.reduce((t, f) => t + (f.sloops || 0), 0);
  setBadge('bcc', self.solved ? String(machines.length + extractors.length) : '');

  const key = JSON.stringify([pick.map(f => f.key), machines, extractors, mats, shards, sloops, others.map(f => [f.key, f.solved]), left, bp?.when,
    (RESULT?.flows || []).map(f => [f.recipe_key, f.machines_final, f.clock_pct, f.inputs])]);
  if (key === _bcLastKey) return;
  _bcLastKey = key;

  const many = pick.length > 1;
  const rows = (list, name, icon = '', lf = null) => list.map(([k, x]) =>
    `<div class="bcr" ${many ? `title="${x.by.join(' · ')}"` : ''}><span>${icon}${name(k)}</span><span>${
      lf && !many && k in lf ? (lf[k] > 0 ? `<span class="bc-left">${fmtN(lf[k])} left</span> ` : '<span class="bc-done">✓ built</span> ') : ''}×${fmtN(x.total)}</span></div>`).join('');
  const saveNote = bp ? `<div class="bc-save"><span class="n-hint">From ${bp.file || 'your save'}${mine ? '' : ' — save this factory to match it'}</span>
    <button class="bsm" id="bc-left" title="Every saved factory: what's still to build, and the materials against what your storage holds">🧱 What's left everywhere</button></div>` : '';
  const chips = others.length ? `<div class="bc-add"><span class="n-hint">Add:</span>${others.map(f =>
    `<label title="${f.solved ? (f.stale ? 'Its last plan — it changed since' : 'Add its build to this list') : 'Not solved: nothing to count yet'}">
      <input type="checkbox" data-key="${f.key}" ${BL_PICK.has(f.key) ? 'checked' : ''} ${f.solved ? '' : 'disabled'}/>${f.name}${f.stale ? '*' : ''}</label>`).join('')}</div>` : '';
  const empty = !machines.length && !extractors.length && !mats.length && !shards && !sloops;
  body.innerHTML = `${chips}
    ${empty ? '<p class="n-hint">Solve to see the machines and materials to have ready.</p>' : `
    <div class="bc-h bc-top"><span>Machines${many ? ` · ${pick.length} factories` : ''}</span><button class="bsm" id="bc-copy">Copy as a list</button></div>
    ${saveNote}${rows(machines, machName, '', mine ? left : null)}${rows(extractors, machName, '⛏ ', mine && !many ? Object.fromEntries(extractors.map(([k]) => [k, mine.extractors_left[k] || 0])) : null)}
    ${many && shards ? `<div class="bcr"><span style="color:#3b82f6">💎 Power Shards</span><span style="color:#3b82f6">×${shards}</span></div>` : ''}
    ${many && sloops ? `<div class="bcr"><span style="color:#a855f7">🔮 Somersloops</span><span style="color:#a855f7">×${sloops}</span></div>` : ''}
    <div class="bc-h">Materials to build them</div>${rows(mats, itemName)}
    ${self.solved ? `<div id="bc-lines">${linesHTML()}</div>` : ''}`}`;
  if (self.solved) wireLines(body);
  body.querySelector('#bc-left')?.addEventListener('click', openLeft);
  body.querySelectorAll('.bc-add input').forEach(c => c.addEventListener('change', () => {
    c.checked ? BL_PICK.add(c.dataset.key) : BL_PICK.delete(c.dataset.key);
    renderBuildCost();
  }));
  body.querySelector('#bc-copy')?.addEventListener('click', e => {
    const lines = [`Build list: ${pick.map(f => f.name).join(', ')}`, '', 'Machines',
      ...[...machines, ...extractors].map(([k, x]) => `  ${machName(k)} ×${fmtN(x.total)}`),
      ...(shards ? [`  Power Shards ×${shards}`] : []), ...(sloops ? [`  Somersloops ×${sloops}`] : []),
      '', 'Materials', ...mats.map(([k, x]) => `  ${itemName(k)} ×${fmtN(x.total)}`),
      ...(self.solved ? ['', 'Lines', ...linesText()] : [])];
    const text = lines.join('\n'), b = e.target;
    const done = ok => { b.textContent = ok ? 'Copied ✓' : 'Couldn\'t copy'; setTimeout(() => { b.textContent = 'Copy as a list'; }, 1800); };
    // the clipboard API needs a secure page or permission; else the old way
    const old = () => {
      const t = Object.assign(document.createElement('textarea'), { value: text });
      document.body.appendChild(t); t.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* not allowed */ }
      t.remove(); done(ok);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done(true), old); else old();
  });
}

// Everything still to build, every saved factory, from the last save read: the
// lines short of machines, the extractors not on their nodes, and the
// materials for all of it against what the save's storage holds
function openLeft() {
  const bp = BUILT.p;
  if (!bp) return;
  const fs = Object.entries(bp.factories).filter(([, f]) => Object.keys(f.machines_left).length || Object.keys(f.extractors_left).length);
  const total = {};
  fs.forEach(([, f]) => Object.entries(f.materials_left).forEach(([k, v]) => { total[k] = (total[k] || 0) + v; }));
  const rname = k => (RECIPES[k]?.display || k).replace(/^Alternate:\s*/i, 'Alt: ');
  const fac = ([key, f]) => {
    const lines = Object.entries(f.lines).filter(([, [n, b]]) => b < n);
    return `<div class="lf-f"><div class="lf-h">${f.name}${f.located ? '' : ' <span class="n-hint" title="It has no map nodes, so its machines are matched by recipe alone">· not on the map</span>'}</div>
      ${lines.map(([r, [n, b]]) => `<div class="bcr"><span>${rname(r)}</span><span>${b ? `${b} of ${n} built` : `${n} to build`}</span></div>`).join('')}
      ${Object.entries(f.extractors_left).map(([m, n]) => `<div class="bcr"><span>⛏ ${machName(m)}</span><span>${n} to place</span></div>`).join('')}</div>`;
  };
  const mats = Object.entries(total).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
    const have = bp.stock[k] || 0, short = Math.max(0, v - have);
    return `<tr><td>${itemName(k)}</td><td class="num">${fmtN(v)}</td><td class="num">${fmtN(have)}</td>
      <td class="num ${short ? 'cmp-down' : 'cmp-up'}">${short ? `${fmtN(short)} short` : '✓'}</td></tr>`;
  }).join('');
  openSplit(`What's left to build — from ${bp.file || 'your save'}`, fs.length ? `
    <table class="st-tab cmp"><tr><th>Materials</th><th style="text-align:right">Needed</th><th style="text-align:right">In storage</th><th></th></tr>${mats}</table>
    <div class="lf-g">${fs.map(fac).join('')}</div>
    ${bp.spare ? `<p class="n-hint">${bp.spare} machine${bp.spare > 1 ? 's' : ''} in the save match no line of a saved plan.</p>` : ''}`
    : '<p class="n-hint">Everything in your saved plans is built.</p>');
}

// ══════════════════════════════════════════════════════════
// SAVED SCENARIOS TAB
// ══════════════════════════════════════════════════════════
// A factory at a glance: what it makes for its goals, its power, and whether its plan is current
function overview(s) {
  const out = Object.entries(s.exports || {}).sort((a, b) => b[1] - a[1]);
  const fmt = v => (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : +v.toFixed(1)).toLocaleString();
  const state = !s.solved ? ['', 'not solved'] : s.alerts?.length ? ['bad', 'short'] : s.stale ? ['old', 'out of date'] : ['ok', 'current'];
  const pw = s.power ? (s.power.made > 0 ? `⚡ ${fmt(s.power.use)} MW · makes ${fmt(s.power.made)}` : `⚡ ${fmt(s.power.use)} MW`) : '';
  return `<div class="sv-ov">${out.length ? out.slice(0, 3).map(([k, v]) =>
      `<span class="sv-out"><i style="background:${itemColor(k, FLUIDS.has(k))}"></i>${itemName(k)} <b>${fmt(v)}</b></span>`).join('') + (out.length > 3 ? `<span class="n-hint">+${out.length - 3}</span>` : '')
      : `<span class="n-hint">${(s.resources || []).slice(0, 3).map(r => r.replace(/_/g, ' ')).join(', ')}</span>`}</div>
    <div class="sv-ov"><span class="sv-st ${state[0]}">${state[1]}</span>${pw ? `<span class="n-hint">${pw}</span>` : ''}</div>`;
}
export function renderSaved(saved, onLoad, onDelete, onRestore) {
  const el = document.getElementById('savedlist');
  if (!saved.length) { el.innerHTML = '<p style="font-size:12px;color:var(--t3)">No saved scenarios.</p>'; el.appendChild(backupBox()); return; }
  el.innerHTML = '';
  const stale = saved.filter(s => !s.fresh).length;
  const bar = document.createElement('div');
  bar.className = 'sv-bar';
  bar.innerHTML = `<button class="bsm ${stale ? 'act' : ''}" id="sv-chain" ${stale ? '' : 'disabled'}
      title="Solve every factory without a current plan, and everything that takes from them — sources first">↻ Re-solve out of date (${stale})</button>
    <button class="bsm" id="sv-spread" title="Share your shards and somersloops out across every factory, where they do the most">💎 Shards &amp; sloops</button>`;
  el.appendChild(bar);
  const gridBox = document.createElement('div');
  el.appendChild(gridBox);
  const rowsBy = {};
  saved.forEach(s => {
    const row = document.createElement('div');
    row.className = 'sv-row';
    rowsBy[s.key] = row;
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:5px">
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;color:var(--t)">${s.fresh ? '' : '<span class="sv-stale" title="No current plan — solve it, or re-solve out of date">●</span> '}${s.name}${
            s.miners && TIERS.indexOf(s.miner) < TIERS.indexOf(PROGRESS.miner) ? ` <span class="sv-up" title="${s.miners} miner${s.miners > 1 ? 's' : ''} at ${s.miner.replace('Mk', 'Mk.')} — ${PROGRESS.miner.replace('Mk', 'Mk.')} is unlocked: open it to upgrade">⛏ ${s.miner.replace('Mk', 'Mk.')}</span>` : ''}${s.alerts?.length ? ` <span class="sv-alert" title="${
            s.alerts.map(a => `${a.item.replace(/_/g, ' ')}${a.storage ? ' to storage' : ` from ${a.factory_name || a.factory}`}: ${a.rate}/min asked, ${a.left}/min left — its source changed`).join('\n')}">⚠ ${s.alerts.length}</span>` : ''}</div>
          ${overview(s)}
        </div>
        <button class="bsm">Load</button>
        <button class="bsm sv-h" title="Earlier versions">⟲</button>
        <button class="bsm dan">✕</button>
      </div>
      <div class="sv-hist" style="display:none"></div>`;
    const [load, hist, del] = row.querySelectorAll('button');
    load.addEventListener('click', () => onLoad(s.key));
    del.addEventListener('click', () => onDelete(s.key));
    hist.addEventListener('click', () => {
      const box = row.querySelector('.sv-hist');
      if (box.style.display !== 'none') { box.style.display = 'none'; return; }
      box.style.display = '';
      box.innerHTML = '<span class="n-hint">Loading…</span>';
      const draw = versions => {
        const conf = versions.filter(v => v.confirmed).length;
        const cur = `<div class="sv-v"><span>Now</span><span class="n-hint">${conf}/5 confirmed</span>
          <button class="bsm" data-c="current" ${conf >= 5 ? 'disabled' : ''} title="Keep this version for good (up to 5)">✓ Confirm</button></div>`;
        box.innerHTML = cur + (versions.length ? versions.map(v => {
          const t = v.id.replace(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d).*$/, '$1-$2-$3 $4:$5');
          const ch = v.changes.length ? v.changes.map(c => `<div>${c}</div>`).join('') : '<div>the same as now</div>';
          return `<div class="sv-v${v.confirmed ? ' sv-conf' : ''}"><span>${v.confirmed ? '✓ ' : ''}${t}${v.name !== s.name ? ` · ${v.name}` : ''}</span>
            <button class="bsm" data-c="${v.id}" data-on="${v.confirmed ? 0 : 1}" ${!v.confirmed && conf >= 5 ? 'disabled' : ''}
              title="${v.confirmed ? 'Unconfirm: it goes once 5 newer changes are kept' : 'Keep it for good (up to 5)'}">${v.confirmed ? 'Unconfirm' : '✓'}</button>
            <button class="bsm" data-v="${v.id}">Restore</button>
            <div class="sv-ch" title="What restoring it changes">${ch}</div></div>`;
        }).join('') : '<span class="n-hint">No earlier versions yet — each save that changes it keeps the one it replaces.</span>')
          + '<div class="n-hint" style="margin-top:4px">Kept: the 5 you confirm and the 5 latest changes.</div>';
        box.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => {
          if (confirm(`Restore "${s.name}" to how it was at ${b.parentNode.firstElementChild.textContent}? The current version is kept in its history.`))
            onRestore(s.key, b.dataset.v);
        }));
        box.querySelectorAll('[data-c]').forEach(b => b.addEventListener('click', () =>
          fetch(`/api/history/${s.key}/${b.dataset.c}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: b.dataset.on !== '0' }) }).then(r => r.json())
            .then(d => d.error ? alert(d.error) : draw(d.versions))));
      };
      fetch(`/api/history/${s.key}`).then(r => r.json()).then(d => draw(d.versions));
    });
    el.appendChild(row);
  });
  const box = document.createElement('div');
  box.id = 'sv-chain-box';
  el.appendChild(box);
  el.appendChild(backupBox());
  // The power grid: short on average, or with every geyser at its low — and whose draw rose
  fetch('/api/grid-status').then(r => r.json()).then(g => {
    const f = v => Math.round(Math.abs(v)).toLocaleString();
    const msg = g.spare < 0 ? `the grid is ${f(g.spare)} MW short`
      : g.spare_low < 0 ? `with every geyser at its low the grid is ${f(g.spare_low)} MW short (${f(g.spare)} MW spare on average)` : '';
    if (!msg || !(g.made > 0)) return;   // no power in the planner yet: nothing to balance
    gridBox.className = 'sv-grid';
    gridBox.innerHTML = `⚡ ${msg[0].toUpperCase() + msg.slice(1)}.${g.rose.length ? ` Drawing more than before: ${
      g.rose.map(r => `${r.name} +${f(r.now - r.was)} MW`).join(', ')}.` : ''} <span class="n-hint">See the Blackboard's Power tab.</span>`;
    g.rose.forEach(r => {
      const name = rowsBy[r.key]?.querySelector('div > div > div');
      if (name) name.insertAdjacentHTML('beforeend', ` <span class="sv-alert" title="Its machines draw ${f(r.was)} → ${f(r.now)} MW since its plan before, and the grid is short">⚡ +${f(r.now - r.was)} MW</span>`);
    });
  }).catch(() => {});
}

// Backups: everything that's yours (factories, history, plans, board, unlocks,
// save nodes, map picture) in one zip, kept in the planner's backups/ folder
function backupBox() {
  const el = document.createElement('div');
  el.className = 'sv-bk';
  const kb = n => n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
  const when = f => f.replace(/^.*?(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)\d\d.*$/, '$1-$2-$3 $4:$5');
  const restore = (body, ctype, what) => {
    if (!confirm(`Restore ${what}? Every factory, its history, the board and your unlocks become what's in it. What's here now is backed up first.`)) return;
    fetch('/api/restore', { method: 'POST', headers: { 'Content-Type': ctype }, body }).then(r => r.json()).then(d => {
      if (d.error) { alert(d.error); return; }
      alert(`Restored ${d.factories} ${d.factories === 1 ? 'factory' : 'factories'}. What was here is in ${d.before}.`);
      location.reload();
    });
  };
  const draw = d => {
    el.innerHTML = `<div class="sv-bk-h"><span>Backups</span>
        <button class="bsm" id="bk-make" title="Zip every factory, its history and plans, the board, unlocks, your save's nodes and map picture">💾 Back up now</button>
        <label class="bsm" title="Restore from a backup zip">Restore a zip…<input type="file" accept=".zip" id="bk-file" hidden></label></div>
      ${d.backups.length ? d.backups.slice(0, 8).map(b => `<div class="sv-v"><span>${when(b.file)}<br><span class="n-hint">${
          b.factories} ${b.factories === 1 ? 'factory' : 'factories'} · ${kb(b.size)}${b.auto ? ' · before a restore' : ''}</span></span>
        <a class="bsm" href="/api/backup/${b.file}" download="${b.file}">Save as…</a>
        <button class="bsm" data-f="${b.file}">Restore</button></div>`).join('') : '<div class="n-hint">None yet.</div>'}
      <div class="n-hint" style="margin-top:3px">In ${d.folder}</div>`;
    el.querySelector('#bk-make').addEventListener('click', () =>
      fetch('/api/backup', { method: 'POST' }).then(r => r.json()).then(draw));
    el.querySelector('#bk-file').addEventListener('change', e => {
      const f = e.target.files[0];
      if (f) restore(f, 'application/zip', f.name);
    });
    el.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () =>
      restore(JSON.stringify({ file: b.dataset.f }), 'application/json', `the backup from ${when(b.dataset.f)}`)));
  };
  fetch('/api/backups').then(r => r.json()).then(draw).catch(() => {});
  return el;
}

// the results bar's pin
document.addEventListener('click', e => {
  const b = e.target.closest('#rb [data-rb]');
  if (!b) return;
  ({ pin: pinPlan, unpin, compare: openCompare })[b.dataset.rb]?.();
});
document.addEventListener('pin-changed', () => { _rbLastHTML = null; renderResultsBar(); });

// ── Shards and sloops for every factory, where they do the most ──
// Sloops where they raise a goal the most (as a share of it); shards where
// they save the most machine space. Apply writes them into the factories and
// re-solves them.
function spreadHTML(d) {
  const f = d.factories || [];
  if (!f.length) return '<p class="n-hint">No factory maximises a goal yet — only those grow with more.</p>';
  const pct = (a, b) => (b > 0 ? `+${(100 * (a - b) / b).toFixed(1)}%` : '');
  const ch = (a, b) => (a === b ? `${a}` : `${a} → <b>${b}</b>`);
  return `<table class="st-tab cmp"><tr><th>Factory</th><th style="text-align:right">Sloops</th><th style="text-align:right">Shards</th>
      <th style="text-align:right">Goal</th><th style="text-align:right">Space saved</th></tr>
    ${f.map(r => `<tr><td>${r.name}</td><td class="num">${ch(r.sloops_now, r.sloops ?? 0)}</td><td class="num">${ch(r.shards_now, r.shards ?? 0)}</td>
      <td class="num cmp-up">${r.goal > r.goal0 + 1e-6 ? pct(r.goal, r.goal0) : ''}</td>
      <td class="num cmp-up">${r.space0 - r.space > 0.05 ? `${(r.space0 - r.space).toFixed(1)} u` : ''}</td></tr>`).join('')}</table>
    <p class="n-hint" style="margin-top:8px">Measured with machines in fractions; each factory's own solve then places them on whole machines.
      Against no shards or sloops at all.</p>`;
}
function openSpread() {
  const box = document.getElementById('sp-full-b');
  const run = (sh, sl) => fetch('/api/spread', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sh == null ? {} : { shards: sh, sloops: sl }) }).then(r => r.json());
  const draw = d => {
    box.innerHTML = `<div class="sp-in">You have <input id="spr-sh" type="number" min="0" value="${d.shards}"/> power shards and
        <input id="spr-sl" type="number" min="0" value="${d.sloops}"/> somersloops for machines
        <button class="bsm" id="spr-go">Work it out</button></div>${spreadHTML(d)}
      <div class="cmp-b"><button class="bsm act" id="spr-apply" ${(d.factories || []).length ? '' : 'disabled'}
        title="Write these into the factories, then re-solve them in order">Use these and re-solve</button></div>`;
    const go = () => { box.querySelector('#spr-go').textContent = 'Working…'; run(+box.querySelector('#spr-sh').value || 0, +box.querySelector('#spr-sl').value || 0).then(draw); };
    box.querySelector('#spr-go').onclick = go;
    box.querySelectorAll('.sp-in input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') go(); }));
    box.querySelector('#spr-apply').onclick = () => {
      const apply = Object.fromEntries((d.factories || []).map(r => [r.key, { shards: r.shards ?? 0, sloops: r.sloops ?? 0 }]));
      fetch('/api/spread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apply }) })
        .then(r => r.json()).then(res => {
          document.dispatchEvent(new CustomEvent('factories-changed', { detail: { keys: res.changed || [] } }));
          if (res.changed?.length) document.dispatchEvent(new CustomEvent('resolve-chain', { detail: { keys: res.changed } }));
          box.querySelector('.cmp-b').innerHTML = `<span class="n-hint">${res.changed?.length ? `Saved into ${res.changed.length} — re-solving them.` : 'Nothing to change.'}</span>`;
        });
    };
  };
  openSplit('Shards and sloops, across your factories', '<p class="n-hint">Working it out…</p>');
  run().then(draw);
}
document.addEventListener('click', e => { if (e.target.closest('#sv-spread')) openSpread(); });


// ══════════════════════════════════════════════════════════
// COMPARE TWO PLANS
// ══════════════════════════════════════════════════════════
/**
 * Compare — pin a plan, change something, see the difference.
 *
 * 📌 on the results bar keeps the plan on screen (and the factory's inputs
 * behind it). Every solve after shows, under each number, how it moved from
 * the pinned one — green better, amber worse — and Compare lays the two side
 * by side: goals, power, machines, space, each resource drawn, the machines
 * by kind and the recipes only one of them runs. "Back to the pinned" puts
 * the pinned inputs back (an undoable edit) and solves them.
 */
let PIN = null;
export const pinned = () => PIN;

/** What's worth comparing in a plan. */
export function summary(r) {
  if (!r?.flows) return null;
  const used = r.flows.reduce((a, f) => a + Math.max(0, f.power_mw || 0), 0) + (r.extractor_power_mw || 0);
  const made = r.flows.reduce((a, f) => a + (f.outputs?.Power || 0), 0) + (r.geothermal_mw || 0);
  const drawn = {}, machines = {};
  r.flows.forEach(f => {
    machines[f.machine] = (machines[f.machine] || 0) + (f.machines_final || 0);
    Object.entries(f.inputs || {}).forEach(([i, v]) => { if (i in (r.source_nodes || {})) drawn[i] = (drawn[i] || 0) + v; });
  });
  return { goals: { ...(r.objective_items || {}) }, used, made, machines: r.total_machines || 0, space: r.total_space || 0,
           shards: r.shards_used || 0, sloops: r.sloops_used || 0, drawn, byMachine: machines,
           recipes: new Set(r.flows.filter(f => f.machines_final > 0).map(f => f.recipe_key)) };
}

export function pinPlan() {
  const s = summary(RESULT);
  if (!s) return;
  PIN = { s, sc: JSON.parse(JSON.stringify(SC)), name: SC.name || 'this factory', at: new Date() };
  document.dispatchEvent(new Event('pin-changed'));
}
export function unpin() { PIN = null; document.dispatchEvent(new Event('pin-changed')); }

const fmt = v => (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : +v.toFixed(Math.abs(v) < 10 ? 2 : 1)).toLocaleString();
/** How a number moved from the pinned plan: { text, cls } (cls: up / down — better / worse), or null. */
export function delta(now, was, more = 'better') {
  if (was == null || now == null) return null;
  const d = now - was;
  if (Math.abs(d) < Math.max(1e-3, Math.abs(was) * 1e-4)) return { text: '=', cls: 'eq' };
  const good = more === 'better' ? d > 0 : d < 0;
  return { text: `${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}`, cls: good ? 'up' : 'down' };
}

// The two side by side
function row(label, a, b, more, unit = '') {
  const dd = delta(b, a, more);
  return `<tr><td>${label}</td><td class="num">${a == null ? '—' : fmt(a) + unit}</td><td class="num">${b == null ? '—' : fmt(b) + unit}</td>
    <td class="num cmp-${dd?.cls || 'eq'}">${dd && dd.text !== '=' ? dd.text + unit : ''}</td></tr>`;
}
export function openCompare() {
  const A = PIN?.s, B = summary(RESULT);
  if (!A || !B) return;
  const keys = (x, y) => [...new Set([...Object.keys(x), ...Object.keys(y)])];
  const rname = k => (RECIPES[k]?.display || k).replace(/^Alternate:\s*/i, 'Alt: ');
  const onlyA = [...A.recipes].filter(k => !B.recipes.has(k)), onlyB = [...B.recipes].filter(k => !A.recipes.has(k));
  const sec = t => `<tr class="cmp-h"><td colspan="4">${t}</td></tr>`;
  const html = `<table class="st-tab cmp"><tr><th></th><th style="text-align:right">📌 Pinned</th><th style="text-align:right">Now</th><th style="text-align:right">Change</th></tr>
    ${sec('Goals')}${keys(A.goals, B.goals).map(k => row(itemName(k), A.goals[k] ?? 0, B.goals[k] ?? 0, 'better', k === 'Power' ? ' MW' : '/min')).join('')}
    ${sec('What it takes')}${row('Power use', A.used, B.used, 'worse', ' MW')}${A.made || B.made ? row('Power made', A.made, B.made, 'better', ' MW') : ''}
    ${row('Machines', A.machines, B.machines, 'worse')}${row('Space · smelters', A.space, B.space, 'worse', ' u')}
    ${A.shards || B.shards ? row('Shards', A.shards, B.shards, 'worse') : ''}${A.sloops || B.sloops ? row('Sloops', A.sloops, B.sloops, 'worse') : ''}
    ${sec('Resources drawn')}${keys(A.drawn, B.drawn).map(k => row(itemName(k), A.drawn[k] ?? 0, B.drawn[k] ?? 0, 'worse', '/min')).join('')}
    ${sec('Machines')}${keys(A.byMachine, B.byMachine).map(k => row(k.replace(/_/g, ' '), A.byMachine[k] ?? 0, B.byMachine[k] ?? 0, 'worse')).join('')}
    </table>
    ${onlyA.length || onlyB.length ? `<div class="cmp-rec">${onlyA.length ? `<div><b>Only pinned:</b> ${onlyA.map(rname).join(', ')}</div>` : ''}
      ${onlyB.length ? `<div><b>Only now:</b> ${onlyB.map(rname).join(', ')}</div>` : ''}</div>` : '<p class="n-hint">The same recipes.</p>'}
    <div class="cmp-b"><button class="bsm" id="cmp-back" title="Put the pinned plan's inputs back and solve them — Ctrl+Z undoes it">⟲ Back to the pinned</button>
      <button class="bsm" id="cmp-repin" title="Pin the plan on screen instead">📌 Pin this one instead</button>
      <button class="bsm" id="cmp-unpin">Unpin</button></div>`;
  openSplit(`Pinned ${PIN.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} against now — ${PIN.name}`, html);
  document.getElementById('cmp-back').onclick = () => document.dispatchEvent(new CustomEvent('restore-sc', { detail: PIN.sc }));
  document.getElementById('cmp-repin').onclick = () => { pinPlan(); openCompare(); };
  document.getElementById('cmp-unpin').onclick = () => { unpin(); document.querySelector('#sp-full [data-far-close]')?.click(); };
}


// ══════════════════════════════════════════════════════════
// THE CHAIN
// ══════════════════════════════════════════════════════════
/**
 * The chain — re-solve factories in order: sources first, each importer held to
 * what its sources make now, then solved (server: /api/resolve-chain).
 * One run at a time; anything showing progress listens with onChain.
 */
const fmtC = v => (v == null ? '—' : (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : +v.toFixed(2)).toLocaleString());
const listeners = new Set();
let timer = null, last = null;

export function onChain(fn) { listeners.add(fn); if (last) fn(last); return () => listeners.delete(fn); }

function poll() {
  fetch('/api/resolve-chain').then(r => r.json()).then(st => {
    last = st;
    listeners.forEach(fn => fn(st));
    if (st.running) timer = setTimeout(poll, 800);
    else timer = null;
  }).catch(() => { timer = null; });
}

/** keys: the factories to start from (null: everything out of date). */
export function startChain(keys = null) {
  return fetch('/api/resolve-chain', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(keys ? { keys } : {}) }).then(r => r.json()).then(d => {
    if (!timer) poll();
    return d;
  });
}
export function watchChain() { if (!timer) poll(); }

// What a run did, as HTML: one line per factory
export function chainHTML(st) {
  if (!st || (!st.running && !st.steps.length)) return '';
  const done = st.steps.filter(s => s.status !== 'solving').length;
  const rows = st.steps.map(s => {
    const ok = String(s.status).startsWith('Optimal');
    const cut = (s.cut || []).filter(c => c.kind === 'import').map(c => `${c.item.replace(/_/g, ' ')} from ${c.factory} ${fmtC(c.asked)} → ${fmtC(c.rate)}`);
    const unmet = Object.entries(s.owed_unmet || {}).map(([k, v]) => `${k.replace(/_/g, ' ')} ${fmtC(v)} short`);
    return `<div class="ch-row ${s.status === 'solving' ? '' : ok ? '' : 'n-warn'}">
      <b>${s.name || s.key}</b> ${s.status === 'solving' ? '<span class="n-hint">solving…</span>'
        : ok ? `<span class="n-hint">goal ${fmtC(s.before)} → <b>${fmtC(s.after)}</b></span>` : `<span>${s.error || s.status}</span>`}
      ${cut.length ? `<div class="n-hint n-warn">imports held to what's left: ${cut.join('; ')}</div>` : ''}
      ${unmet.length ? `<div class="n-hint n-warn">can't make all it owes: ${unmet.join('; ')}</div>` : ''}</div>`;
  }).join('');
  return `<div class="ch-box"><div class="n-sent-t">${st.running ? `Re-solving ${done + 1} of ${st.todo.length}…` : `Re-solved ${st.steps.length}`}</div>${rows}</div>`;
}


// ══════════════════════════════════════════════════════════
// THE BUILD SHEET
// ══════════════════════════════════════════════════════════
/**
 * What to place, line by line, from the last solve.
 *
 * One line per recipe the plan runs, in the order you'd build them (what's
 * made from your resources first): its machines and their clock — the even
 * clock the plan uses (least power), or all but one at 100% (easiest to set)
 * — what comes in and goes out, each with the belt (or pipe) it needs, and
 * for each input the splitters and mergers that feed every machine exactly
 * its share (geometry.js), a click away.
 */
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
  const got = BUILT.p && BUILT.key ? BUILT.p.factories[BUILT.key]?.lines : null;
  const built = f => {
    if (!got) return '';
    const b = Math.min(f.machines_final, got[f.recipe_key]?.[1] || 0);
    return b >= f.machines_final ? '<span class="bs-b done" title="Built, in your save">✓</span>'
      : `<span class="bs-b" title="In your save">${b ? `${b}/${f.machines_final}` : 'to build'}</span>`;
  };
  return `<div class="bc-h bc-top"><span>Lines — what to place, in order</span><button class="bsm" id="bs-plan" title="Each line's machines at their real footprint, and how many foundations">📐 Floor plan</button></div>`
    + (fp => `<div class="n-hint" style="margin:-2px 0 4px">About ${Math.round(fp.W)} × ${Math.round(fp.L)} m${fp.floors.length > 1 ? `, ${fp.floors.length} floors` : ' on one floor'} · ${fp.found} foundations</div>`)(floorPlan(fpSize())) + ordered(flows).map((f, li) => {
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
        <span class="bs-n">${esc(rname(f))}</span>${built(f)}<span class="bs-k" title="${k.easy ? `Or ${k.easy} — easier to set, a little more power` : 'Every machine at this clock'}">${k.even}</span></div>
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
// How one input reaches a line's machines, in words: the easy way (a manifold)
// and the exact one (a balancer), as a pattern that repeats — per belt when
// it takes more than one
function feedHTML(f, it) {
  const rate = f.inputs[it], cr = carrier(it, rate), n = f.machines_final, m = f.machine.replace(/_/g, ' ');
  const ms = k => `${k} ${m}${k === 1 ? '' : 's'}`;
  const belt = cr.label.replace(/^\d+ × /, '').replace(/s$/, '');
  // the machines shared across the belts: as even as it goes
  const per = [...Array(cr.n)].map((_, i) => Math.floor(n / cr.n) + (i < n % cr.n ? 1 : 0)).filter(k => k);
  const groups = [...new Set(per)].map(k => [k, per.filter(x => x === k).length]);
  const pattern = k => {
    if (k === 1) return '<li>The belt goes straight in.</li>';
    const p = feedPattern(rate * k / n, k);
    let belts = 1, lines = [];
    if (p.spare) lines.push(`<li><b>Merge</b> ${p.spare} belt${p.spare > 1 ? 's' : ''} looped back from the end into the incoming one — it then carries <b>${num(p.load)}/min</b>${p.load > cr.cap + 1e-6 ? ' <span class="n-warn">(over the belt)</span>' : ''}</li>`);
    // runs of the same split, said once: "2 ways, 3 times over: 1 → 2 → 4 → 8"
    const runs = [];
    p.splits.forEach(x => (runs.length && runs[runs.length - 1][0] === x ? runs[runs.length - 1][1]++ : runs.push([x, 1])));
    const times = t => ['', '', 'twice', 'three times', 'four times', 'five times', 'six times'][t] || `${t} times`;
    runs.forEach(([x, t], i) => {
      const chain = [belts];
      for (let j = 0; j < t; j++) chain.push(chain[chain.length - 1] * x);
      const out = chain[chain.length - 1], last = i === runs.length - 1;
      lines.push(`<li>${belts === 1 ? 'Split it' : `Split each of the ${belts}`} <b>${x} ways${t > 1 ? `, ${times(t)} over` : ''}</b>${
        t > 1 ? ` <span class="n-hint">(each new belt splits again)</span>` : ''}: ${chain.join(' → ')} belts of ${num(p.load / out)}/min${
        last ? (p.spare ? ` — ${k} to the ${m}s, ${p.spare} back to the merger` : ` — one per ${m}`) : ''}</li>`);
      belts = out;
    });
    return lines.join('') + `<li class="n-hint">${p.splitters} splitter${p.splitters === 1 ? '' : 's'}${p.spare ? ', 1 merger' : ''}</li>`;
  };
  const head = cr.n > 1
    ? `${cr.n} ${belt}s of ${num(rate / cr.n)}/min${groups.length === 1 ? `, ${ms(groups[0][0])} on each` : ''}`
    : `one ${belt}`;
  return `<div class="fd-h">${esc(itemName(it))} <b>${num(rate)}/min</b> → ${ms(n)}, ${num(rate / n)}/min each</div>
    <div class="fd-w"><b>Easiest — a manifold:</b> run ${head} along the ${m}s with a splitter in front of each.
      They fill up, then each takes its share.</div>
    <div class="fd-w"><b>Exact from the start — a balancer</b>${cr.n > 1 ? `, on each belt` : ''}:
      ${groups.map(([k, c]) => `${groups.length > 1 ? `<div class="n-hint">${c} belt${c > 1 ? 's' : ''} with ${ms(k)}:</div>` : ''}<ol class="fd-ol">${pattern(k)}</ol>`).join('')}</div>
    ${f.layout?.length > 1 ? '<div class="n-hint">Machines at a lower clock take a little less: their belt backs up and the rest still get theirs.</div>' : ''}
    <button class="bsm fd-draw">Draw it</button>`;
}

/** Wire the ⑂ buttons in `el` (after linesHTML). */
export function wireLines(el) {
  const flows = ordered((RESULT?.flows || []).filter(f => f.machines_final > 0));
  el.querySelectorAll('.bs-sp').forEach(b => b.addEventListener('click', () => {
    const f = flows[+b.dataset.line], it = b.dataset.item, box = el.querySelector(`.bs-d[data-for="${b.dataset.line}|${CSS.escape(it)}"]`);
    if (!box) return;
    if (box.innerHTML) { box.innerHTML = ''; b.classList.remove('on'); return; }
    b.classList.add('on');
    box.innerHTML = feedHTML(f, it);
    box.querySelector('.fd-draw').onclick = () => {
      const rate = f.inputs[it], cr = carrier(it, rate);
      const d = design(Array(cr.n).fill(rate / cr.n), shares(f, rate), { cap: cr.cap });
      openSplit(`${itemName(it)} ${num(rate)}/min → ${f.machines_final} × ${f.machine.replace(/_/g, ' ')}`, d?.graph
        ? `<div class="sp-d">${splitSVG(d.graph, num, itemColor(it, FLUIDS.has(it)))}</div>` : `<p class="n-warn">${esc(d?.error || 'No design for these numbers.')}</p>`);
    };
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
// fold so they fit the width. Given a footprint (foundations across × deep),
// the rows fill a floor up to its depth, then the next floor goes on top —
// each as high as its tallest machine plus a belt layer — and a line fed from
// another floor gets a lift. Foundations: 8 m.
const GAP = 1, LANE = 4, FOUND = 8, ROW_MAX = 120, BELT_LAYER = 4;
export function floorPlan(fp = {}) {
  const flows = ordered((RESULT?.flows || []).filter(f => f.machines_final > 0));
  const wide = fp.wide > 0 ? fp.wide * FOUND : null, deep = fp.deep > 0 ? fp.deep * FOUND : null;
  const rowMax = wide ? Math.max(8, wide - 2 * LANE) : ROW_MAX;
  const rows = [];
  flows.forEach(f => {
    const [w, l, h] = MACHINE_SIZE[f.machine] || [8, 8, 8];
    const n = f.machines_final, per = Math.max(1, Math.floor((rowMax + GAP) / (w + GAP)));
    for (let k = 0; k < n; k += per) rows.push({ f, w, l, h: h || 8, count: Math.min(per, n - k), first: k === 0 });
  });
  // rows onto floors: a row that would pass the depth starts the next floor
  const floors = [];
  let cur = null;
  rows.forEach(r => {
    const need = r.l + 2 * LANE;
    if (!cur || (deep && cur.y + need > deep && cur.rows.length)) floors.push(cur = { rows: [], y: 0, W: 0, H: 0 });
    r.y = cur.y + LANE; r.len = r.count * r.w + (r.count - 1) * GAP;
    cur.y = r.y + r.l + LANE; cur.W = Math.max(cur.W, r.len); cur.H = Math.max(cur.H, r.h);
    r.floor = floors.length - 1; cur.rows.push(r);
  });
  const W = Math.max(0, ...floors.map(x => x.W)) + 2 * LANE, L = Math.max(0, ...floors.map(x => x.y));
  let up = 0;
  floors.forEach(x => { x.z = up; up += x.H + BELT_LAYER; });
  // lifts: what a line takes from a line on another floor
  const at = new Map(), lifts = [];
  rows.forEach(r => { if (r.first) at.set(r.f, r.floor); });
  const makers = {};
  flows.forEach(f => Object.keys(f.outputs || {}).forEach(it => (makers[it] = makers[it] || []).push(f)));
  flows.forEach(f => Object.entries(f.inputs || {}).forEach(([it, rate]) => {
    const to = at.get(f);
    [...new Set((makers[it] || []).filter(m => m !== f).map(m => at.get(m)))].forEach(from => {
      if (from !== to) lifts.push({ item: it, rate, from, to, f });
    });
  }));
  const rw = wide || W, rl = deep || L;
  return { rows, floors, lifts, W: rw, L: rl, height: up - BELT_LAYER,
           found: Math.ceil(rw / FOUND) * Math.ceil(rl / FOUND) * floors.length };
}
const FP_KEY = 'fp-size';
const fpSize = () => { try { return JSON.parse(localStorage.getItem(FP_KEY)) || {}; } catch { return {}; } };
export function floorPlanHTML() {
  const size = fpSize(), v = x => (x ? x : '');
  if (!RESULT?.flows?.some(f => f.machines_final > 0)) return '<p class="n-hint">Solve first.</p>';
  return `<div class="fp-ctl">Footprint <input type="number" id="fp-w" min="0" step="1" placeholder="any" value="${v(size.wide)}"/> ×
      <input type="number" id="fp-d" min="0" step="1" placeholder="any" value="${v(size.deep)}"/> foundations
      <span class="n-hint">— deeper than that, it stacks floors</span></div><div id="fp-body">${floorPlanBody(size)}</div>`;
}
function floorPlanBody(size) {
  const p = floorPlan(size);
  const many = p.floors.length > 1;
  const k = Math.min(6, (many ? 560 : 900) / Math.max(p.W, 1)), pad = 150, gapF = 40;
  let g = '', ox = 0;
  p.floors.forEach((fl, fi) => {
    const x0 = ox + pad;
    for (let x = 0; x <= p.W + 1e-6; x += FOUND) g += `<line class="fp-g" x1="${x0 + x * k}" y1="24" x2="${x0 + x * k}" y2="${24 + p.L * k}"/>`;
    for (let y = 0; y <= p.L + 1e-6; y += FOUND) g += `<line class="fp-g" x1="${x0}" y1="${24 + y * k}" x2="${x0 + p.W * k}" y2="${24 + y * k}"/>`;
    if (many) g += `<text class="fp-t" x="${x0}" y="14">Floor ${fi + 1}${fl.z ? ` · ${Math.round(fl.z)} m up` : ' · ground'}</text>`;
    fl.rows.forEach(r => {
      const c = mCol(r.f.machine), y = 24 + r.y * k;
      g += `<rect class="fp-lane" x="${x0 + (LANE - 1) * k}" y="${y - (LANE - 0.5) * k}" width="${(r.len + 2) * k}" height="${(LANE - 1) * k}"/>`;
      for (let i = 0; i < r.count; i++)
        g += `<rect x="${x0 + (LANE + i * (r.w + GAP)) * k}" y="${y}" width="${r.w * k}" height="${r.l * k}" rx="2" style="fill:${c}33;stroke:${c}"/>`;
      if (r.first) {
        const ins = p.lifts.filter(l => l.f === r.f);
        g += `<text class="fp-t" x="${x0 - 8}" y="${y + r.l * k / 2 + 4}" text-anchor="end">${esc(rname(r.f))}</text>
          <text class="fp-s" x="${x0 - 8}" y="${y + r.l * k / 2 + 16}" text-anchor="end">${r.f.machines_final} × ${esc(r.f.machine.replace(/_/g, ' '))}</text>
          ${ins.map((l, i) => `<text class="fp-lift" x="${x0 - 8}" y="${y + r.l * k / 2 + 28 + i * 12}" text-anchor="end">${l.from < l.to ? '↑' : '↓'} ${esc(itemName(l.item))} from floor ${l.from + 1}</text>`).join('')}`;
      }
    });
    ox += pad + p.W * k + gapF;
  });
  return `<p class="n-hint" style="margin:0 0 6px">About <b>${Math.round(p.W)} × ${Math.round(p.L)} m</b>${many
      ? `, <b>${p.floors.length} floors</b> (${Math.round(p.height)} m tall), <b>${p.lifts.length}</b> belt lift${p.lifts.length === 1 ? '' : 's'} between them` : ', one floor'}
      — <b>${p.found}</b> foundations (8 m). Machines side by side ${GAP} m apart, a ${LANE} m belt lane either side of each row; long rows fold.
      A guide to the room it needs, not a layout.</p>
    <svg class="fp" width="${ox - gapF + 10}" height="${24 + p.L * k + 10 + (many ? 0 : 0)}">${g}</svg>`;
}
// the footprint boxes, typed: kept for next time, and the plan (not the boxes) redrawn as you type
document.addEventListener('input', e => {
  if (!e.target.closest('#fp-w, #fp-d')) return;
  const n = id => Math.max(0, Math.floor(+document.getElementById(id).value || 0)) || null;
  const size = { wide: n('fp-w'), deep: n('fp-d') };
  try { localStorage.setItem(FP_KEY, JSON.stringify(size)); } catch {}
  document.getElementById('fp-body').innerHTML = floorPlanBody(size);
});
document.addEventListener('click', e => {
  if (e.target.closest('#bs-plan')) openSplit(`Floor plan — ${RESULT?.scenario_name || 'this factory'}`, floorPlanHTML());
});


// ══════════════════════════════════════════════════════════
// ANALYSIS
// ══════════════════════════════════════════════════════════
/**
 * What limits the plan, where to lift it, and what-if sliders.
 */
// ── DOM helpers ───────────────────────────────────────────
function section(parent, title, extraHTML = '') {
  const d = document.createElement('div');
  d.className = 'an-section';
  d.innerHTML = `<div class="an-title">${title}</div><div class="an-body">${extraHTML}</div>`;
  parent.appendChild(d);
}

function statCard(label, val, color) {
  return `<div style="background:var(--p3);border:1px solid var(--b);border-radius:var(--rsm);padding:8px 10px">
    <div style="font-family:var(--mono);font-size:16px;font-weight:600;color:${color}">${val}</div>
    <div style="font-size:10px;color:var(--t3);margin-top:2px">${label}</div>
  </div>`;
}

// ── Public API ────────────────────────────────────────────
// The Analysis is the right panel's Analysis tab: openAnalysis shows it,
// showAnalysis draws it (whenever the tab is shown, or a solve lands while it is)
export function openAnalysis() { openDock('analysis'); }
export function showAnalysis() {
  renderAnalysis();          // render immediately with whatever we have

  // Fetch the analysis lazily (computed once per solve on the server)
  if (RESULT?.status?.startsWith('Optimal') && !RESULT.analysis) {
    const res = RESULT;
    const body = document.getElementById('analysis-body');
    // Subtle loading indicator — don't wipe the already-rendered content
    const loadingBanner = document.createElement('div');
    loadingBanner.id = 'duals-loading';
    loadingBanner.style.cssText =
      'font-size:11px;color:var(--t3);padding:6px 12px;text-align:center';
    loadingBanner.textContent = 'Computing shadow prices…';
    body.prepend(loadingBanner);

    fetchDuals()
      .then(analysis => {
        res.analysis          = analysis || {};
        res.shadow_prices     = res.analysis.shadow_prices     || {};
        res.saturation_points = res.analysis.saturation_points || {};
        if (res === RESULT) renderAnalysis();   // re-render unless a new solve replaced it
      })
      .catch(() => {
        const banner = document.getElementById('duals-loading');
        if (banner) banner.textContent = 'Shadow prices unavailable.';
      });
  }
}

export function closeAnalysis() { if (dockTab() === 'analysis') closeDock(); }

// ── Render ────────────────────────────────────────────────
function renderAnalysis() {
  const el = document.getElementById('analysis-body');
  el.innerHTML = '';

  if (!RESULT || !RESULT.status) {
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                  padding:40px 20px;gap:12px;color:var(--t3);text-align:center">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.5" opacity=".4">
          <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
          <line x1="6" y1="20" x2="6" y2="14"/>
        </svg>
        <p style="font-size:13px;color:var(--t2)">No solve result yet</p>
        <p style="font-size:11px;line-height:1.5">
          Run a solve first (▶ Solve or Ctrl+R),<br>then open Analysis to see resource
          utilisation, shadow prices, and machine breakdown.
        </p>
      </div>
    `;
    return;
  }

  if (!RESULT.status?.startsWith('Optimal')) {
    el.innerHTML = `
      <div style="padding:20px;color:var(--err);font-size:12px;line-height:1.6">
        <b>Solve did not reach an optimal solution.</b><br>
        Status: ${RESULT.status}<br><br>
        Check the Issues panel for constraint conflicts.
      </div>
    `;
    return;
  }

  const flows     = RESULT.flows || [];
  const duals     = RESULT.shadow_prices || {};
  const sats      = RESULT.saturation_points || {};
  const resources = Object.entries(RESULT.source_nodes || {});

  // ── Resource utilisation + shadow prices ──────────────────────────────────
  const consumed = {};
  flows.forEach(f => {
    Object.entries(f.inputs || {}).forEach(([item, rate]) => {
      consumed[item] = (consumed[item] || 0) + rate;
    });
  });

  const unlimitedSet = new Set(RESULT.unlimited_resources || []);
  const utils = resources.map(([item, available]) => {
    const used  = consumed[item] || 0;
    const unlimited = unlimitedSet.has(item);
    const pct   = unlimited ? 0 : available > 0 ? Math.min(100, (used / available) * 100) : 0;
    const dual  = duals[item] ?? null;
    const satAt = sats[item] ?? null;
    return { item, available, used, pct, dual, satAt, unlimited };
  }).sort((a, b) => (a.unlimited - b.unlimited) || (b.pct - a.pct));

  const binding   = utils.filter(u => !u.unlimited && u.pct >= 99.0);
  const coBinding = binding.length > 1;
  const hasDuals  = Object.keys(duals).length > 0;

  section(el, 'Resource Utilisation & Shadow Prices', `
    <p style="font-size:11px;color:var(--t3);margin-bottom:10px;line-height:1.6">
      <b style="color:var(--t2)">Shadow price</b> = extra objective value per additional unit/min.
      Zero means the resource has slack — adding more won't help yet.
      ${coBinding
        ? `<br><span style="color:var(--warn)">⚠ Co-binding:</span>
           ${binding.map(u => itemName(u.item)).join(' &amp; ')} are
           all at 100% simultaneously. You must expand all of them together
           to gain more output.`
        : ''}
    </p>
  `);

  if (!resources.length) {
    el.querySelector('.an-section:last-child .an-body').innerHTML +=
      '<p style="font-size:11px;color:var(--t3)">No resource constraints in this scenario.</p>';
  } else {
    utils.forEach(({ item, available, used, pct, dual, satAt, unlimited }) => {
      if (unlimited) {
        el.querySelector('.an-section:last-child .an-body').innerHTML += `
          <div style="margin-bottom:13px;padding-bottom:11px;border-bottom:1px solid var(--b)">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">
              <span style="font-size:12px;font-weight:600;color:var(--t)">${itemName(item)}</span>
              <span style="font-size:10px;color:var(--acc);font-weight:600">∞ Unlimited</span>
            </div>
            <div style="font-size:10px;color:var(--t3);font-family:var(--mono)">
              ${used.toFixed(2)} per min drawn · free, no cap</div>
          </div>`;
        return;
      }
      const barColor  = pct >= 99 ? 'var(--err)' : pct >= 80 ? 'var(--warn)' : 'var(--ok)';
      const statusLbl = pct >= 99 ? '⚠ Binding'  : pct >= 80 ? 'Near limit'  : 'Slack';

      let shadowLine = '';
      if (!hasDuals) {
        shadowLine = `<span style="color:var(--t3)">shadow price unavailable</span>`;
      } else if (dual === null || dual < 0.0001) {
        shadowLine = `<span style="color:var(--t3)">+0 obj/unit — not a bottleneck</span>`;
      } else {
        const satText = satAt !== null
          ? ` <span style="color:var(--t3)">(becomes 0 above ${satAt.toLocaleString()}/min)</span>`
          : ` <span style="color:var(--t3)">(no saturation found in range)</span>`;
        shadowLine = `<span style="color:var(--acc);font-family:var(--mono);font-weight:600">+${dual.toFixed(4)} obj/unit</span>${satText}`;
      }

      el.querySelector('.an-section:last-child .an-body').innerHTML += `
        <div style="margin-bottom:13px;padding-bottom:11px;border-bottom:1px solid var(--b)">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">
            <span style="font-size:12px;font-weight:600;color:var(--t)">${itemName(item)}</span>
            <span style="font-size:10px;color:${barColor};font-weight:600">${statusLbl}</span>
          </div>
          <div style="height:5px;border-radius:3px;background:var(--b2);overflow:hidden;margin-bottom:3px">
            <div style="height:100%;width:${pct.toFixed(1)}%;background:${barColor};border-radius:3px"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:10px;
                      color:var(--t3);font-family:var(--mono);margin-bottom:5px">
            <span>${used.toFixed(2)} / ${available.toFixed(2)} per min</span>
            <span>${pct.toFixed(1)}%</span>
          </div>
          <div style="font-size:11px">${shadowLine}</div>
          ${pct >= 99 && dual > 1e-4 ? `<div class="an-fix" data-res="${item}" data-dual="${dual}" data-room="${satAt !== null ? Math.max(0, satAt - available) : ''}"></div>` : ''}
        </div>
      `;
    });

    if (!hasDuals) {
      el.querySelector('.an-section:last-child .an-body').innerHTML +=
        `<p style="font-size:11px;color:var(--t3);line-height:1.5">
          Shadow prices could not be extracted for this solve.
          This can occur when the LP is degenerate or when integer
          power/machine constraints alter the basis.
        </p>`;
    }
  }

  fillFixes(el);
  whatIf(el);

  // ── Power breakdown ───────────────────────────────────────────────────────
  section(el, 'Power Breakdown');
  const powBody   = el.querySelector('.an-section:last-child .an-body');
  const powByMach = {};
  flows.forEach(f => { powByMach[f.machine] = (powByMach[f.machine] || 0) + (f.power_mw || 0); });
  if (RESULT.extractor_power_mw) powByMach.Extractors = RESULT.extractor_power_mw;   // miners, pumps: drawn too

  const powUsed = Object.values(powByMach).filter(p => p > 0).reduce((a, b) => a + b, 0);
  const powMade = Object.values(powByMach).filter(p => p < 0).reduce((a, b) => a + b, 0);

  if (!Object.keys(powByMach).length) {
    powBody.innerHTML = '<p style="font-size:11px;color:var(--t3)">No power data.</p>';
  } else {
    Object.entries(powByMach).sort(([, a], [, b]) => b - a).forEach(([m, pw]) => {
      const color = mCol(m);
      // Bars are shares of the power used, or of the power made for generators
      const pct   = ((pw < 0 ? pw / powMade : pw / powUsed) * 100 || 0).toFixed(1);
      powBody.innerHTML += `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
          <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></div>
          <div style="flex:1;font-size:11px;color:var(--t2)">${m.replace(/_/g, ' ')}</div>
          <div style="font-family:var(--mono);font-size:11px;color:${pw < 0 ? 'var(--ok)' : 'var(--warn)'}">${pw < 0 ? `+${(-pw).toFixed(0)}` : pw.toFixed(0)} MW</div>
          <div style="width:60px;height:4px;border-radius:2px;background:var(--b2);overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${color};border-radius:2px"></div>
          </div>
        </div>
      `;
    });
    powBody.innerHTML += `
      <div style="border-top:1px solid var(--b);padding-top:6px;margin-top:4px;
                  font-family:var(--mono);font-size:12px;color:var(--warn)">
        ${powMade < 0 ? `Used ${powUsed.toFixed(0)} · Made ${(-powMade).toFixed(0)} · ${powUsed + powMade > 0 ? `${(powUsed + powMade).toFixed(0)} short` : `${(-(powUsed + powMade)).toFixed(0)} to spare`}` : `Total: ${powUsed.toFixed(0)}`} MW
        ${RESULT.max_power_mw ? `<span style="color:var(--t3)"> / ${RESULT.max_power_mw} MW cap</span>` : ''}
      </div>
    `;
  }

  // ── Solution summary ──────────────────────────────────────────────────────
  section(el, 'Solution Summary');
  const sumBody  = el.querySelector('.an-section:last-child .an-body');
  const altFlows = flows.filter(f => f.display?.startsWith('Alternate:') || f.display?.includes('(Alt)'));
  const alts     = altFlows.length;
  const oc       = flows.filter(f => (f.clock_pct || 100) > 100.5).length;
  const uc       = flows.filter(f => (f.clock_pct || 100) < 99.5).length;
  sumBody.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
      ${statCard('Active recipes', flows.length, 'var(--t)')}
      ${statCard('Alternate recipes', alts, 'var(--acc)')}
      ${statCard('Overclocked', oc, '#3b82f6')}
      ${statCard('Underclocked', uc, '#38bdf8')}
    </div>
  `;

}


// A limit, with where to lift it: the nearest free nodes of it, what each
// gives and about what that's worth (its shadow price, up to where it stops
// helping) — add one, and the plan is solved again
function worth(dual, extra) {
  const obj = Object.entries(SC.objective || {});
  const v = dual * extra;
  return obj.length === 1 ? `≈ +${num(v / (+obj[0][1] || 1))}/min ${itemName(obj[0][0])}` : `≈ +${num(v)} score`;
}
function fillFixes(el) {
  el.querySelectorAll('.an-fix').forEach(box => {
    const res = box.dataset.res, dual = +box.dataset.dual, room = box.dataset.room === '' ? Infinity : +box.dataset.room;
    freeNodes(res).then(list => {
      if (!box.isConnected) return;
      if (!list.length) { box.innerHTML = '<span class="n-hint">No free nodes of it left on the map — import it, or an alternate that needs less.</span>'; return; }
      box.innerHTML = `<div class="n-hint" style="margin:4px 0 2px">Nearest free nodes:</div>` + list.map(n => `
        <div class="an-node"><span class="an-p ${n.p}">${n.p[0].toUpperCase()}</span>
          <span>${n.dist == null ? '' : `${n.dist < 1000 ? `${Math.round(n.dist / 10) * 10} m` : `${(n.dist / 1000).toFixed(1)} km`} · `}+${num(n.rate)}/min</span>
          <span class="n-hint">${worth(dual, Math.min(n.rate, room))}</span>
          <button class="bsm act" data-take="${n.id}" title="Mine it here, and solve again">Add &amp; solve</button></div>`).join('');
      box.querySelectorAll('[data-take]').forEach(b => b.addEventListener('click', () => {
        takeNode(b.dataset.take);
        document.dispatchEvent(new Event('supply-changed'));
        document.getElementById('bsolve')?.click();
      }));
    });
  });
}

// ── What if: drag a supply or a fixed goal, watch the goal move ──
// Each drag asks the server for the goal's ceiling with that one number
// changed (fractional machines: fast enough to follow the mouse; whole
// machines land a little under). "Use it" puts the number in the factory.
let WI_SEQ = 0;
function whatIf(el) {
  const res = Object.entries(RESULT.source_nodes || {}).filter(([i]) => !(RESULT.unlimited_resources || []).includes(i));
  const goals = [...Object.entries(SC.must_produce || {}).map(([i, v]) => ['must', i, v]), ...Object.entries(SC.min_produce || {}).map(([i, v]) => ['min', i, v])];
  const caps = [...(SC.max_machines != null ? [['cap', 'machines', +SC.max_machines]] : []),
                ...(SC.max_power_mw != null ? [['cap', 'power', +SC.max_power_mw]] : [])];
  if (!res.length && !goals.length && !caps.length) return;
  section(el, 'What if', '<p class="n-hint" style="margin:0 0 8px">Drag one: the goal follows (with machines in fractions — whole ones land a little under).</p><div class="wi-out"></div>');
  const body = el.querySelector('.an-section:last-child .an-body'), out = body.querySelector('.wi-out');
  const obj = Object.keys(SC.objective || {});
  const show = (d, base, label) => {
    if (!d?.ok) { out.innerHTML = `<span class="n-warn">${label}: it can't be done — a fixed goal doesn't fit</span>`; return; }
    out.innerHTML = `<span class="n-hint">${label}</span> ` + (obj.length ? obj.map(i => {
      const v = d.items[i] || 0, b = base?.items?.[i] ?? v, dd = v - b;
      return `<span class="wi-v">${itemName(i)} <b>${num(v)}</b>${Math.abs(dd) > 1e-3 ? ` <i class="${dd > 0 ? 'up' : 'down'}">${dd > 0 ? '+' : '−'}${num(Math.abs(dd))}</i>` : ''}</span>`;
    }).join(' ') : '<span class="wi-v">fits</span>');
  };
  let BASE = null;
  const ask = (set, label) => {
    const mine = ++WI_SEQ;
    return fetch('/api/whatif', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: SC, set }) })
      .then(r => r.json()).then(d => { if (mine === WI_SEQ && label) show(d, BASE, label); return d; }).catch(() => null);
  };
  ask({}, null).then(d => { BASE = d; if (!out.innerHTML) show(d, d, 'As it is:'); });
  const rows = [...res.map(([i, v]) => ['res', i, v]), ...goals, ...caps];
  const CAP = { machines: ['▦ Machine cap', 'sc-mm', ''], power: ['⚡ Power cap', 'sc-mp', ' MW'] };
  const nameOf = (k, i) => k === 'cap' ? CAP[i][0] : itemName(i);
  body.insertAdjacentHTML('beforeend', rows.map(([k, i, v], n) => {
    const max = Math.max(10, Math.ceil(v * 2.5 / 10) * 10);
    return `<div class="wi-r" data-n="${n}"><span class="wi-l">${k === 'cap' ? CAP[i][0] : `${k === 'res' ? '⛏' : k === 'must' ? '=' : '≥'} ${itemName(i)}`}</span>
      <input type="range" min="0" max="${max}" step="${max > 200 ? 5 : 1}" value="${v}"/><span class="wi-n">${num(v)}</span>
      <button class="bsm" data-use title="${k === 'res' ? 'Make the supply this — through its typed rate' : k === 'cap' ? 'Make the cap this' : 'Make the goal this'}" style="visibility:hidden">Use it</button></div>`;
  }).join(''));
  body.querySelectorAll('.wi-r').forEach(r => {
    const [k, i, v0] = rows[+r.dataset.n], rng = r.querySelector('input'), lbl = r.querySelector('.wi-n'), use = r.querySelector('[data-use]');
    let t = 0;
    rng.addEventListener('input', () => {
      const v = +rng.value;
      lbl.textContent = num(v);
      use.style.visibility = Math.abs(v - v0) > 1e-6 ? 'visible' : 'hidden';
      const set = k === 'res' ? { resources: { [i]: v } } : k === 'cap' ? { caps: { [i]: v } } : { [k]: { [i]: v } };
      clearTimeout(t); t = setTimeout(() => ask(set, `${nameOf(k, i)} at ${num(v)}${k === 'cap' ? CAP[i][2] : ''}:`), 40);
    });
    use.addEventListener('click', () => {
      const v = +rng.value;
      if (k === 'cap') {
        const inp = document.getElementById(CAP[i][1]);
        inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (k === 'res') {
        if (!setSupplyTotal(i, v)) { use.textContent = 'from nodes — add some above'; return; }
        document.dispatchEvent(new Event('supply-changed'));
      } else {
        setGoal(i, { ...goalOf(i), [k]: v });
        document.dispatchEvent(new Event('goals-changed'));
      }
      document.getElementById('bsolve')?.click();
    });
  });
}
