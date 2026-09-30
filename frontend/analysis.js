/**
 * analysis.js — factory analysis modal.
 * Extracted from sidebar.js for maintainability.
 */

import { SC, RESULT, RECIPES, mCol, MABBR, itemName } from './state.js';
import { fetchDuals } from './api.js';
import { _fmtSpace } from './ui.js';

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

  // ── Other limits: the machine cap and the shard pool ──────────────────────
  const limits = RESULT.analysis?.limits || {};
  const LIMIT_LABEL = {
    shards:   ['Power shards', 'extra shard', `${RESULT.shards_used || 0} of ${SC.power_shards_available ?? 0} used`],
  };
  const limitRows = Object.entries(limits).filter(([k]) => LIMIT_LABEL[k]);
  if (limitRows.length) {
    section(el, 'Other Limits');
    const limBody = el.querySelector('.an-section:last-child .an-body');
    limitRows.forEach(([k, v]) => {
      const [label, unit, detail] = LIMIT_LABEL[k];
      const binding = v >= 0.0001;
      limBody.innerHTML += `
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px">
          <span style="font-size:12px;font-weight:600;color:var(--t)">${label}
            <span style="font-size:10px;font-weight:400;color:var(--t3);margin-left:4px">${detail}</span></span>
          ${binding
            ? `<span style="font-size:11px;color:var(--acc);font-family:var(--mono);font-weight:600">+${v.toFixed(4)} obj/${unit}</span>`
            : `<span style="font-size:11px;color:var(--t3)">not limiting</span>`}
        </div>`;
    });
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
  // What each alt this plan uses is worth: switched off in the analysis model
  // (the plan's continuous relaxation), the extra resources — then machines —
  // needed for the same output. Related pairs are tested together too.
  const activeAltKeys = new Set(altFlows.map(f => f.recipe_key));
  if (activeAltKeys.size > 0) {
    section(el, 'Alternate Recipe Value');
    const rankBody = el.querySelector('.an-section:last-child .an-body');
    rankBody.innerHTML = `
      <p style="font-size:11px;color:var(--t3);line-height:1.6;margin-bottom:8px">
        What each alternate is worth to this plan (fractional machines, sloops held in place) —
        either <b style="color:var(--t2)">upstream</b>: the share of your output it provides
        with your supply, or, when output doesn't depend on it,
        <b style="color:var(--t2)">downstream</b>: the resources it saves for the same output.
        Then the machine space it saves, in Smelter units (a Smelter = 1).
        <b style="color:#f87171">Required</b> = the goals can't be met without it;
        <b style="color:#fb923c">Short</b> = not at your supply.
      </p>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px">
        <span style="font-size:10px;color:var(--t3)">Sort by</span>
        <div class="seg" id="an-rank-sort">
          <button type="button" data-by="value" class="${_rankSort === 'value' ? 'on' : ''}">Value</button>
          <button type="button" data-by="machines" class="${_rankSort === 'machines' ? 'on' : ''}">Space</button>
        </div>
      </div>
      <div id="an-rank-results"></div>
      <div id="an-groups"></div>
    `;
    rankBody.querySelectorAll('#an-rank-sort button').forEach(btn =>
      btn.addEventListener('click', () => {
        _rankSort = btn.dataset.by;
        rankBody.querySelectorAll('#an-rank-sort button').forEach(b =>
          b.classList.toggle('on', b.dataset.by === _rankSort));
        if (RESULT.analysis) _renderRanking(RESULT.analysis);
      }));
    if (RESULT.analysis) _renderRanking(RESULT.analysis);
    else document.getElementById('an-rank-results').innerHTML =
      '<p style="font-size:11px;color:var(--t3)">Computing…</p>';
  }
}


// ── Alt value + synergy (computed server-side with the rest of the analysis) ─
let _rankSort = 'value';   // 'value' (output, then resources) or 'machines'

// The one number that says what an alternate does: output it provides
// (upstream), else resources it saves (downstream); then machines it saves.
function _valueCells(v) {
  if (v.required) return `<span style="color:#f87171;font-family:var(--mono);font-size:11px">required</span>`;
  const mono = (txt, col, tip) =>
    `<span style="font-family:var(--mono);font-size:11px;color:${col}" title="${tip}">${txt}</span>`;
  let main;
  if (v.short)
    main = mono(`short · +${v.resources.toFixed(1)}% res`, '#fb923c',
                'Without it your supply can\'t meet the fixed outputs; this much more would');
  else if (v.output > 0.05)
    main = mono(`${v.output.toFixed(1)}% output`, 'var(--ok)', 'Share of your output it provides');
  else if (v.resources > 0.05)
    main = mono(`−${v.resources.toFixed(1)}% res`, 'var(--ok)',
                'Without it the same output needs this much more of your resources');
  else
    main = mono('—', 'var(--t3)', 'No effect: other recipes cover for it');
  const m = v.machines ?? 0;          // machine space, Smelter units
  const mach = Math.abs(m) < 0.5 ? ''
    : mono(`${m > 0 ? '−' : '+'}${_fmtSpace(Math.abs(m))}`, m > 0 ? 'var(--ok)' : 'var(--t3)',
           m > 0 ? 'Machine space it saves' : 'Extra machine space it takes');
  return `${main}${mach ? `<span style="margin-left:8px">${mach}</span>` : ''}`;
}

