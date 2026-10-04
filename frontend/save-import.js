/**
 * save-import.js — read a game save: the nodes it mines (marked on the maps)
 * and what it has unlocked. The unlocks are shown against the planner's own
 * (alternates, machines, miner, belt, pipe); one click makes them match.
 */

import { PROGRESS, setUnlockedAlts as setStateAlts, itemName, RECIPES } from './state.js';
import { setUnlockedAlts, renderMachines, updMachBadge } from './machines-panel.js';

const name = k => (RECIPES[k]?.display || k.replace(/_/g, ' ')).replace(/^Alternate:\s*/, '');
const tier = t => t.replace('Mk', 'Mk.');

/** POST the .sav; resolves to {file, nodes, unlocks, changes}. */
export function uploadSave(file) {
  return fetch('/api/save-file', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': file.name }, body: file })
    .then(r => r.json()).then(d => { if (d.error) throw new Error(d.error); document.dispatchEvent(new CustomEvent('save-read', { detail: d })); return d; });
}

/** How the save's unlocks differ from the planner's, with the button that matches them. */
export function changesHTML(d) {
  const c = d?.changes || {};
  if (!d?.unlocks) return '';
  const rows = [];
  ['miner', 'belt', 'pipe'].forEach(k => {
    if (c[k]) rows.push(`${k[0].toUpperCase() + k.slice(1)} ${tier(c[k][0])} → <b>${tier(c[k][1])}</b>`);
  });
  if (c.machines?.add.length) rows.push(`+ ${c.machines.add.map(m => m.replace(/_/g, ' ')).join(', ')}`);
  if (c.machines?.drop.length) rows.push(`− ${c.machines.drop.map(m => m.replace(/_/g, ' ')).join(', ')} <span class="n-hint">(not unlocked in the save)</span>`);
  if (c.alts?.add.length) rows.push(`+ ${c.alts.add.length} alternate${c.alts.add.length > 1 ? 's' : ''}: ${c.alts.add.map(name).join(', ')}`);
  if (c.alts?.drop.length) rows.push(`− ${c.alts.drop.length} alternate${c.alts.drop.length > 1 ? 's' : ''} not in the save: ${c.alts.drop.map(name).join(', ')}`);
  if (!rows.length) return `<div class="sv-unl">Your unlocks match ${d.file || 'the save'}.</div>`;
  return `<div class="sv-unl"><div class="n-sent-t">${d.file || 'Your save'} has unlocked differently</div>
    ${rows.map(r => `<div>${r}</div>`).join('')}
    <button class="bsm act sv-unl-go">Use the save's unlocks</button>
    <span class="n-hint">Every factory's supply and plan follow; re-solve them after.</span></div>`;
}

/** Make the planner's shared unlocks match the save; re-render what shows them. */
export function applySaveUnlocks() {
  return fetch('/api/save-unlocks', { method: 'POST' }).then(r => r.json()).then(d => {
    if (d.error) throw new Error(d.error);
    Object.assign(PROGRESS, d.progress);
    setUnlockedAlts(d.unlocked); setStateAlts(d.unlocked);
    renderMachines(); updMachBadge();
    document.dispatchEvent(new CustomEvent('progress-changed'));
    return d;
  });
}

// Wire a container holding changesHTML (re-rendered by `refresh` after applying)
export function wireChanges(el, refresh) {
  el.querySelector('.sv-unl-go')?.addEventListener('click', () => applySaveUnlocks().then(refresh));
}
