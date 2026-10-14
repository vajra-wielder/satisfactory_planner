/**
 * ui.js — transient UI panels: results bar, build cost, warnings modal, saved scenarios.
 * Extracted from sidebar.js so sidebar.js only handles sidebar concerns.
 */

import { linesHTML, linesText, wireLines, openSplit } from './build-sheet.js';
import { itemColor } from './bundles.js';
import { pinned, delta, pinPlan, unpin, openCompare } from './compare.js';
import { RESULT, RECIPES, itemName, perMin, PROGRESS, MINER_TIERS, FLUIDS } from './state.js';
const TIERS = ['Mk1', 'Mk2', 'Mk3'];
import { openDock, setBadge } from './dock.js';

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
export function setBuildSelf(key, name) { BC_SELF = key; BC_NAME = name || ''; }
export function toggleBC() { openDock('build'); }
const machName = m => m.replace(/_/g, ' ').replace(/Mk(\d)/, 'Mk.$1');
const fmtN = v => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : +v.toFixed(2)).toLocaleString();

/** Redraw; fresh=true also re-reads the saved factories (when the tab opens). */
export function renderBuildCost(fresh = false) {
  const body = document.getElementById('bcb');
  if (fresh || (!BL && !BL_ASKED)) {
    BL_ASKED = true;
    fetch('/api/build-list').then(r => r.json()).then(d => { BL = d.factories || []; renderBuildCost(); }).catch(() => {});
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
  const shards = pick.reduce((t, f) => t + (f.shards || 0), 0), sloops = pick.reduce((t, f) => t + (f.sloops || 0), 0);
  setBadge('bcc', self.solved ? String(machines.length + extractors.length) : '');

  const key = JSON.stringify([pick.map(f => f.key), machines, extractors, mats, shards, sloops, others.map(f => [f.key, f.solved]),
    (RESULT?.flows || []).map(f => [f.recipe_key, f.machines_final, f.clock_pct, f.inputs])]);
  if (key === _bcLastKey) return;
  _bcLastKey = key;

  const many = pick.length > 1;
  const rows = (list, name, icon = '') => list.map(([k, x]) =>
    `<div class="bcr" ${many ? `title="${x.by.join(' · ')}"` : ''}><span>${icon}${name(k)}</span><span>×${fmtN(x.total)}</span></div>`).join('');
  const chips = others.length ? `<div class="bc-add"><span class="n-hint">Add:</span>${others.map(f =>
    `<label title="${f.solved ? (f.stale ? 'Its last plan — it changed since' : 'Add its build to this list') : 'Not solved: nothing to count yet'}">
      <input type="checkbox" data-key="${f.key}" ${BL_PICK.has(f.key) ? 'checked' : ''} ${f.solved ? '' : 'disabled'}/>${f.name}${f.stale ? '*' : ''}</label>`).join('')}</div>` : '';
  const empty = !machines.length && !extractors.length && !mats.length && !shards && !sloops;
  body.innerHTML = `${chips}
    ${empty ? '<p class="n-hint">Solve to see the machines and materials to have ready.</p>' : `
    <div class="bc-h bc-top"><span>Machines${many ? ` · ${pick.length} factories` : ''}</span><button class="bsm" id="bc-copy">Copy as a list</button></div>
    ${rows(machines, machName)}${rows(extractors, machName, '⛏ ')}
    ${many && shards ? `<div class="bcr"><span style="color:#3b82f6">💎 Power Shards</span><span style="color:#3b82f6">×${shards}</span></div>` : ''}
    ${many && sloops ? `<div class="bcr"><span style="color:#a855f7">🔮 Somersloops</span><span style="color:#a855f7">×${sloops}</span></div>` : ''}
    <div class="bc-h">Materials to build them</div>${rows(mats, itemName)}
    ${self.solved ? `<div id="bc-lines">${linesHTML()}</div>` : ''}`}`;
  if (self.solved) wireLines(body);
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