function _renderRanking(analysis) {
  const out = document.getElementById('an-rank-results');
  if (!out) return;
  const BADGE = {
    required: { label: 'REQUIRED',       bg: 'rgba(239,68,68,.18)',  color: '#f87171' },
    short:    { label: 'SHORT',          bg: 'rgba(251,146,60,.16)', color: '#fb923c' },
    output:   { label: 'MORE OUTPUT',    bg: 'rgba(52,211,153,.15)', color: '#34d399' },
    res:      { label: 'LESS RESOURCES', bg: 'rgba(52,211,153,.15)', color: '#34d399' },
    mach:     { label: 'LESS SPACE',     bg: 'rgba(59,130,246,.15)', color: '#60a5fa' },
    none:     { label: 'COVERED',        bg: 'rgba(251,191,36,.13)', color: '#fbbf24' },
  };
  const rows = [...(analysis.alt_ranking || [])];
  const key = _rankSort === 'machines'
    ? r => [r.machines ?? 0, r.output ?? 0, r.resources ?? 0]
    : r => [r.output ?? 0, r.resources ?? 0, r.machines ?? 0];
  const cmp = (a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (kb[i] !== ka[i]) return kb[i] - ka[i];
    return 0;
  };
  rows.sort((a, b) => (b.required - a.required) || (b.short - a.short) || cmp(a, b));

  out.innerHTML = '';
  let rank = 1;
  rows.forEach(v => {
    const r = RECIPES[v.key];
    if (!r) return;
    const badge = BADGE[v.required ? 'required' : v.short ? 'short' : v.output > 0.05 ? 'output'
      : v.resources > 0.05 ? 'res' : v.machines > 0.5 ? 'mach' : 'none'];
    const color = mCol(r.machine);
    out.innerHTML += `
      <div class="ra-row">
        <span class="ra-rank">${rank++}.</span>
        <span class="ra-machine" style="background:${color}22;color:${color};border:1px solid ${color}44">${MABBR[r.machine] || r.machine}</span>
        <span class="ra-name">${_altDisplayName(v.key)}</span>
        <span class="ra-badge" style="background:${badge.bg};color:${badge.color}">${badge.label}</span>
        <span class="ra-delta">${_valueCells(v)}</span>
      </div>
    `;
  });
  if (!rows.length) out.innerHTML = `<p style="font-size:12px;color:var(--t3)">No active alternates to rank.</p>`;

  // ── Synergy ──
  const gEl = document.getElementById('an-groups');
  const groups = analysis.alt_groups || [];
  if (!gEl || !groups.length) { if (gEl) gEl.innerHTML = ''; return; }
  const KIND = {
    together: ['Work together', 'Worth more as a package than apart — one feeds the other.', '#34d399'],
    either:   ['Either one',    'They cover for each other: drop one and the other takes over; drop all and it costs this.', '#fbbf24'],
  };
  const fmt = { output: v => `${v.toFixed(1)}% output`, resources: v => `${v.toFixed(1)}% res`,
                machines: v => _fmtSpace(v) };
  let h = `<div style="font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px">Synergy</div>`;
  ['together', 'either'].forEach(kind => {
    const gs = groups.filter(g => g.kind === kind);
    if (!gs.length) return;
    const [title, blurb, col] = KIND[kind];
    h += `<div style="font-size:11px;font-weight:600;color:${col};margin:8px 0 2px">${title}</div>
          <div style="font-size:10px;color:var(--t3);margin-bottom:6px">${blurb}</div>`;
    gs.forEach(g => {
      const detail = g.required ? 'required as a set'
        : `by ${g.by === 'machines' ? 'space' : g.by}: together ${fmt[g.by](g[g.by])} · apart ${fmt[g.by](g['apart_' + g.by])}`;
      h += `
        <div style="border:1px solid var(--b);border-radius:var(--rsm);padding:6px 8px;margin-bottom:6px">
          <div style="font-size:11px;color:var(--t2);margin-bottom:3px">${g.keys.map(_altDisplayName).join(' + ')}</div>
          <div style="font-size:10px;color:var(--t3);font-family:var(--mono)">${detail}</div>
        </div>`;
    });
  });
  gEl.innerHTML = h;
}

function _altDisplayName(key) {
  const r = RECIPES[key];
  if (!r) return key.replace(/_/g, ' ');
  return r.display.replace(/^Alternate:\s*/i, '').replace(/\s*\(Alt\)/, '');
}
