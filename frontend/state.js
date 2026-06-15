/**
 * state.js — shared application state.
 * All modules import from here; nothing stores its own copies.
 */

export const DEF_SC = () => ({
  name: 'New Factory',
  description: '',
  alternate_recipes_enabled: [],
  enabled_machines: [],
  available_resources: {},
  must_produce: {},
  min_produce: {},
  max_produce: {},
  objective: {},
  power_shards_available: null,
  somersloops_available: null,
  max_power_mw: null,
  max_machines: null,
  notes: '',
});

// Active scenario (mutable)
export let SC = DEF_SC();
export function setScenario(s) { Object.assign(SC, s); }
export function resetSC() {
  Object.assign(SC, DEF_SC());
  setPins(null);
}

// Solver result
export let RESULT = null;
export function setResult(r) { RESULT = r; }

// Solve request counter — incremented on each solve dispatch.
// The .then() handler checks its captured ID against the current one
// and discards the result if a newer solve has been fired in the meantime.
export let solveSeq = 0;
export function nextSolveSeq() { return ++solveSeq; }

// All items list — populated from /api/items on boot
export let ALL_ITEMS = [];
export function setAllItems(arr) { ALL_ITEMS = arr; }

// All recipes — populated from /api/recipes on boot
// Shape: { key: { display, machine, alternate, inputs, outputs } }
export let RECIPES = {};
export function setRecipes(obj) { RECIPES = obj; }

// Machine colour map — populated after recipes are loaded
export const MCOL = {
  Miner: '#1d9e75', Water_Extractor: '#1d9e75', Oil_Extractor: '#1d9e75',
  Smelter: '#e85d24', Foundry: '#c4439c', Constructor: '#378add',
  Assembler: '#7f6fdd', Manufacturer: '#c07d10', Refinery: '#5a9e22',
  Blender: '#2b8bd4', Particle_Accelerator: '#e040fb',
  Quantum_Encoder: '#f472b6', Converter: '#34d399', Packager: '#94a3b8',
};
export const mCol = (m) => MCOL[m] || '#6b7280';

export const MABBR = {
  Smelter: 'SME', Foundry: 'FDY', Constructor: 'CON', Assembler: 'ASM',
  Manufacturer: 'MFR', Refinery: 'REF', Blender: 'BLD', Miner: 'MNR',
  Water_Extractor: 'H₂O', Oil_Extractor: 'OIL', Particle_Accelerator: 'PA',
  Quantum_Encoder: 'QE', Converter: 'CNV', Packager: 'PKG',
};

// Item display name helper — populated from /api/item-display on boot
export let ITEM_DISPLAY = {};

export function buildItemDisplay(serverMap) {
  // serverMap comes directly from /api/item-display
  ITEM_DISPLAY = { ...serverMap };

  // ── Correct known game-data naming errors ────────────────
  // "Gold Ingot" is the internal engine name; the in-game display name is "Caterium Ingot"
  if (!ITEM_DISPLAY['Caterium_Ingot'] || ITEM_DISPLAY['Caterium_Ingot'] === 'Gold Ingot') {
    ITEM_DISPLAY['Caterium_Ingot'] = 'Caterium Ingot';
  }
}

export function itemName(key) {
  return ITEM_DISPLAY[key] || key.replace(/_/g, ' ');
}

// ── Pinboard state ────────────────────────────────────────
// pinned_recipes: array of recipe keys that are pinned
// pin_groups: array of { id, title, note, x, y, w, h, color }
// pin_arrows: array of { id, fromGroup, toNode, color }
// (pin node positions are tracked inside pinboard.js itself,
//  but persisted here so they round-trip through YAML)
export let PINS = {
  pinned_recipes: [],   // string[]
  pin_groups: [],       // { id, title, note, x, y, w, h, color }
  pin_arrows: [],       // { id, fromGroup, toNode }
  node_positions: {},   // { recipeKey: {x, y} }
};

export function setPins(p) {
  if (!p) return;
  PINS.pinned_recipes  = p.pinned_recipes  || [];
  PINS.pin_groups      = p.pin_groups      || [];
  PINS.pin_arrows      = p.pin_arrows      || [];
  PINS.node_positions  = p.node_positions  || {};
}

export function addPin(key) {
  if (!PINS.pinned_recipes.includes(key)) {
    PINS.pinned_recipes.push(key);
  }
}

export function removePin(key) {
  PINS.pinned_recipes = PINS.pinned_recipes.filter(k => k !== key);
  delete PINS.node_positions[key];
  // Remove arrows pointing to this node
  PINS.pin_arrows = PINS.pin_arrows.filter(a => a.toNode !== key);
}

export function isPinned(key) {
  return PINS.pinned_recipes.includes(key);
}

export function pinCount() {
  return PINS.pinned_recipes.length;
}

// Machine tier definitions (for machines panel)
export const MTIERS = [
  { label: 'Tier 0-2 · Basic',    ms: ['Smelter', 'Constructor', 'Assembler'] },
  { label: 'Tier 3-4 · Mid',      ms: ['Foundry', 'Manufacturer', 'Refinery'] },
  { label: 'Tier 5-7 · Advanced', ms: ['Blender', 'Packager'] },
  { label: 'Phase 4-5 · Endgame', ms: ['Particle_Accelerator', 'Quantum_Encoder', 'Converter'] },
];
export const ALL_MACHINES = MTIERS.flatMap(t => t.ms);
