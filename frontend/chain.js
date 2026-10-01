/**
 * chain.js — re-solve factories in order: sources first, each importer held to
 * what its sources make now, then solved (server: /api/resolve-chain).
 * One run at a time; anything showing progress listens with onChain.
 */

const fmt = v => (v == null ? '—' : (Math.abs(v - Math.round(v)) < 1e-3 ? Math.round(v) : +v.toFixed(2)).toLocaleString());
const listeners = new Set();
let timer = null, last = null;

export function onChain(fn) { listeners.add(fn); if (last) fn(last); return () => listeners.delete(fn); }

function poll() {
  fetch('/api/resolve-chain').then(r => r.json()).then(st => {
    last = st;
    listeners.forEach(fn => fn(st));
    if (st.running) timer = setTimeout(poll, 800);
    else timer = null;
  }).catch(() => { timer = null; });
}

/** keys: the factories to start from (null: everything out of date). */
export function startChain(keys = null) {
  return fetch('/api/resolve-chain', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(keys ? { keys } : {}) }).then(r => r.json()).then(d => {
    if (!timer) poll();
    return d;
  });
}
export function watchChain() { if (!timer) poll(); }

// What a run did, as HTML: one line per factory
export function chainHTML(st) {
  if (!st || (!st.running && !st.steps.length)) return '';
  const done = st.steps.filter(s => s.status !== 'solving').length;
  const rows = st.steps.map(s => {
    const ok = String(s.status).startsWith('Optimal');
    const cut = (s.cut || []).filter(c => c.kind === 'import').map(c => `${c.item.replace(/_/g, ' ')} from ${c.factory} ${fmt(c.asked)} → ${fmt(c.rate)}`);
    const unmet = Object.entries(s.owed_unmet || {}).map(([k, v]) => `${k.replace(/_/g, ' ')} ${fmt(v)} short`);
    return `<div class="ch-row ${s.status === 'solving' ? '' : ok ? '' : 'n-warn'}">
      <b>${s.name || s.key}</b> ${s.status === 'solving' ? '<span class="n-hint">solving…</span>'
        : ok ? `<span class="n-hint">goal ${fmt(s.before)} → <b>${fmt(s.after)}</b></span>` : `<span>${s.error || s.status}</span>`}
      ${cut.length ? `<div class="n-hint n-warn">imports held to what's left: ${cut.join('; ')}</div>` : ''}
      ${unmet.length ? `<div class="n-hint n-warn">can't make all it owes: ${unmet.join('; ')}</div>` : ''}</div>`;
  }).join('');
  return `<div class="ch-box"><div class="n-sent-t">${st.running ? `Re-solving ${done + 1} of ${st.todo.length}…` : `Re-solved ${st.steps.length}`}</div>${rows}</div>`;
}
