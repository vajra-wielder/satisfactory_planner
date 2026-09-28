/**
 * analysis.js — factory analysis modal.
 * Extracted from sidebar.js for maintainability.
 */

import { SC, RESULT, RECIPES, mCol, MABBR, itemName } from './state.js';
import { fetchDuals, solveScenario } from './api.js';

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
export function openAnalysis() {
  document.getElementById('analysis-modal').classList.add('show');
  renderAnalysis();          // render immediately with whatever we have

  // Fetch duals lazily if we have a result but no shadow prices yet
  if (RESULT?.status?.startsWith('Optimal') &&
      Object.keys(RESULT.shadow_prices || {}).length === 0) {
    const body = document.getElementById('analysis-body');
    // Subtle loading indicator — don't wipe the already-rendered content
    const loadingBanner = document.createElement('div');
    loadingBanner.id = 'duals-loading';
    loadingBanner.style.cssText =
      'font-size:11px;color:var(--t3);padding:6px 12px;text-align:center';
    loadingBanner.textContent = 'Computing shadow prices…';
    body.prepend(loadingBanner);

    fetchDuals()
      .then(({ shadow_prices, saturation_points }) => {
        RESULT.shadow_prices     = shadow_prices     || {};
        RESULT.saturation_points = saturation_points || {};
        renderAnalysis();   // re-render with full dual data
      })
      .catch(() => {
        const banner = document.getElementById('duals-loading');
        if (banner) banner.textContent = 'Shadow prices unavailable.';
      });
  }
}

export function closeAnalysis() {
  document.getElementById('analysis-modal').classList.remove('show');
  abortInlineRanking();
}

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

  // ── Machine distribution ──────────────────────────────────────────────────
  section(el, 'Machine Distribution');
  const machBody  = el.querySelector('.an-section:last-child .an-body');
  const machCount = {};
  flows.forEach(f => { machCount[f.machine] = (machCount[f.machine] || 0) + (f.machines_final || 0); });
  const totalMach = Object.values(machCount).reduce((s, v) => s + v, 0) || 1;

  if (!Object.keys(machCount).length) {
    machBody.innerHTML = '<p style="font-size:11px;color:var(--t3)">No machines in solution.</p>';
  } else {
    Object.entries(machCount).sort(([, a], [, b]) => b - a).forEach(([m, cnt]) => {
      const color = mCol(m);
      const pct   = (cnt / totalMach * 100).toFixed(1);
      machBody.innerHTML += `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
          <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></div>
          <div style="flex:1;font-size:11px;color:var(--t2)">${m.replace(/_/g, ' ')}</div>
          <div style="font-family:var(--mono);font-size:11px;color:${color}">${cnt} (${pct}%)</div>
          <div style="width:60px;height:4px;border-radius:2px;background:var(--b2);overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${color};border-radius:2px"></div>
          </div>
        </div>
      `;
    });
  }

  // ── Power breakdown ───────────────────────────────────────────────────────
  section(el, 'Power Breakdown');
  const powBody   = el.querySelector('.an-section:last-child .an-body');
  const totalPow  = RESULT.total_power_mw || 0;
  const powByMach = {};
  flows.forEach(f => { powByMach[f.machine] = (powByMach[f.machine] || 0) + (f.power_mw || 0); });

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
        ${powMade < 0 ? `Used ${powUsed.toFixed(0)} · Made ${(-powMade).toFixed(0)} · Net ` : 'Total: '}${totalPow.toFixed(0)} MW
        ${RESULT.max_power_mw ? `<span style="color:var(--t3)"> / ${RESULT.max_power_mw} MW cap</span>` : ''}
      </div>
    `;
  }

  // ── Solver pruning ────────────────────────────────────────────────────────
  section(el, 'Solver Pruning');
  const pruneBody = el.querySelector('.an-section:last-child .an-body');
  const pruned    = RESULT.pruned_recipe_count || 0;
  pruneBody.innerHTML = `
    <p style="font-size:11px;color:var(--t3);line-height:1.6;margin-bottom:8px">
      The recipe graph is pruned in two phases before solving:
      <br><b style="color:var(--t2)">Forward grounding</b> — only recipes producible from your resources.
      <br><b style="color:var(--t2)">Backward demand</b> — only recipes on a path from resources to objectives.
      Dead-end branches whose outputs are never needed are dropped here.
    </p>
    ${statCard('Recipes entering LP', pruned, 'var(--acc)')}
  `;

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
      ${statCard('Shards used', RESULT.shards_used || 0, '#3b82f6')}
      ${statCard('Sloops used', RESULT.sloops_used || 0, '#a855f7')}
    </div>
  `;

  // ── Alternate ranking ─────────────────────────────────────────────────────
  // Only rank the alts that actually appear in the solution — not every alt
  // enabled in the scenario config.  We identify them by recipe_key in flows.
  const activeAltKeys = new Set(altFlows.map(f => f.recipe_key));
  if (activeAltKeys.size > 0) {
    section(el, 'Alternate Recipe Ranking');
    const rankBody = el.querySelector('.an-section:last-child .an-body');
    rankBody.innerHTML = `
      <p style="font-size:11px;color:var(--t3);line-height:1.6;margin-bottom:10px">
        Each alternate actually used in this solve is removed and the scenario
        re-solved to measure its impact. <b style="color:var(--t2)">Delta</b>
        = objective loss without it (${Object.keys(SC.objective || {})[0] ? itemName(Object.keys(SC.objective)[0]) + '/min' : 'obj'}).
        <b style="color:#f87171">Required</b> means removal made the solve infeasible.
      </p>
      <div id="an-rank-progress-wrap" style="height:3px;border-radius:2px;background:var(--b2);overflow:hidden;margin-bottom:14px">
        <div id="an-rank-progress-bar" style="height:100%;width:0%;background:var(--acc);border-radius:2px;transition:width .2s"></div>
      </div>
      <div id="an-rank-results"></div>
    `;
    _runInlineRanking(activeAltKeys, rankBody);
  }
}


