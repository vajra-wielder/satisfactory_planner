/**
 * recipe-lookup.js — topbar recipe lookup floating panel.
 * Extracted from sidebar.js for maintainability.
 */

import { ALL_ITEMS, RECIPES, mCol, MABBR, itemName } from './state.js';
import { makeAC } from './sidebar.js';

let rlPanel = null;

export function initRecipeLookup() {
  const inp = document.getElementById('tb-rl-input');
  if (!inp) return;

  rlPanel = document.getElementById('tb-rl-panel');

  makeAC(inp, key => {
    inp.value = itemName(key);
    showRecipeLookup(key, rlPanel);
    rlPanel.style.display = 'flex';
  });

  // Memoize last query so repeated identical keystrokes skip re-scanning ALL_ITEMS
  let _rlLastRaw = null, _rlLastFound = null;
  inp.addEventListener('input', () => {
    const raw = inp.value.trim();
    if (!raw) { rlPanel.style.display = 'none'; _rlLastRaw = null; return; }
    if (raw === _rlLastRaw) return;   // same text — nothing to do
    _rlLastRaw = raw;
    const ql    = raw.toLowerCase();
    const found = ALL_ITEMS.find(k =>
      itemName(k).toLowerCase() === ql ||
      k.toLowerCase() === ql.replace(/\s+/g, '_'));
    if (found === _rlLastFound) return;  // same item — skip re-render
    _rlLastFound = found;
    if (found) {
      showRecipeLookup(found, rlPanel);
      rlPanel.style.display = 'flex';
    }
  });

  inp.addEventListener('focus', () => {
    if (inp.value.trim()) rlPanel.style.display = 'flex';
  });

  // Close on Escape or when input is cleared via keyboard
  inp.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      rlPanel.style.display = 'none';
      inp.blur();
    }
  });

  // Close when clicking anywhere outside the recipe-lookup wrapper.
  // This is the critical fix: without it the open panel (z-index 500, up to 70vh tall)
  // silently swallows every click on the canvas/sidebar below it, making the whole
  // app appear unresponsive after a lookup.
  const wrap = document.getElementById('tb-rl-wrap');
  document.addEventListener('mousedown', e => {
    if (rlPanel.style.display !== 'none' && !wrap.contains(e.target)) {
      rlPanel.style.display = 'none';
    }
  }, true);   // capture phase so it fires before any stopPropagation inside the app
}

function showRecipeLookup(item, container) {
  const el = container.querySelector('#tb-rl-results');
  el.innerHTML = '';
  const produces = [], consumes = [];
  Object.entries(RECIPES).forEach(([key, r]) => {
    if (r.outputs[item])     produces.push({ key, r });
    else if (r.inputs[item]) consumes.push({ key, r });
  });

  if (!produces.length && !consumes.length) {
    el.innerHTML = `<p style="font-size:11px;color:var(--t3);padding:4px">No recipes for <b>${itemName(item)}</b>.</p>`;
    return;
  }

  function recipeCard(key, r, role) {
    const color     = mCol(r.machine);
    const cleanDisp = r.display.replace(/^Alternate:\s*/i, '').replace(/\s*\(Alt\)/, '');
    const rate      = role === 'prod' ? (r.outputs[item] || 0) : (r.inputs[item] || 0);
    const card      = document.createElement('div');
    card.className  = 'rlcard ' + (role === 'prod' ? 'prod' : 'cons');

    let ioHTML = '';
    Object.entries(r.inputs ).forEach(([k, v]) => { ioHTML += `<div class="rlrow"><span>← ${itemName(k)}</span><span>${v}/min</span></div>`; });
    ioHTML += '<div style="border-top:1px solid var(--b);margin:3px 0"></div>';
    Object.entries(r.outputs).forEach(([k, v]) => { ioHTML += `<div class="rlrow"><span style="color:var(--ok)">→ ${itemName(k)}</span><span>${v}/min</span></div>`; });

    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:5px;margin-bottom:4px;flex-wrap:wrap">
        <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:${color}22;color:${color};border:1px solid ${color}44;font-family:var(--mono);font-weight:600">${MABBR[r.machine] || r.machine}</span>
        ${r.alternate ? '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:var(--acc-glow);color:var(--acc);border:1px solid var(--acc)">ALT</span>' : ''}
        <span class="rlrname">${cleanDisp}</span>
        <span style="margin-left:auto;font-size:10px;color:${role === 'prod' ? 'var(--ok)' : '#3b82f6'}">${role === 'prod' ? 'produces' : 'consumes'} ${Number(rate).toFixed(2)}/min</span>
      </div>
      ${ioHTML}
    `;

    el.appendChild(card);
  }

  if (produces.length) {
    const hd = document.createElement('div');
    hd.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--ok);margin-bottom:4px;margin-top:2px';
    hd.textContent = `Produced by (${produces.length})`;
    el.appendChild(hd);
    produces.forEach(({ key, r }) => recipeCard(key, r, 'prod'));
  }
  if (consumes.length) {
    const hd = document.createElement('div');
    hd.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#3b82f6;margin-bottom:4px;margin-top:6px';
    hd.textContent = `Used in (${consumes.length})`;
    el.appendChild(hd);
    consumes.forEach(({ key, r }) => recipeCard(key, r, 'cons'));
  }
}
