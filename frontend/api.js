/**
 * api.js — all communication with the Flask/stdlib backend.
 * No game data is stored here; everything comes from the server.
 */

const BASE = '';  // same origin

export async function apiFetch(path, method = 'GET', body = null, signal = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== null) opts.body = JSON.stringify(body);
  if (signal !== null) opts.signal = signal;
  const r = await fetch(BASE + path, opts);
  if (!r.ok) throw new Error(`Server error ${r.status}: ${await r.text()}`);
  return r.json();
}

// Item display name map — returns {item_key: "Human Name"}
export const fetchItemDisplay = () => apiFetch('/api/item-display');

// Item search — returns array of item keys matching query q
export const fetchItems = (q = '') =>
  apiFetch(`/api/items?q=${encodeURIComponent(q)}`);

// All recipes — returns {key: {display, machine, alternate, inputs, outputs}}
export const fetchRecipes = () => apiFetch('/api/recipes');

// All items — returns sorted array of item key strings
export const fetchAllItems = () => apiFetch('/api/items');

// Saved scenarios list
export const fetchScenarios = () => apiFetch('/api/scenarios');

// Single scenario by name key
export const fetchScenario = (name) => apiFetch(`/api/scenarios/${name}`);

// Save scenario
export const saveScenario = (name, data) =>
  apiFetch(`/api/scenarios/${name}`, 'POST', data);

// Delete scenario
export const deleteScenario = (name) =>
  apiFetch(`/api/scenarios/${name}`, 'DELETE');

// Solve — accepts an optional AbortSignal to cancel in-flight requests.
// Uses the async /api/solve endpoint: POSTs to get a job ID, then polls
// GET /api/solve/<id> until done or the signal is aborted.
export async function solveScenario(scenario, signal = null) {
  // 1. Dispatch
  const { job_id } = await apiFetch('/api/solve', 'POST', scenario, signal);

  // 2. Poll until done
  const POLL_MS = 120;   // start fast
  const MAX_MS  = 1500;  // back off to at most 1.5 s
  let delay = POLL_MS;

  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await new Promise(res => setTimeout(res, delay));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const poll = await apiFetch(`/api/solve/${job_id}`, 'GET', null, signal);
    if (poll.status === 'pending') {
      delay = Math.min(delay * 1.5, MAX_MS);  // gentle exponential back-off
      continue;
    }
    if (poll.status === 'done') return poll.result;
    throw new Error(poll.error || 'Solve failed');
  }
}

// Lazy dual LP — called only when Analysis modal opens
export const fetchDuals = () => apiFetch('/api/duals');
