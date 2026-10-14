/**
 * new-alts.js — the Alternates tab: alternates worth unlocking, and how the
 * solver pruned the recipes.
 *
 * After each solve the server works out the best plan with every alternate
 * you haven't unlocked (solver.suggest_alts) and lists the ones it uses, in
 * the order to unlock them: each with what it adds on top of those above —
 * output, and the resources and space of the plan a solve then makes. Tick the ones to use
 * in this factory, untick the ones you don't want, then Solve — or unlock the
 * ticked ones (you found their hard drives): then every factory has them.
 */
import { SC, RESULT, RECIPES, mCol, MABBR, UNLOCKED_ALTS, setUnlockedAlts } from './state.js';
import { saveUnlockedAlts, fetchUnlockedAlts } from './api.js';
import { setBadge } from './dock.js';

const $ = id => document.getElementById(id);
const name = k => (RECIPES[k]?.display || k).replace(/^Alternate:\s*/i, '');
const pct = v => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;

// What a set of gains says, shortest first: "+106% output · +4,239 space" —
// each the plan a solve makes with them against today's; what gets worse
// (more space for more output) in amber
export function gainText(g, html = true) {
  if (!g) return '';
  const span = (t, c) => (html ? `<span style="color:${c}">${t}</span>` : t);
  const up = 'var(--warn)';
  const r = g.resources || 0, m = g.machines || 0;
  return [g.output > 0.1 ? span(`+${pct(g.output)} output`, 'var(--ok)') : '',
          r > 0.1 ? span(`−${pct(r)} resources`, 'var(--ok)') : r < -0.1 ? span(`+${pct(-r)} resources`, up) : '',
          m > 0.5 ? span(`−${Math.round(m).toLocaleString()} space`, '#60a5fa') : m < -0.5 ? span(`+${Math.round(-m).toLocaleString()} space`, up) : '']
    .filter(Boolean).join(html ? '<span class="na-dot"> · </span>' : ' · ');
}

let seq = 0;
/** Ask for the last solve's suggestions, then draw them. */
export function refreshNewAlts(onChange) {
  const el = $('new-alts');
  if (!el) return;
  drawEverywhere();
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
      order to unlock them, each with what solving with it changes on top of the ones above. With all ${d.steps.length}:
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
    e.target.disabled = true; e.target.textContent = 'Unlocking…';
    try {
      // on top of what's unlocked — as saved, so nothing you unlocked elsewhere is lost
      const have = (await fetchUnlockedAlts()).unlocked || [];
      const keys = [...new Set([...have, ...UNLOCKED_ALTS, ...ticked.map(s => s.key)])];
      setUnlockedAlts((await saveUnlockedAlts(keys)).unlocked || keys);
      document.dispatchEvent(new Event('unlocks-changed'));
      $('bsolve').click();                 // with them unlocked: the plan, and what's left to suggest
    } catch (err) { e.target.textContent = 'Failed — retry'; e.target.disabled = false; }
  });
}


// Every alternate you haven't unlocked, by what it adds to all your saved
// factories as they are — each on its own, so the first is the hard drive
// worth most across the lot
// (the saved factories: asked again at most every 10 s, or when unlocks change)
let ALL_SEQ = 0, ALL_OPEN = false, ALL = null, ALL_AT = 0;
document.addEventListener('unlocks-changed', () => { ALL_AT = 0; });
function drawEverywhere() {
  const el = $('alts-all');
  if (!el) return;
  const mine = ++ALL_SEQ;
  const got = ALL && Date.now() - ALL_AT < 10000 ? Promise.resolve(ALL)
    : fetch('/api/alts-everywhere').then(r => r.json()).then(d => { ALL = d; ALL_AT = Date.now(); return d; });
  got.then(d => {
    if (mine !== ALL_SEQ) return;
    const list = d.alts || [];
    const nm = k => d.names?.[k] || k;
    const pc = v => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;
    const row = (a, i) => {
      const r = RECIPES[a.key] || {}, c = mCol(r.machine);
      const gains = [...Object.entries(a.output).map(([f, v]) => `<span style="color:var(--ok)">+${pc(v)}</span> ${nm(f)}`),
                     ...Object.entries(a.resources).map(([f, v]) => `<span style="color:var(--ok)">−${pc(v)} resources</span> ${nm(f)}`)];
      return `<div class="na-row"><span class="na-i">${i + 1}</span>
        <span class="na-m" style="background:${c}22;color:${c};border:1px solid ${c}44">${MABBR[r.machine] || r.machine || ''}</span>
        <span class="na-n">${name(a.key)}<br><span class="na-g">${gains.join('<span class="na-dot"> · </span>')}</span></span></div>`;
    };
    const shown = ALL_OPEN ? list : list.slice(0, 6);
    el.innerHTML = `<div class="na-head"><b>Across all factories</b><span class="n-hint">${list.length ? 'each on its own' : ''}</span></div>
      ${list.length ? shown.map(row).join('') + (list.length > 6 ? `<button class="bsm" id="aa-more">${ALL_OPEN ? 'Fewer' : `All ${list.length}`}</button>` : '')
        : '<p class="n-hint">None you haven\'t unlocked would help a saved factory.</p>'}`;
    $('aa-more')?.addEventListener('click', () => { ALL_OPEN = !ALL_OPEN; drawEverywhere(); });
  }).catch(() => { el.innerHTML = ''; });
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