// ── Inline alt ranking (embedded in analysis modal) ───────────────────────────

let _rankAbort = null;

export function abortInlineRanking() {
  if (_rankAbort) { _rankAbort.abort(); _rankAbort = null; }
}

async function _runInlineRanking(activeAltKeys, rankBody) {
  if (_rankAbort) _rankAbort.abort();
  _rankAbort = new AbortController();
  const signal = _rankAbort.signal;

  const baseObj    = RESULT.objective_value ?? 0;
  const allEnabled = SC.alternate_recipes_enabled || [];

  // Base payload mirrors a normal solve
  const basePayload = {
    ...SC,
    power_shards_available: SC.power_shards_available ?? 0,
    somersloops_available:  SC.somersloops_available  ?? 0,
  };

  let completed = 0;
  const keys = [...activeAltKeys];

  const probes = keys.map(async altKey => {
    const probePayload = {
      ...basePayload,
      alternate_recipes_enabled: allEnabled.filter(k => k !== altKey),
    };

    let probeObj  = null;
    let infeasible = false;

    try {
      const r = await solveScenario(probePayload, signal);
      if (r?.status?.startsWith('Optimal')) {
        probeObj = r.objective_value ?? 0;
      } else {
        infeasible = true;
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      infeasible = true;
    }

    completed++;
    const bar = document.getElementById('an-rank-progress-bar');
    if (bar) bar.style.width = `${Math.round(completed / keys.length * 100)}%`;

    const delta = probeObj !== null ? baseObj - probeObj : null;
    return { altKey, infeasible, delta };
  });

  let results;
  try {
    results = await Promise.all(probes);
  } catch (err) {
    if (err.name === 'AbortError') return;
    const out = document.getElementById('an-rank-results');
    if (out) out.innerHTML = `<p style="color:var(--err);font-size:12px">Ranking failed: ${err.message}</p>`;
    return;
  }

  // Hide progress bar
  const wrap = document.getElementById('an-rank-progress-wrap');
  if (wrap) wrap.style.display = 'none';

  _renderInlineRanking(results, baseObj);
}

function _renderInlineRanking(results, baseObj) {
  const out = document.getElementById('an-rank-results');
  if (!out) return;

  // Classify: 0=REQUIRED, 1=ACTIVE+impactful, 2=ACTIVE+zero-drop (shouldn't
  // happen since we only probe alts that appeared in the solution, but kept
  // for safety)
  const classify = r => {
    if (r.infeasible)                          return 0;
    if (r.delta !== null && r.delta > 0.0001)  return 1;
    return 2;
  };

  results.sort((a, b) => {
    const ca = classify(a), cb = classify(b);
    if (ca !== cb) return ca - cb;
    if (ca === 1)  return (b.delta ?? 0) - (a.delta ?? 0);
    return _altDisplayName(a.altKey).localeCompare(_altDisplayName(b.altKey));
  });

  const BADGE = [
    { label: 'REQUIRED',  bg: 'rgba(239,68,68,.18)',  color: '#f87171' },
    { label: 'ACTIVE',    bg: 'rgba(52,211,153,.15)',  color: '#34d399' },
    { label: 'REDUNDANT', bg: 'rgba(251,191,36,.13)',  color: '#fbbf24' },
  ];

  out.innerHTML = '';
  let rank = 1;
  results.forEach(({ altKey, infeasible, delta }) => {
    const cls   = classify({ infeasible, delta });
    const badge = BADGE[cls];
    const r     = RECIPES[altKey];
    if (!r) return;

    const color    = mCol(r.machine);
    const abbr     = MABBR[r.machine] || r.machine;
    const dispName = _altDisplayName(altKey);

    let deltaStr;
    if (infeasible) {
      deltaStr = `<span style="color:#f87171;font-family:var(--mono);font-size:11px">infeasible</span>`;
    } else if (delta !== null && delta > 0.0001) {
      deltaStr = `<span style="color:var(--err);font-family:var(--mono);font-size:11px">−${delta.toFixed(2)}</span>`;
    } else if (delta !== null && delta < -0.0001) {
      deltaStr = `<span style="color:var(--t3);font-family:var(--mono);font-size:11px">+${Math.abs(delta).toFixed(2)}</span>`;
    } else {
      deltaStr = `<span style="color:var(--t3);font-family:var(--mono);font-size:11px">±0</span>`;
    }

    out.innerHTML += `
      <div class="ra-row">
        <span class="ra-rank">${rank++}.</span>
        <span class="ra-machine" style="background:${color}22;color:${color};border:1px solid ${color}44">${abbr}</span>
        <span class="ra-name">${dispName}</span>
        <span class="ra-badge" style="background:${badge.bg};color:${badge.color}">${badge.label}</span>
        <span class="ra-delta" title="Objective change when this alternate is removed">${deltaStr}</span>
      </div>
    `;
  });

  if (!results.length) {
    out.innerHTML = `<p style="font-size:12px;color:var(--t3)">No active alternates to rank.</p>`;
  }
}

function _altDisplayName(key) {
  const r = RECIPES[key];
  if (!r) return key.replace(/_/g, ' ');
  return r.display.replace(/^Alternate:\s*/i, '').replace(/\s*\(Alt\)/, '');
}
