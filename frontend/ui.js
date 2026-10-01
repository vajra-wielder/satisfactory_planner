/**
 * ui.js — transient UI panels: results bar, build cost, warnings modal, saved scenarios.
 * Extracted from sidebar.js so sidebar.js only handles sidebar concerns.
 */

import { RESULT, itemName } from './state.js';

// ══════════════════════════════════════════════════════════
// WARNINGS MODAL
// ══════════════════════════════════════════════════════════
export function openWarn() {
  if (!RESULT) return;
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
  document.getElementById('wmtit').textContent = `Solve Issues — ${items.length}`;
  const list = document.getElementById('wmit-list'); list.innerHTML = '';
  items.forEach(({ t, txt }) => {
    const d = document.createElement('div'); d.className = 'wmit';
    d.style.cssText = `border:1px solid ${COL[t]};background:${BG[t]};color:${COL[t]}`;
    d.innerHTML = `<span style="flex-shrink:0">${ICO[t]}</span><span>${txt}</span>`;
    list.appendChild(d);
  });
  document.getElementById('wo').classList.add('show');
}
export function closeWarn() { document.getElementById('wo').classList.remove('show'); }

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
  const st  = (label, val, color = 'var(--acc)') =>
    `<div class="rbs"><div class="rbv" style="color:${color}">${val}</div><div class="rbl">${label}</div></div>`;
  const sep = '<div class="rbsep"></div>';

  const objItems = Object.entries(RESULT.objective_items || {})
    .filter(([, v]) => v > 0.01)
    .sort(([, a], [, b]) => b - a);

  const consumed = {};
  (RESULT.flows || []).forEach(f =>
    Object.entries(f.inputs || {}).forEach(([item, rate]) => {
      consumed[item] = (consumed[item] || 0) + rate;
    })
  );
  const unlimited  = new Set(RESULT.unlimited_resources || []);
  const resEntries = Object.entries(RESULT.source_nodes || {}).filter(([item]) => !unlimited.has(item));
  const bindingCount = resEntries.filter(([item, avail]) => {
    const used = consumed[item] || 0;
    return avail > 0 && (used / avail) >= 0.99;
  }).length;
  const resLabel = resEntries.length ? `${bindingCount}/${resEntries.length} maxed` : null;

  let h = '';
  objItems.forEach(([k, v], i) => {
    h += st(itemName(k), `${v.toFixed(1)}/m`, 'var(--ok)');
    if (i < objItems.length - 1) h += sep;
  });
  if (objItems.length) h += sep;
  h += st('Machines', RESULT.total_machines) + sep;
  // Room the machines take — what the planner minimises (w×l×h per machine)
  if (RESULT.total_space != null) h += st('Space · smelters', _fmtSpace(RESULT.total_space)) + sep;
  // Net power: negative when generators (nuclear plants) make more than the factory uses
  const pw = RESULT.total_power_mw ?? 0;
  const capMw = RESULT.max_power_mw;
  h += pw < 0 ? st('Power made', `${(-pw).toFixed(0)} MW`, 'var(--ok)')
     : capMw ? st(`Power · ${(100 * pw / capMw).toFixed(1)}% of cap`, `${pw.toFixed(0)} / ${capMw.toFixed(0)} MW`, 'var(--warn)')
             : st('Power', `${pw.toFixed(0)} MW`, 'var(--warn)');
  if (resLabel) h += sep + st('Resources', resLabel, bindingCount > 0 ? 'var(--err)' : 'var(--t3)');
  if (RESULT.shards_used > 0) h += sep + st('Shards', RESULT.shards_used, '#3b82f6');
  if (RESULT.sloops_used > 0) h += sep + st('Sloops', RESULT.sloops_used, '#a855f7');
  // Proven: the goal is at least this share of the best possible plan
  const cert = RESULT.certified_pct;
  if (cert != null && cert < 99.95)
    h += sep + st('Certified', `≥${cert.toFixed(1)}%`, cert >= 95 ? 'var(--ok)' : 'var(--warn)');

  if (h === _rbLastHTML) { rb.style.display = 'flex'; return; }
  _rbLastHTML = h;
  rb.style.display = 'flex';
  rb.innerHTML = h;
}

let bcOpen = false;
let _bcLastKey = null;
export function toggleBC() { bcOpen = !bcOpen; renderBuildCost(); }
export function renderBuildCost() {
  const panel  = document.getElementById('bc');
  const cost   = RESULT?.build_cost ?? {};
  const entries = Object.entries(cost);
  const shards = RESULT?.build_cost_shards ?? 0;
  const sloops = RESULT?.build_cost_sloops ?? 0;
  if (!entries.length && !shards && !sloops) {
    panel.style.display = 'none';
    _bcLastKey = null;
    return;
  }
  panel.style.display = '';
  document.getElementById('bcc').textContent = `${entries.length} items ${bcOpen ? '▲' : '▼'}`;
  const body = document.getElementById('bcb');
  body.style.display = bcOpen ? '' : 'none';
  if (!bcOpen) return;

  const cacheKey = JSON.stringify(cost) + shards + sloops;
  if (cacheKey === _bcLastKey) return;
  _bcLastKey = cacheKey;

  body.innerHTML = '';
  entries.forEach(([item, qty]) => {
    const r = document.createElement('div'); r.className = 'bcr';
    r.innerHTML = `<span>${itemName(item)}</span><span>×${qty}</span>`;
    body.appendChild(r);
  });
  if (shards) { const r = document.createElement('div'); r.className = 'bcr'; r.innerHTML = `<span style="color:#3b82f6">💎 Power Shards</span><span style="color:#3b82f6">×${shards}</span>`; body.appendChild(r); }
  if (sloops) { const r = document.createElement('div'); r.className = 'bcr'; r.innerHTML = `<span style="color:#a855f7">🔮 Somersloops</span><span style="color:#a855f7">×${sloops}</span>`; body.appendChild(r); }
}

// ══════════════════════════════════════════════════════════
// SAVED SCENARIOS TAB
// ══════════════════════════════════════════════════════════
export function renderSaved(saved, onLoad, onDelete) {
  const el = document.getElementById('savedlist');
  if (!saved.length) { el.innerHTML = '<p style="font-size:12px;color:var(--t3)">No saved scenarios.</p>'; return; }
  el.innerHTML = '';
  saved.forEach(s => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:5px;padding:6px 8px;background:var(--p3);border-radius:var(--rsm);border:1px solid var(--b)';
    row.innerHTML = `
      <div style="flex:1">
        <div style="font-size:12px;color:var(--t)">${s.name}</div>
        <div style="font-size:10px;color:var(--t3);margin-top:1px">${(s.resources||[]).slice(0,3).join(', ')}</div>
      </div>
      <button class="bsm">Load</button>
      <button class="bsm dan">✕</button>
    `;
    row.querySelectorAll('button')[0].addEventListener('click', () => onLoad(s.key));
    row.querySelectorAll('button')[1].addEventListener('click', () => onDelete(s.key));
    el.appendChild(row);
  });
}
