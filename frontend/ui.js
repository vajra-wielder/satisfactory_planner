/**
 * ui.js — transient UI panels: results bar, build cost, warnings modal, saved scenarios.
 * Extracted from sidebar.js so sidebar.js only handles sidebar concerns.
 */

import { RESULT, RECIPES, itemName, perMin } from './state.js';
import { gainText } from './new-alts.js';
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
  const st  = (label, val, color = 'var(--acc)', title = '') =>
    `<div class="rbs"${title ? ` title="${title}"` : ''}><div class="rbv" style="color:${color}">${val}</div><div class="rbl">${label}</div></div>`;
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
    h += st(itemName(k), perMin(k, v, 1, true), 'var(--ok)');
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

  // New alternates worth unlocking: a click away (the sidebar's list)
  const sg = RESULT.suggest;
  if (sg?.steps?.length) {
    const g = sg.all || {};
    const val = g.output > 0.1 ? `+${g.output >= 10 ? g.output.toFixed(0) : g.output.toFixed(1)}%`
      : g.resources > 0.1 ? `−${g.resources.toFixed(0)}%` : `−${Math.round(g.machines || 0)} u`;
    h = `<div class="rbs rb-link" id="rb-na" title="${sg.steps.length} alternates you haven't unlocked would help: ${
      gainText(g, false)} — click to see them"><div class="rbv" style="color:#34d399">${val}</div><div class="rbl">${sg.steps.length} new alts</div></div>` + sep + h;
  }
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

  const key = JSON.stringify([pick.map(f => f.key), machines, extractors, mats, shards, sloops, others.map(f => [f.key, f.solved])]);
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
    <button class="bsm" id="bc-copy" style="float:right">Copy as a list</button>
    <div class="bc-h">Machines${many ? ` · ${pick.length} factories` : ''}</div>${rows(machines, machName)}
    ${extractors.length ? `<div class="bc-h">Extractors</div>${rows(extractors, machName, '⛏ ')}` : ''}
    <div class="bc-h">Materials to build them</div>${rows(mats, itemName)}
    ${shards ? `<div class="bcr"><span style="color:#3b82f6">💎 Power Shards</span><span style="color:#3b82f6">×${shards}</span></div>` : ''}
    ${sloops ? `<div class="bcr"><span style="color:#a855f7">🔮 Somersloops</span><span style="color:#a855f7">×${sloops}</span></div>` : ''}
    <p class="n-hint" style="margin-top:8px">Belts, pipes, splitters, stations and foundations aren't counted.</p>`}`;
  body.querySelectorAll('.bc-add input').forEach(c => c.addEventListener('change', () => {
    c.checked ? BL_PICK.add(c.dataset.key) : BL_PICK.delete(c.dataset.key);
    renderBuildCost();
  }));
  body.querySelector('#bc-copy')?.addEventListener('click', e => {
    const lines = [`Build list: ${pick.map(f => f.name).join(', ')}`, '', 'Machines',
      ...[...machines, ...extractors].map(([k, x]) => `  ${machName(k)} ×${fmtN(x.total)}`),
      ...(shards ? [`  Power Shards ×${shards}`] : []), ...(sloops ? [`  Somersloops ×${sloops}`] : []),
      '', 'Materials', ...mats.map(([k, x]) => `  ${itemName(k)} ×${fmtN(x.total)}`)];
    navigator.clipboard?.writeText(lines.join('\n')).then(() => { e.target.textContent = 'Copied'; });
  });
}

// ══════════════════════════════════════════════════════════
// SAVED SCENARIOS TAB
// ══════════════════════════════════════════════════════════
export function renderSaved(saved, onLoad, onDelete, onRestore) {
  const el = document.getElementById('savedlist');
  if (!saved.length) { el.innerHTML = '<p style="font-size:12px;color:var(--t3)">No saved scenarios.</p>'; el.appendChild(backupBox()); return; }
  el.innerHTML = '';
  const stale = saved.filter(s => !s.fresh).length;
  const bar = document.createElement('div');
  bar.className = 'sv-bar';
  bar.innerHTML = `<button class="bsm ${stale ? 'act' : ''}" id="sv-chain" ${stale ? '' : 'disabled'}
      title="Solve every factory without a current plan, and everything that takes from them — sources first">↻ Re-solve out of date (${stale})</button>`;
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
          <div style="font-size:12px;color:var(--t)">${s.fresh ? '' : '<span class="sv-stale" title="No current plan — solve it, or re-solve out of date">●</span> '}${s.name}${s.alerts?.length ? ` <span class="sv-alert" title="${
            s.alerts.map(a => `${a.item.replace(/_/g, ' ')}${a.storage ? ' to storage' : ` from ${a.factory_name || a.factory}`}: ${a.rate}/min asked, ${a.left}/min left — its source changed`).join('\n')}">⚠ ${s.alerts.length}</span>` : ''}</div>
          <div style="font-size:10px;color:var(--t3);margin-top:1px">${(s.resources||[]).slice(0,3).map(r => r.replace(/_/g, ' ')).join(', ')}</div>
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
