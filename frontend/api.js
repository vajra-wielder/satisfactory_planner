/**
 * api.js — all communication with the Flask/stdlib backend.
 * No game data is stored here; everything comes from the server.
 */

const BASE = '';  // same origin

export async function apiFetch(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== null) opts.body = JSON.stringify(body);
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

// Solve
export const solveScenario = (scenario) =>
  apiFetch('/api/solve-inline', 'POST', scenario);
