/**
 * new-alts.js — the Alternates tab: alternates worth unlocking, and how the
 * solver pruned the recipes.
 *
 * After each solve the server works out the best plan with every alternate
 * you haven't unlocked (solver.suggest_alts) and lists the ones it uses, in
 * the order to unlock them: each with what it adds on top of those above —
 * output, resources for the same output, machine space. Tick the ones to use
 * in this factory, untick the ones you don't want, then Solve — or unlock the
 * ticked ones (you found their hard drives): then every factory has them.
 */
import { SC, RESULT, RECIPES, mCol, MABBR, UNLOCKED_ALTS, setUnlockedAlts as setStateAlts } from './state.js';
import { setUnlockedAlts } from './machines-panel.js';
import { saveUnlockedAlts } from './api.js';
import { setBadge } from './dock.js';

const $ = id => document.getElementById(id);
const name = k => (RECIPES[k]?.display || k).replace(/^Alternate:\s*/i, '');
const pct = v => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;

// What a set of gains says, shortest first: "+41% output · −33% resources · −13 space"
export function gainText(g, html = true) {
  if (!g) return '';
  const span = (t, c) => (html ? `<span style="color:${c}">${t}</span>` : t);
  return [g.output > 0.1 ? span(`+${pct(g.output)} output`, 'var(--ok)') : '',
          g.resources > 0.1 ? span(`−${pct(g.resources)} resources`, 'var(--ok)') : '',
          g.machines > 0.5 ? span(`−${Math.round(g.machines)} space`, '#60a5fa') : '']
    .filter(Boolean).join(html ? '<span class="na-dot"> · </span>' : ' · ');
}

let seq = 0;
/** Ask for the last solve's suggestions, then draw them. */
export function refreshNewAlts(onChange) {
  const el = $('new-alts');
  if (!el) return;
  const res = RESULT;
  if (!res?.status?.startsWith('Optimal')) {
    el.innerHTML = '<div class="na-head"><b>New alternates</b></div><p class="n-hint">After a solve: the alternates you haven\'t unlocked that would make it better.</p>';
    setBadge('dkb-alts', '');
    drawPrune();
    return;
  }
  drawPrune();
  if (res.suggest) { draw(onChange); return; }
  const mine = ++seq;
  el.innerHTML = '<div class="na-head"><b>New alternates</b><span class="n-hint">checking…</span></div>';
  fetch('/api/suggest-alts').then(r => r.json()).then(d => {
    if (mine !== seq || res !== RESULT) return;      // a newer solve took over
    res.suggest = d;
    draw(onChange);
    document.dispatchEvent(new Event('suggest-ready'));
  }).catch(() => { el.innerHTML = ''; });
}

