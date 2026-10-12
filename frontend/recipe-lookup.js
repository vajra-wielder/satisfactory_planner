/**
 * recipe-lookup.js — Recipes: a window in the middle of the screen (Ctrl+Q,
 * or the box in the top bar) for looking things up without leaving the plan.
 *
 * Type an item and every recipe that makes it and uses it shows at once, in
 * columns. Click any item on a card to look that one up — the trail above
 * goes back. Set a rate ("at 120/min") and each card says how many machines
 * that takes and how much of each part; looking up a part from there carries
 * the rate down with it. A sum on its own (240*2/3) is worked out, and can
 * become the rate.
 */

import { ALL_ITEMS, RECIPES, mCol, MABBR, itemName, UNLOCKED_ALTS, PROGRESS, SC } from './state.js';
import { evalExpr } from './kv-panel.js';

const $ = id => document.getElementById(id);
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = v => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : +v.toFixed(v < 10 ? 3 : 2)).toLocaleString();
const isSum = t => /[\d)]\s*[-+*/%]\s*[\d(.]|^\(/.test(t) && evalExpr(t) !== null;

let ITEM = null, RATE = null, TRAIL = [], PICK = 0;

export function initRecipeLookup() {
  $('tb-rl-open')?.addEventListener('click', () => openRecipes());
  const q = $('rl-q'), rate = $('rl-rate');
  q.addEventListener('input', () => { PICK = 0; draw(); });
  q.addEventListener('keydown', e => {
    const opts = [...$('rl-body').querySelectorAll('.rl-opt')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!opts.length) return;
      e.preventDefault();
      PICK = (PICK + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((o, i) => o.classList.toggle('on', i === PICK));
      opts[PICK].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (isSum(q.value)) { useAsRate(); return; }
      const o = opts[PICK] || opts[0];
      if (o) go(o.dataset.item);
    } else if (e.key === 'Escape') { e.preventDefault(); closeRecipes(); }
    else if (e.key === 'Backspace' && !q.value && TRAIL.length) { e.preventDefault(); back(); }
  });
  rate.addEventListener('change', () => {
    const v = evalExpr(rate.value);
    RATE = v > 0 ? v : null;
    rate.value = RATE ? num(RATE) : '';
    draw();
  });
  rate.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); rate.blur(); q.focus(); }
    if (e.key === 'Escape') { e.preventDefault(); closeRecipes(); }
  });
  $('rl-x').addEventListener('click', closeRecipes);
  $('rl-modal').addEventListener('mousedown', e => { if (e.target.id === 'rl-modal') closeRecipes(); });
  // a click on any item, anywhere in the window, looks it up
  $('rl-box').addEventListener('click', e => {
    const a = e.target.closest('[data-item]');
    if (a) { go(a.dataset.item, a.dataset.rate ? +a.dataset.rate : undefined); return; }
    const t = e.target.closest('[data-trail]');
    if (t) back(+t.dataset.trail);
    if (e.target.closest('#rl-use')) useAsRate();
    if (e.target.closest('#rl-norate')) { RATE = null; $('rl-rate').value = ''; draw(); }
  });
}

/** Open the window — on an item, if given. */
export function openRecipes(item) {
  document.querySelectorAll('.far.show').forEach(f => f.classList.remove('show'));
  $('rl-modal').classList.add('show');
  if (item) go(item); else draw();
  const q = $('rl-q');
  q.focus(); q.select();
}
export function closeRecipes() { $('rl-modal').classList.remove('show'); document.activeElement?.closest?.('#rl-modal') && document.activeElement.blur(); }

// Look an item up; rate: what's needed of it (from the card it was clicked on)
function go(item, rate) {
  if (ITEM && ITEM !== item) TRAIL.push({ item: ITEM, rate: RATE });
  if (TRAIL.length > 12) TRAIL.shift();
  ITEM = item;
  if (rate !== undefined) RATE = rate > 0 ? rate : null;
  $('rl-q').value = '';
  $('rl-rate').value = RATE ? num(RATE) : '';
  PICK = 0;
  draw();
  $('rl-body').scrollTop = 0;
}
function back(i = TRAIL.length - 1) {
  const t = TRAIL[i];
  if (!t) return;
  TRAIL = TRAIL.slice(0, i);
  ITEM = t.item; RATE = t.rate;
  $('rl-rate').value = RATE ? num(RATE) : '';
  draw();
}
function useAsRate() {
  const v = evalExpr($('rl-q').value);
  if (!(v > 0)) return;
  RATE = v; $('rl-rate').value = num(v); $('rl-q').value = '';
  draw();
}

// Items whose name has the words typed, those starting with them first
function matches(t) {
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return ALL_ITEMS.map(k => ({ k, n: itemName(k).toLowerCase() }))
    .filter(x => words.every(w => x.n.includes(w)))
    .sort((a, b) => (b.n.startsWith(words[0]) - a.n.startsWith(words[0])) || a.n.length - b.n.length)
    .slice(0, 60).map(x => x.k);
}

