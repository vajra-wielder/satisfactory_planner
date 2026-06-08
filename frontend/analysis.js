/**
 * analysis.js — factory analysis modal.
 * Extracted from sidebar.js for maintainability.
 */

import { RESULT, mCol, itemName } from './state.js';
import { fetchDuals } from './api.js';

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

  const utils = resources.map(([item, available]) => {
    const used  = consumed[item] || 0;
    const pct   = available > 0 ? Math.min(100, (used / available) * 100) : 0;
    const dual  = duals[item] ?? null;
    const satAt = sats[item] ?? null;
    return { item, available, used, pct, dual, satAt };
  }).sort((a, b) => b.pct - a.pct);

  const binding   = utils.filter(u => u.pct >= 99.0);
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
    utils.forEach(({ item, available, used, pct, dual, satAt }) => {
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
            <span>${used.toFixed(1)} / ${available.toFixed(1)} per min</span>
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

  if (!Object.keys(powByMach).length) {
    powBody.innerHTML = '<p style="font-size:11px;color:var(--t3)">No power data.</p>';
  } else {
    Object.entries(powByMach).sort(([, a], [, b]) => b - a).forEach(([m, pw]) => {
      const color = mCol(m);
      const pct   = totalPow > 0 ? (pw / totalPow * 100).toFixed(1) : '0.0';
      powBody.innerHTML += `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
          <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></div>
          <div style="flex:1;font-size:11px;color:var(--t2)">${m.replace(/_/g, ' ')}</div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--warn)">${pw.toFixed(0)} MW</div>
          <div style="width:60px;height:4px;border-radius:2px;background:var(--b2);overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${color};border-radius:2px"></div>
          </div>
        </div>
      `;
    });
    powBody.innerHTML += `
      <div style="border-top:1px solid var(--b);padding-top:6px;margin-top:4px;
                  font-family:var(--mono);font-size:12px;color:var(--warn)">
        Total: ${totalPow.toFixed(0)} MW
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
  const sumBody = el.querySelector('.an-section:last-child .an-body');
  const alts    = flows.filter(f => f.display?.startsWith('Alternate:') || f.display?.includes('(Alt)')).length;
  const oc      = flows.filter(f => (f.clock_pct || 100) > 100.5).length;
  const uc      = flows.filter(f => (f.clock_pct || 100) < 99.5).length;
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
}
