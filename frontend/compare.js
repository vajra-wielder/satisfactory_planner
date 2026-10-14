/**
 * compare.js — pin a plan, change something, see the difference.
 *
 * 📌 on the results bar keeps the plan on screen (and the factory's inputs
 * behind it). Every solve after shows, under each number, how it moved from
 * the pinned one — green better, amber worse — and Compare lays the two side
 * by side: goals, power, machines, space, each resource drawn, the machines
 * by kind and the recipes only one of them runs. "Back to the pinned" puts
 * the pinned inputs back (an undoable edit) and solves them.
 */
import { RESULT, SC, itemName, RECIPES } from './state.js';
import { openSplit } from './build-sheet.js';

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
