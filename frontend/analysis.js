/**
 * analysis.js — what limits the plan, where to lift it, and what-if sliders.
 */
import { SC, RESULT, RECIPES, mCol, MABBR, itemName, fetchDuals } from './state.js';
import { openDock, closeDock, dockTab } from './nav.js';
import { _fmtSpace } from './ui.js';
import { freeNodes, takeNode, setSupplyTotal, goalOf, setGoal } from './sidebar.js';


// ── DOM helpers ───────────────────────────────────────────
function section(parent, title, extraHTML = '') {
  const d = document.createElement('div');
  d.className = 'an-section';
  d.innerHTML = `<div class="an-title">${title}</div><div class="an-body">${extraHTML}</div>`;
  parent.appendChild(d);
}

function statCard(label, val, color) {
  return `<div style="background:var(--p3);border:1px solid var(--b);border-radius:var(--rsm);padding:8px 10px">
    <div style="font-family:var(--mono);font-size:16px;font-weight:600;color:${color}">${val}</div>
    <div style="font-size:10px;color:var(--t3);margin-top:2px">${label}</div>
  </div>`;
}

// ── Public API ────────────────────────────────────────────
// The Analysis is the right panel's Analysis tab: openAnalysis shows it,
// showAnalysis draws it (whenever the tab is shown, or a solve lands while it is)
export function openAnalysis() { openDock('analysis'); }
export function showAnalysis() {
  renderAnalysis();          // render immediately with whatever we have

  // Fetch the analysis lazily (computed once per solve on the server)
  if (RESULT?.status?.startsWith('Optimal') && !RESULT.analysis) {
    const res = RESULT;
    const body = document.getElementById('analysis-body');
    // Subtle loading indicator — don't wipe the already-rendered content
    const loadingBanner = document.createElement('div');
    loadingBanner.id = 'duals-loading';
    loadingBanner.style.cssText =
      'font-size:11px;color:var(--t3);padding:6px 12px;text-align:center';
    loadingBanner.textContent = 'Computing shadow prices…';
    body.prepend(loadingBanner);

    fetchDuals()
      .then(analysis => {
        res.analysis          = analysis || {};
        res.shadow_prices     = res.analysis.shadow_prices     || {};
        res.saturation_points = res.analysis.saturation_points || {};
        if (res === RESULT) renderAnalysis();   // re-render unless a new solve replaced it
      })
      .catch(() => {
        const banner = document.getElementById('duals-loading');
        if (banner) banner.textContent = 'Shadow prices unavailable.';
      });
  }
}

export function closeAnalysis() { if (dockTab() === 'analysis') closeDock(); }

