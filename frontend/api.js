/**
 * api.js — all HTTP calls to the backend server.
 */

// ── Core fetch helper ─────────────────────────────────────
async function apiFetch(url, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status}`);
  return r.json();
}

// ── Game data — single combined boot fetch ────────────────
// Items, recipes, names, unlocks and tiers in one round-trip
export const fetchBoot = () => apiFetch('/api/boot');

// ── Scenarios ─────────────────────────────────────────────
export const fetchScenarios   = ()        => apiFetch('/api/scenarios');
export const fetchScenario    = (key)     => apiFetch(`/api/scenarios/${key}`);
export const saveScenario     = (key, sc) => apiFetch(`/api/scenarios/${key}`, 'POST', sc);
export const deleteScenario   = (key)     => apiFetch(`/api/scenarios/${key}`, 'DELETE');

// What every saved factory makes, and who already takes it (From factories)
export const fetchFactoryOutputs = () => apiFetch('/api/factory-outputs');

export const saveProgress = (p) => apiFetch('/api/progress', 'POST', p);
// The goal tree: what so much of a part takes that the factory can't give it
export const fetchNeeds = (scenario, item, rate) => apiFetch('/api/needs', 'POST', { scenario, item, rate });
export const fetchMapNodes = () => apiFetch('/api/map-nodes');

// ── Solver (async job polling) ────────────────────────────
// Server returns a job_id immediately; we poll until done or aborted.
export async function solveScenario(payload, signal) {
  const { job_id } = await fetch('/api/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  }).then(r => {
    if (!r.ok) return r.json().then(e => { throw new Error(e.error || r.status); });
    return r.json();
  });

  // quick looks first (a cached plan is ready at once), then every 150 ms
  for (let n = 0; ; n++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await new Promise(res => setTimeout(res, n < 3 ? 25 : 150));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const poll = await fetch(`/api/solve/${job_id}`, { signal }).then(r => r.json());

    if (poll.status === 'pending') continue;
    if (poll.status === 'done')    return poll.result;
    if (poll.status === 'error')   throw new Error(poll.result?.error || 'Solve error');
    throw new Error('Unexpected poll status: ' + poll.status);
  }
}

// ── Shadow prices (duals) ─────────────────────────────────
export const fetchDuals = () => apiFetch('/api/duals');

// ── Unlocked alternate recipes ────────────────────────────
export const fetchUnlockedAlts = ()      => apiFetch('/api/unlocked-alts');
export const saveUnlockedAlts  = (keys) => apiFetch('/api/unlocked-alts', 'POST', { unlocked: keys });

/** A saved factory's To storage of an item, set (rate 0: none) — kept to what it has free. */
export function setStored(key, item, rate) {
  return fetch('/api/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, item, rate }) }).then(r => r.json());
}