function draw(onChange) {
  const el = $('new-alts'), d = RESULT?.suggest;
  if (!el || !d) return;
  setBadge('dkb-alts', d.steps?.length ? String(d.steps.length) : '', 'ok');
  const on = new Set(SC.alternate_recipes_enabled || []);
  const listed = new Set((d.steps || []).map(s => s.key));
  // on here, but neither suggested nor unlocked: still in the plan's recipes, so you can untick it
  const extra = [...on].filter(k => RECIPES[k]?.alternate && !listed.has(k) && !UNLOCKED_ALTS.has(k));
  if (!d.steps?.length && !extra.length) {
    el.innerHTML = `<div class="na-head"><b>New alternates</b></div>
      <p class="n-hint">None you haven't unlocked would help this factory — its recipes are as good as they get.</p>`;
    return;
  }
  const ticked = d.steps.filter(s => on.has(s.key));
  const planHas = new Set((RESULT.flows || []).map(f => f.recipe_key));
  const pending = [...d.steps.map(s => s.key), ...extra].some(k => on.has(k) !== planHas.has(k));
  const row = (k, i, gain) => {
    const r = RECIPES[k] || {}, c = mCol(r.machine);
    return `<label class="na-row" title="${name(k)}: tick to use it in this factory">
      <input type="checkbox" data-k="${k}" ${on.has(k) ? 'checked' : ''}/>
      <span class="na-i">${i}</span>
      <span class="na-m" style="background:${c}22;color:${c};border:1px solid ${c}44">${MABBR[r.machine] || r.machine || ''}</span>
      <span class="na-n">${name(k)}<br><span class="na-g">${gain}</span></span>
    </label>`;
  };
  el.innerHTML = `
    <div class="na-head"><b>New alternates</b><span class="n-hint">${ticked.length}/${d.steps.length} on here</span></div>
    ${d.steps.length ? `<p class="n-hint" style="margin:2px 0 6px">The best plan with alternates you haven't unlocked uses these — in the
      order to unlock them, each with what it adds on top of the ones above. With all ${d.steps.length}:
      <b>${gainText(d.all)}</b>.</p>` : ''}
    ${d.steps.map((s, i) => row(s.key, i + 1, gainText(s) || '<span class="n-hint">rounds out the set</span>')).join('')}
    ${extra.map(k => row(k, '·', '<span class="n-hint">on here — the best plan doesn\'t use it</span>')).join('')}
    <div class="na-btns">
      ${d.steps.length ? `<button class="bsm" id="na-all">${ticked.length === d.steps.length ? 'Untick all' : 'Tick all'}</button>` : ''}
      <button class="bsm" id="na-unlock" ${ticked.length ? '' : 'disabled'}
        title="You've found their hard drives: unlock the ticked ones for every factory">🔓 Unlock ticked${ticked.length ? ` (${ticked.length})` : ''}</button>
      <button class="bsm ${pending ? 'act' : ''}" id="na-solve" ${pending ? '' : 'disabled'}
        title="${pending ? 'Solve with the ticked ones' : 'The plan already has these'}">${pending ? '▶ Solve with these' : 'Plan is up to date'}</button>
    </div>`;
  const set = (keys, yes) => {
    const s = new Set(SC.alternate_recipes_enabled || []);
    keys.forEach(k => (yes ? s.add(k) : s.delete(k)));
    SC.alternate_recipes_enabled = [...s];
    onChange?.();
    draw(onChange);
  };
  el.querySelectorAll('input[data-k]').forEach(b => b.addEventListener('change', () => set([b.dataset.k], b.checked)));
  $('na-all')?.addEventListener('click', () => set(d.steps.map(s => s.key), ticked.length !== d.steps.length));
  $('na-solve').addEventListener('click', () => $('bsolve').click());
  $('na-unlock').addEventListener('click', async e => {
    const keys = [...new Set([...UNLOCKED_ALTS, ...ticked.map(s => s.key)])];
    e.target.disabled = true; e.target.textContent = 'Unlocking…';
    try {
      await saveUnlockedAlts(keys);
      setStateAlts(keys); setUnlockedAlts(keys);
      document.dispatchEvent(new Event('unlocks-changed'));
      $('bsolve').click();                 // with them unlocked: the plan, and what's left to suggest
    } catch (err) { e.target.textContent = 'Failed — retry'; e.target.disabled = false; }
  });
}


// How the solver narrowed the recipes down before solving: each step and what's left
function drawPrune() {
  const el = $('prune-box');
  if (!el) return;
  const p = RESULT?.prune, n = RESULT?.pruned_recipe_count;
  if (!RESULT || (!p?.total && !n)) {
    el.innerHTML = '<div class="na-head"><b style="color:var(--t2)">Solver pruning</b></div><p class="n-hint">After a solve: how far the recipes were narrowed down before solving.</p>';
    return;
  }
  const inPlan = new Set((RESULT.flows || []).map(f => f.recipe_key)).size;
  const steps = p?.total ? [
    ['Every recipe in the game', p.total, ''],
    ['Allowed by your unlocks', p.allowed, 'machines, and alternates unlocked or on here'],
    ['Makeable from your resources', p.fireable, 'forward: every input can be had'],
    ['On a path to your goals', p.needed, 'backward: an output something needs'],
    ['Into the solver', p.usable, 'pointless loops (pack ⇄ unpack) dropped'],
    ['In the plan', inPlan, 'what the optimum uses'],
  ] : [['Into the solver', n, ''], ['In the plan', inPlan, '']];
  const top = steps[0][1] || 1;
  const cut = p?.total ? 100 * (1 - p.usable / p.total) : null;
  el.innerHTML = `
    <div class="na-head"><b style="color:var(--t2)">Solver pruning</b><span class="n-hint">${
      [cut != null ? `${cut.toFixed(0)}% cut before solving` : '', RESULT.solve_s != null ? `solved in ${RESULT.solve_s < 1 ? `${Math.round(RESULT.solve_s * 1000)} ms` : `${RESULT.solve_s.toFixed(1)} s`}` : '']
      .filter(Boolean).join(' · ')}</span></div>
    ${steps.map(([label, v, how], i) => `<div class="pr-row" title="${how}">
      <span class="pr-l">${label}</span><span class="pr-v">${v}</span>
      <div class="pr-bar"><i style="width:${(100 * v / top).toFixed(1)}%;${i === steps.length - 1 ? 'background:#34d399' : ''}"></i></div></div>`).join('')}
    <p class="n-hint" style="margin-top:4px">${p?.total ? 'Hover a step for what it drops. ' : 'Solve again for every step. '}New-alternate suggestions are pruned the same way.</p>`;
}