// ── Render ────────────────────────────────────────────────
function renderAnalysis() {
  const el = document.getElementById('analysis-body');
  el.innerHTML = '';

  if (!RESULT || !RESULT.status) {
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                  padding:40px 20px;gap:12px;color:var(--t3);text-align:center">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.5" opacity=".4">
          <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
          <line x1="6" y1="20" x2="6" y2="14"/>
        </svg>
        <p style="font-size:13px;color:var(--t2)">No solve result yet</p>
        <p style="font-size:11px;line-height:1.5">
          Run a solve first (▶ Solve or Ctrl+R),<br>then open Analysis to see resource
          utilisation, shadow prices, and machine breakdown.
        </p>
      </div>
    `;
    return;
  }

  if (!RESULT.status?.startsWith('Optimal')) {
    el.innerHTML = `
      <div style="padding:20px;color:var(--err);font-size:12px;line-height:1.6">
        <b>Solve did not reach an optimal solution.</b><br>
        Status: ${RESULT.status}<br><br>
        Check the Issues panel for constraint conflicts.
      </div>
    `;
    return;
  }

  const flows     = RESULT.flows || [];
  const duals     = RESULT.shadow_prices || {};
  const sats      = RESULT.saturation_points || {};
  const resources = Object.entries(RESULT.source_nodes || {});

  // ── Resource utilisation + shadow prices ──────────────────────────────────
  const consumed = {};
  flows.forEach(f => {
    Object.entries(f.inputs || {}).forEach(([item, rate]) => {
      consumed[item] = (consumed[item] || 0) + rate;
    });
  });

  const unlimitedSet = new Set(RESULT.unlimited_resources || []);
  const utils = resources.map(([item, available]) => {
    const used  = consumed[item] || 0;
    const unlimited = unlimitedSet.has(item);
    const pct   = unlimited ? 0 : available > 0 ? Math.min(100, (used / available) * 100) : 0;
    const dual  = duals[item] ?? null;
    const satAt = sats[item] ?? null;
    return { item, available, used, pct, dual, satAt, unlimited };
  }).sort((a, b) => (a.unlimited - b.unlimited) || (b.pct - a.pct));

  const binding   = utils.filter(u => !u.unlimited && u.pct >= 99.0);
  const coBinding = binding.length > 1;
  const hasDuals  = Object.keys(duals).length > 0;

  section(el, 'Resource Utilisation & Shadow Prices', `
    <p style="font-size:11px;color:var(--t3);margin-bottom:10px;line-height:1.6">
      <b style="color:var(--t2)">Shadow price</b> = extra objective value per additional unit/min.
      Zero means the resource has slack — adding more won't help yet.
      ${coBinding
        ? `<br><span style="color:var(--warn)">⚠ Co-binding:</span>
           ${binding.map(u => itemName(u.item)).join(' &amp; ')} are
           all at 100% simultaneously. You must expand all of them together
           to gain more output.`
        : ''}
    </p>
  `);

  if (!resources.length) {
    el.querySelector('.an-section:last-child .an-body').innerHTML +=
      '<p style="font-size:11px;color:var(--t3)">No resource constraints in this scenario.</p>';
  } else {
    utils.forEach(({ item, available, used, pct, dual, satAt, unlimited }) => {
      if (unlimited) {
        el.querySelector('.an-section:last-child .an-body').innerHTML += `
          <div style="margin-bottom:13px;padding-bottom:11px;border-bottom:1px solid var(--b)">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">
              <span style="font-size:12px;font-weight:600;color:var(--t)">${itemName(item)}</span>
              <span style="font-size:10px;color:var(--acc);font-weight:600">∞ Unlimited</span>
            </div>
            <div style="font-size:10px;color:var(--t3);font-family:var(--mono)">
              ${used.toFixed(2)} per min drawn · free, no cap</div>
          </div>`;
        return;
      }
      const barColor  = pct >= 99 ? 'var(--err)' : pct >= 80 ? 'var(--warn)' : 'var(--ok)';
      const statusLbl = pct >= 99 ? '⚠ Binding'  : pct >= 80 ? 'Near limit'  : 'Slack';

      let shadowLine = '';
      if (!hasDuals) {
        shadowLine = `<span style="color:var(--t3)">shadow price unavailable</span>`;
      } else if (dual === null || dual < 0.0001) {
        shadowLine = `<span style="color:var(--t3)">+0 obj/unit — not a bottleneck</span>`;
      } else {
        const satText = satAt !== null
          ? ` <span style="color:var(--t3)">(becomes 0 above ${satAt.toLocaleString()}/min)</span>`
          : ` <span style="color:var(--t3)">(no saturation found in range)</span>`;
        shadowLine = `<span style="color:var(--acc);font-family:var(--mono);font-weight:600">+${dual.toFixed(4)} obj/unit</span>${satText}`;
      }

      el.querySelector('.an-section:last-child .an-body').innerHTML += `
        <div style="margin-bottom:13px;padding-bottom:11px;border-bottom:1px solid var(--b)">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">
            <span style="font-size:12px;font-weight:600;color:var(--t)">${itemName(item)}</span>
            <span style="font-size:10px;color:${barColor};font-weight:600">${statusLbl}</span>
          </div>
          <div style="height:5px;border-radius:3px;background:var(--b2);overflow:hidden;margin-bottom:3px">
            <div style="height:100%;width:${pct.toFixed(1)}%;background:${barColor};border-radius:3px"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:10px;
                      color:var(--t3);font-family:var(--mono);margin-bottom:5px">
            <span>${used.toFixed(2)} / ${available.toFixed(2)} per min</span>
            <span>${pct.toFixed(1)}%</span>
          </div>
          <div style="font-size:11px">${shadowLine}</div>
          ${pct >= 99 && dual > 1e-4 ? `<div class="an-fix" data-res="${item}" data-dual="${dual}" data-room="${satAt !== null ? Math.max(0, satAt - available) : ''}"></div>` : ''}
        </div>
      `;
    });

    if (!hasDuals) {
      el.querySelector('.an-section:last-child .an-body').innerHTML +=
        `<p style="font-size:11px;color:var(--t3);line-height:1.5">
          Shadow prices could not be extracted for this solve.
          This can occur when the LP is degenerate or when integer
          power/machine constraints alter the basis.
        </p>`;
    }
  }

  fillFixes(el);
  whatIf(el);

  // ── Power breakdown ───────────────────────────────────────────────────────
  section(el, 'Power Breakdown');
  const powBody   = el.querySelector('.an-section:last-child .an-body');
  const powByMach = {};
  flows.forEach(f => { powByMach[f.machine] = (powByMach[f.machine] || 0) + (f.power_mw || 0); });
  if (RESULT.extractor_power_mw) powByMach.Extractors = RESULT.extractor_power_mw;   // miners, pumps: drawn too

  const powUsed = Object.values(powByMach).filter(p => p > 0).reduce((a, b) => a + b, 0);
  const powMade = Object.values(powByMach).filter(p => p < 0).reduce((a, b) => a + b, 0);

  if (!Object.keys(powByMach).length) {
    powBody.innerHTML = '<p style="font-size:11px;color:var(--t3)">No power data.</p>';
  } else {
    Object.entries(powByMach).sort(([, a], [, b]) => b - a).forEach(([m, pw]) => {
      const color = mCol(m);
      // Bars are shares of the power used, or of the power made for generators
      const pct   = ((pw < 0 ? pw / powMade : pw / powUsed) * 100 || 0).toFixed(1);
      powBody.innerHTML += `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
          <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></div>
          <div style="flex:1;font-size:11px;color:var(--t2)">${m.replace(/_/g, ' ')}</div>
          <div style="font-family:var(--mono);font-size:11px;color:${pw < 0 ? 'var(--ok)' : 'var(--warn)'}">${pw < 0 ? `+${(-pw).toFixed(0)}` : pw.toFixed(0)} MW</div>
          <div style="width:60px;height:4px;border-radius:2px;background:var(--b2);overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${color};border-radius:2px"></div>
          </div>
        </div>
      `;
    });
    powBody.innerHTML += `
      <div style="border-top:1px solid var(--b);padding-top:6px;margin-top:4px;
                  font-family:var(--mono);font-size:12px;color:var(--warn)">
        ${powMade < 0 ? `Used ${powUsed.toFixed(0)} · Made ${(-powMade).toFixed(0)} · ${powUsed + powMade > 0 ? `${(powUsed + powMade).toFixed(0)} short` : `${(-(powUsed + powMade)).toFixed(0)} to spare`}` : `Total: ${powUsed.toFixed(0)}`} MW
        ${RESULT.max_power_mw ? `<span style="color:var(--t3)"> / ${RESULT.max_power_mw} MW cap</span>` : ''}
      </div>
    `;
  }

  // ── Solution summary ──────────────────────────────────────────────────────
  section(el, 'Solution Summary');
  const sumBody  = el.querySelector('.an-section:last-child .an-body');
  const altFlows = flows.filter(f => f.display?.startsWith('Alternate:') || f.display?.includes('(Alt)'));
  const alts     = altFlows.length;
  const oc       = flows.filter(f => (f.clock_pct || 100) > 100.5).length;
  const uc       = flows.filter(f => (f.clock_pct || 100) < 99.5).length;
  sumBody.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
      ${statCard('Active recipes', flows.length, 'var(--t)')}
      ${statCard('Alternate recipes', alts, 'var(--acc)')}
      ${statCard('Overclocked', oc, '#3b82f6')}
      ${statCard('Underclocked', uc, '#38bdf8')}
    </div>
  `;

}


// A limit, with where to lift it: the nearest free nodes of it, what each
// gives and about what that's worth (its shadow price, up to where it stops
// helping) — add one, and the plan is solved again
const num = v => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : +v.toFixed(v < 10 ? 2 : 1)).toLocaleString();
function worth(dual, extra) {
  const obj = Object.entries(SC.objective || {});
  const v = dual * extra;
  return obj.length === 1 ? `≈ +${num(v / (+obj[0][1] || 1))}/min ${itemName(obj[0][0])}` : `≈ +${num(v)} score`;
}
function fillFixes(el) {
  el.querySelectorAll('.an-fix').forEach(box => {
    const res = box.dataset.res, dual = +box.dataset.dual, room = box.dataset.room === '' ? Infinity : +box.dataset.room;
    freeNodes(res).then(list => {
      if (!box.isConnected) return;
      if (!list.length) { box.innerHTML = '<span class="n-hint">No free nodes of it left on the map — import it, or an alternate that needs less.</span>'; return; }
      box.innerHTML = `<div class="n-hint" style="margin:4px 0 2px">Nearest free nodes:</div>` + list.map(n => `
        <div class="an-node"><span class="an-p ${n.p}">${n.p[0].toUpperCase()}</span>
          <span>${n.dist == null ? '' : `${n.dist < 1000 ? `${Math.round(n.dist / 10) * 10} m` : `${(n.dist / 1000).toFixed(1)} km`} · `}+${num(n.rate)}/min</span>
          <span class="n-hint">${worth(dual, Math.min(n.rate, room))}</span>
          <button class="bsm act" data-take="${n.id}" title="Mine it here, and solve again">Add &amp; solve</button></div>`).join('');
      box.querySelectorAll('[data-take]').forEach(b => b.addEventListener('click', () => {
        takeNode(b.dataset.take);
        document.dispatchEvent(new Event('supply-changed'));
        document.getElementById('bsolve')?.click();
      }));
    });
  });
}