function draw() {
  const body = $('rl-body'), t = $('rl-q').value.trim();
  $('rl-trail').innerHTML = [...TRAIL.map((x, i) => `<button class="rl-crumb" data-trail="${i}">${esc(itemName(x.item))}${x.rate ? ` <small>${num(x.rate)}/min</small>` : ''}</button><span class="rl-sep">›</span>`),
    ITEM ? `<b class="rl-crumb now">${esc(itemName(ITEM))}${RATE ? ` <small>${num(RATE)}/min</small>` : ''}</b>` : ''].join('');
  // a sum: its answer, which can be the rate
  if (t && isSum(t)) {
    const v = evalExpr(t);
    body.innerHTML = `<div class="rl-sum"><span class="rl-sum-q">${esc(t)} =</span><span class="rl-sum-v">${num(v)}</span>
      ${v > 0 ? `<button class="bsm act" id="rl-use" title="Enter">Use as the rate${ITEM ? ` for ${esc(itemName(ITEM))}` : ''}</button>` : ''}</div>`;
    return;
  }
  if (t) {
    const ks = matches(t);
    body.innerHTML = ks.length ? `<div class="rl-opts">${ks.map((k, i) => {
      const made = Object.values(RECIPES).filter(r => r.outputs[k]).length, used = Object.values(RECIPES).filter(r => r.inputs[k]).length;
      return `<button class="rl-opt ${i === PICK ? 'on' : ''}" data-item="${k}"><b>${esc(itemName(k))}</b><small>${made} make it · ${used} use it</small></button>`;
    }).join('')}</div>` : `<p class="n-hint">No item called “${esc(t)}”. A sum like <code>240*2/3</code> works too.</p>`;
    return;
  }
  if (!ITEM) {
    body.innerHTML = `<div class="rl-empty"><p>Type an item — every recipe that makes it and uses it shows here. Click a part on any card to look that one up.</p>
      <p>Set a rate and each card says how many machines that takes. Sums work in both boxes: <code>240*2+120</code>.</p></div>`;
    return;
  }
  const makes = [], uses = [];
  Object.entries(RECIPES).forEach(([k, r]) => { if (r.outputs[ITEM]) makes.push([k, r]); else if (r.inputs[ITEM]) uses.push([k, r]); });
  const rank = ([k, r]) => (r.alternate ? (UNLOCKED_ALTS.has(k) || (SC.alternate_recipes_enabled || []).includes(k) ? 1 : 2) : 0);
  makes.sort((a, b) => rank(a) - rank(b) || a[1].display.localeCompare(b[1].display));
  uses.sort((a, b) => a[1].display.localeCompare(b[1].display));
  const col = (title, list, role) => list.length ? `<div class="rl-col">
      <div class="rl-h ${role}">${title} <span>${list.length}</span></div>
      <div class="rl-grid">${list.map(([k, r]) => card(k, r, role)).join('')}</div></div>` : '';
  body.innerHTML = (col('Made by', makes, 'prod') + col('Used in', uses, 'cons'))
    || `<p class="n-hint">No recipe makes or uses ${esc(itemName(ITEM))} — it's mined, or found.</p>`;
}

function card(k, r, role) {
  const c = mCol(r.machine);
  const name = r.display.replace(/^Alternate:\s*/i, '').replace(/\s*\(Alt\)/, '');
  const per = role === 'prod' ? r.outputs[ITEM] : r.inputs[ITEM];
  const n = RATE && per ? RATE / per : null;            // machines at 100% for the rate
  const locked = r.alternate && !UNLOCKED_ALTS.has(k) && !(SC.alternate_recipes_enabled || []).includes(k);
  const noMachine = PROGRESS.machines && !PROGRESS.machines.includes(r.machine);
  const io = (items, dir) => Object.entries(items).map(([it, v]) => {
    const amt = n ? v * n : v;
    return `<a class="rl-io ${dir} ${it === ITEM ? 'me' : ''}" data-item="${it}" ${n ? `data-rate="${amt}"` : ''}
      title="Look up ${esc(itemName(it))}${n ? ` at ${num(amt)}/min` : ''}"><span>${dir === 'in' ? '←' : '→'} ${esc(itemName(it))}</span><span>${num(amt)}/min</span></a>`;
  }).join('');
  return `<div class="rl-card ${role} ${locked || noMachine ? 'dim' : ''}">
    <div class="rl-ch">
      <span class="rl-m" style="background:${c}22;color:${c};border:1px solid ${c}44">${MABBR[r.machine] || r.machine}</span>
      ${r.alternate ? `<span class="rl-alt ${locked ? 'lk' : ''}" title="${locked ? 'Not unlocked' : 'Unlocked'}">${locked ? '🔒 ALT' : 'ALT'}</span>` : ''}
      <span class="rl-n" title="${esc(r.display)}">${esc(name)}</span>
      ${n ? `<span class="rl-k" title="Machines at 100% for ${num(RATE)}/min">×${num(n)}</span>` : ''}
    </div>
    ${io(r.inputs, 'in')}<div class="rl-div"></div>${io(r.outputs, 'out')}
    ${noMachine ? `<div class="rl-note">${esc(r.machine.replace(/_/g, ' '))} isn't unlocked</div>` : ''}
  </div>`;
}
