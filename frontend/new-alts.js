/**
 * new-alts.js — alternates worth unlocking, under the solve settings.
 *
 * After each solve the server works out the best plan with every alternate
 * you haven't unlocked (solver.suggest_alts) and lists the ones it uses, in
 * the order to unlock them: each with what it adds on top of those above —
 * output, resources for the same output, machine space. Tick the ones to use
 * in this factory, untick the ones you don't want, then Solve.
 */
import { SC, RESULT, RECIPES, mCol, MABBR } from './state.js';
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
    return;
  }
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
  if (!d.steps?.length) {
    el.innerHTML = `<div class="na-head"><b>New alternates</b></div>
      <p class="n-hint">None you haven't unlocked would help this factory — its recipes are as good as they get.</p>`;
    return;
  }
  const on = new Set(SC.alternate_recipes_enabled || []);
  const ticked = d.steps.filter(s => on.has(s.key)).length;
  const planHas = new Set((RESULT.flows || []).map(f => f.recipe_key));
  const pending = d.steps.some(s => on.has(s.key) !== planHas.has(s.key));
  el.innerHTML = `
    <div class="na-head"><b>New alternates</b><span class="n-hint">${ticked}/${d.steps.length} on here</span></div>
    <p class="n-hint" style="margin:2px 0 6px">The best plan with alternates you haven't unlocked uses these — in the
      order to unlock them, each with what it adds on top of the ones above. With all ${d.steps.length}:
      <b>${gainText(d.all)}</b>.</p>
    ${d.steps.map((s, i) => {
      const r = RECIPES[s.key] || {}, c = mCol(r.machine);
      return `<label class="na-row" title="${name(s.key)}: tick to use it in this factory">
        <input type="checkbox" data-k="${s.key}" ${on.has(s.key) ? 'checked' : ''}/>
        <span class="na-i">${i + 1}</span>
        <span class="na-m" style="background:${c}22;color:${c};border:1px solid ${c}44">${MABBR[r.machine] || r.machine || ''}</span>
        <span class="na-n">${name(s.key)}<br><span class="na-g">${gainText(s) || '<span class="n-hint">rounds out the set</span>'}</span></span>
      </label>`;
    }).join('')}
    <div class="na-btns">
      <button class="bsm" id="na-all">${ticked === d.steps.length ? 'Untick all' : 'Tick all'}</button>
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
  $('na-all').addEventListener('click', () => set(d.steps.map(s => s.key), ticked !== d.steps.length));
  $('na-solve').addEventListener('click', () => $('bsolve').click());
}