// ── What if: drag a supply or a fixed goal, watch the goal move ──
// Each drag asks the server for the goal's ceiling with that one number
// changed (fractional machines: fast enough to follow the mouse; whole
// machines land a little under). "Use it" puts the number in the factory.
let WI_SEQ = 0;
function whatIf(el) {
  const res = Object.entries(RESULT.source_nodes || {}).filter(([i]) => !(RESULT.unlimited_resources || []).includes(i));
  const goals = [...Object.entries(SC.must_produce || {}).map(([i, v]) => ['must', i, v]), ...Object.entries(SC.min_produce || {}).map(([i, v]) => ['min', i, v])];
  const caps = [...(SC.max_machines != null ? [['cap', 'machines', +SC.max_machines]] : []),
                ...(SC.max_power_mw != null ? [['cap', 'power', +SC.max_power_mw]] : [])];
  if (!res.length && !goals.length && !caps.length) return;
  section(el, 'What if', '<p class="n-hint" style="margin:0 0 8px">Drag one: the goal follows (with machines in fractions — whole ones land a little under).</p><div class="wi-out"></div>');
  const body = el.querySelector('.an-section:last-child .an-body'), out = body.querySelector('.wi-out');
  const obj = Object.keys(SC.objective || {});
  const show = (d, base, label) => {
    if (!d?.ok) { out.innerHTML = `<span class="n-warn">${label}: it can't be done — a fixed goal doesn't fit</span>`; return; }
    out.innerHTML = `<span class="n-hint">${label}</span> ` + (obj.length ? obj.map(i => {
      const v = d.items[i] || 0, b = base?.items?.[i] ?? v, dd = v - b;
      return `<span class="wi-v">${itemName(i)} <b>${num(v)}</b>${Math.abs(dd) > 1e-3 ? ` <i class="${dd > 0 ? 'up' : 'down'}">${dd > 0 ? '+' : '−'}${num(Math.abs(dd))}</i>` : ''}</span>`;
    }).join(' ') : '<span class="wi-v">fits</span>');
  };
  let BASE = null;
  const ask = (set, label) => {
    const mine = ++WI_SEQ;
    return fetch('/api/whatif', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: SC, set }) })
      .then(r => r.json()).then(d => { if (mine === WI_SEQ && label) show(d, BASE, label); return d; }).catch(() => null);
  };
  ask({}, null).then(d => { BASE = d; if (!out.innerHTML) show(d, d, 'As it is:'); });
  const rows = [...res.map(([i, v]) => ['res', i, v]), ...goals, ...caps];
  const CAP = { machines: ['▦ Machine cap', 'sc-mm', ''], power: ['⚡ Power cap', 'sc-mp', ' MW'] };
  const nameOf = (k, i) => k === 'cap' ? CAP[i][0] : itemName(i);
  body.insertAdjacentHTML('beforeend', rows.map(([k, i, v], n) => {
    const max = Math.max(10, Math.ceil(v * 2.5 / 10) * 10);
    return `<div class="wi-r" data-n="${n}"><span class="wi-l">${k === 'cap' ? CAP[i][0] : `${k === 'res' ? '⛏' : k === 'must' ? '=' : '≥'} ${itemName(i)}`}</span>
      <input type="range" min="0" max="${max}" step="${max > 200 ? 5 : 1}" value="${v}"/><span class="wi-n">${num(v)}</span>
      <button class="bsm" data-use title="${k === 'res' ? 'Make the supply this — through its typed rate' : k === 'cap' ? 'Make the cap this' : 'Make the goal this'}" style="visibility:hidden">Use it</button></div>`;
  }).join(''));
  body.querySelectorAll('.wi-r').forEach(r => {
    const [k, i, v0] = rows[+r.dataset.n], rng = r.querySelector('input'), lbl = r.querySelector('.wi-n'), use = r.querySelector('[data-use]');
    let t = 0;
    rng.addEventListener('input', () => {
      const v = +rng.value;
      lbl.textContent = num(v);
      use.style.visibility = Math.abs(v - v0) > 1e-6 ? 'visible' : 'hidden';
      const set = k === 'res' ? { resources: { [i]: v } } : k === 'cap' ? { caps: { [i]: v } } : { [k]: { [i]: v } };
      clearTimeout(t); t = setTimeout(() => ask(set, `${nameOf(k, i)} at ${num(v)}${k === 'cap' ? CAP[i][2] : ''}:`), 40);
    });
    use.addEventListener('click', () => {
      const v = +rng.value;
      if (k === 'cap') {
        const inp = document.getElementById(CAP[i][1]);
        inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (k === 'res') {
        if (!setSupplyTotal(i, v)) { use.textContent = 'from nodes — add some above'; return; }
        document.dispatchEvent(new Event('supply-changed'));
      } else {
        setGoal(i, { ...goalOf(i), [k]: v });
        document.dispatchEvent(new Event('goals-changed'));
      }
      document.getElementById('bsolve')?.click();
    });
  });
}
