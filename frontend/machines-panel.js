/**
 * machines-panel.js — Machines and Alternates panels.
 * Extracted from sidebar.js.
 *
 * Owns:
 *   - renderMachines / updMachBadge
 *   - renderAlts / updAltBadge / altsAll / altsNone
 *   - ALT_TREE (fully hardcoded, computed offline)
 */

import {
  SC, RECIPES,
  mCol, MABBR, itemName, MTIERS, ALL_MACHINES,
} from './state.js';

// ── Unlock state — managed locally, injected from main.js ─
// Keeps machines-panel.js independent of new state.js exports
// so deploying this file alone is safe.
let _unlockedAlts   = new Set();
let _saveUnlockedFn = async () => {};

export function setUnlockedSaver(fn)  { _saveUnlockedFn  = fn; }
export function setUnlockedAlts(keys) { _unlockedAlts = new Set(keys || []); }
function _isUnlocked(key)    { return _unlockedAlts.has(key); }
function _toggleUnlocked(key) {
  if (_unlockedAlts.has(key)) _unlockedAlts.delete(key);
  else _unlockedAlts.add(key);
}

// ══════════════════════════════════════════════════════════
// MACHINES PANEL
// ══════════════════════════════════════════════════════════

export function renderMachines() {
  const p  = document.getElementById('machpanel');
  p.innerHTML = '';
  const en = new Set(SC.enabled_machines.length ? SC.enabled_machines : ALL_MACHINES);

  MTIERS.forEach(tier => {
    const wrap = document.createElement('div');
    wrap.style.marginBottom = '8px';

    const hdr  = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:4px';

    const hbtn = document.createElement('button');
    hbtn.className    = 'bsm' + (tier.ms.every(m => en.has(m)) ? ' act' : '');
    hbtn.style.cssText = 'font-size:10px;padding:2px 7px';
    hbtn.textContent  = tier.label;
    hbtn.addEventListener('click', () => {
      const allOn = tier.ms.every(m => en.has(m));
      tier.ms.forEach(m => allOn ? en.delete(m) : en.add(m));
      _saveEnabledMachines(en);
    });
    hdr.appendChild(hbtn);
    wrap.appendChild(hdr);

    const chips = document.createElement('div');
    chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;padding-left:2px';
    tier.ms.forEach(m => {
      const on   = en.has(m);
      const c    = mCol(m);
      const chip = document.createElement('div');
      chip.className = 'mchip';
      chip.style.cssText =
        `border-color:${on ? c : 'var(--b)'};` +
        `background:${on ? c + '22' : 'var(--p3)'};` +
        `color:${on ? c : 'var(--t3)'}`;
      chip.textContent = m.replace(/_/g, ' ');
      chip.addEventListener('click', () => {
        on ? en.delete(m) : en.add(m);
        _saveEnabledMachines(en);
      });
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);
    p.appendChild(wrap);
  });
}

// Persist enabled set back into SC and refresh
function _saveEnabledMachines(en) {
  // Empty array = "all enabled" (server default), avoids bloating saved scenarios
  SC.enabled_machines = [...en].length === ALL_MACHINES.length ? [] : [...en];
  renderMachines();
  updMachBadge();
}

export function updMachBadge() {
  const el = document.getElementById('mb');
  if (el) el.textContent = SC.enabled_machines.length
    ? `${SC.enabled_machines.length}/${ALL_MACHINES.length}`
    : 'All';
}

// ══════════════════════════════════════════════════════════
// ALTERNATES PANEL — 3-level: Family > Item > Recipes
//
// Groupings computed offline by tracing basic-recipe raw-ore
// costs recursively for every alternate's primary output.
// Family = dominant raw resource (Iron/Copper/Caterium/Steel/
// Oil/Sulfur/Quartz/Aluminum/Uranium/SAM/Limestone).
// Steel = items with significant Coal+Iron co-dominance.
// Caterium Ingot is stored as Gold_Ingot in game data —
// display name is corrected in state.js buildItemDisplay().
//
// Each entry: { key, display, machine }  — all baked in.
// ══════════════════════════════════════════════════════════

const ALT_TREE = {
  'Iron': {
    'Iron Ingot': [
      { key: 'Alt_Basic_Iron_Ingot',   display: 'Basic Iron Ingot',   machine: 'Foundry'   },
      { key: 'Alt_Iron_Alloy_Ingot',   display: 'Iron Alloy Ingot',   machine: 'Foundry'   },
      { key: 'Alt_Leached_Iron_Ingot', display: 'Leached Iron Ingot', machine: 'Refinery'  },
      { key: 'Alt_Pure_Iron_Ingot',    display: 'Pure Iron Ingot',    machine: 'Refinery'  },
    ],
    'Iron Plate': [
      { key: 'Alt_Coated_Iron_Plate', display: 'Coated Iron Plate', machine: 'Assembler' },
      { key: 'Alt_Steel_Cast_Plate',  display: 'Steel Cast Plate',  machine: 'Foundry'   },
    ],
    'Iron Rod': [
      { key: 'Alt_Aluminum_Rod', display: 'Aluminum Rod', machine: 'Constructor' },
      { key: 'Alt_Steel_Rod',    display: 'Steel Rod',    machine: 'Constructor' },
    ],
    'Screw': [
      { key: 'Alt_Cast_Screws',  display: 'Cast Screw',   machine: 'Constructor' },
      { key: 'Alt_Steel_Screws', display: 'Steel Screw',  machine: 'Constructor' },
    ],
    'Reinforced Iron Plate': [
      { key: 'Alt_Adhered_Iron_Plate',  display: 'Adhered Iron Plate',  machine: 'Assembler' },
      { key: 'Alt_Bolted_Iron_Plate',   display: 'Bolted Iron Plate',   machine: 'Assembler' },
      { key: 'Alt_Stitched_Iron_Plate', display: 'Stitched Iron Plate', machine: 'Assembler' },
    ],
    'Rotor': [
      { key: 'Alt_Copper_Rotor', display: 'Copper Rotor', machine: 'Assembler' },
      { key: 'Alt_Steel_Rotor',  display: 'Steel Rotor',  machine: 'Assembler' },
    ],
    'Modular Frame': [
      { key: 'Alt_Bolted_Frame',  display: 'Bolted Frame',  machine: 'Assembler' },
      { key: 'Alt_Steeled_Frame', display: 'Steeled Frame', machine: 'Assembler' },
    ],
    'Smart Plating': [
      { key: 'Alt_Plastic_Smart_Plating', display: 'Plastic Smart Plating', machine: 'Manufacturer' },
    ],
  },
  'Copper': {
    'Copper Ingot': [
      { key: 'Alt_Copper_Alloy_Ingot',    display: 'Copper Alloy Ingot',    machine: 'Foundry'  },
      { key: 'Alt_Leached_Copper_Ingot',  display: 'Leached Copper Ingot',  machine: 'Refinery' },
      { key: 'Alt_Pure_Copper_Ingot',     display: 'Pure Copper Ingot',     machine: 'Refinery' },
      { key: 'Alt_Tempered_Copper_Ingot', display: 'Tempered Copper Ingot', machine: 'Foundry'  },
    ],
    'Copper Sheet': [
      { key: 'Alt_Steamed_Copper_Sheet', display: 'Steamed Copper Sheet', machine: 'Refinery' },
    ],
    'Wire': [
      { key: 'Alt_Caterium_Wire', display: 'Caterium Wire', machine: 'Constructor' },
      { key: 'Alt_Fused_Wire',    display: 'Fused Wire',    machine: 'Assembler'   },
      { key: 'Alt_Iron_Wire',     display: 'Iron Wire',     machine: 'Constructor' },
    ],
    'AI Limiter': [
      { key: 'Alt_Plastic_AI_Limiter', display: 'Plastic AI Limiter', machine: 'Assembler' },
    ],
    'High-Speed Connector': [
      { key: 'Alt_Silicon_High_Speed_Connector', display: 'Silicon High-Speed Connector', machine: 'Manufacturer' },
    ],
    'Automated Wiring': [
      { key: 'Alt_Automated_Speed_Wiring', display: 'Automated Speed Wiring', machine: 'Manufacturer' },
    ],
    'Electromagnetic Control Rod': [
      { key: 'Alt_Electromagnetic_Connection_Rod', display: 'Electromagnetic Connection Rod', machine: 'Assembler' },
    ],
  },
  'Caterium': {
    'Caterium Ingot': [
      { key: 'Alt_Leached_Caterium_Ingot',  display: 'Leached Caterium Ingot',  machine: 'Refinery' },
      { key: 'Alt_Pure_Caterium_Ingot',     display: 'Pure Caterium Ingot',     machine: 'Refinery' },
      { key: 'Alt_Tempered_Caterium_Ingot', display: 'Tempered Caterium Ingot', machine: 'Foundry'  },
    ],
    'Quickwire': [
      { key: 'Alt_Fused_Quickwire', display: 'Fused Quickwire', machine: 'Assembler' },
    ],
  },
  'Steel': {
    'Steel Ingot': [
      { key: 'Alt_Coke_Steel_Ingot',      display: 'Coke Steel Ingot',      machine: 'Foundry' },
      { key: 'Alt_Compacted_Steel_Ingot', display: 'Compacted Steel Ingot', machine: 'Foundry' },
      { key: 'Alt_Solid_Steel_Ingot',     display: 'Solid Steel Ingot',     machine: 'Foundry' },
    ],
    'Steel Beam': [
      { key: 'Alt_Aluminum_Beam', display: 'Aluminum Beam', machine: 'Constructor' },
      { key: 'Alt_Molded_Beam',   display: 'Molded Beam',   machine: 'Foundry'     },
    ],
    'Steel Pipe': [
      { key: 'Alt_Iron_Pipe',          display: 'Iron Pipe',          machine: 'Constructor' },
      { key: 'Alt_Molded_Steel_Pipe',  display: 'Molded Steel Pipe',  machine: 'Foundry'     },
    ],
    'Encased Industrial Beam': [
      { key: 'Alt_Encased_Industrial_Pipe', display: 'Encased Industrial Pipe', machine: 'Assembler' },
    ],
    'Stator': [
      { key: 'Alt_Quickwire_Stator', display: 'Quickwire Stator', machine: 'Assembler' },
    ],
    'Motor': [
      { key: 'Alt_Electric_Motor', display: 'Electric Motor', machine: 'Assembler'    },
      { key: 'Alt_Rigor_Motor',    display: 'Rigor Motor',    machine: 'Manufacturer' },
    ],
    'Versatile Framework': [
      { key: 'Alt_Flexible_Framework', display: 'Flexible Framework', machine: 'Manufacturer' },
    ],
    'Heavy Modular Frame': [
      { key: 'Alt_Heavy_Encased_Frame',  display: 'Heavy Encased Frame',  machine: 'Manufacturer' },
      { key: 'Alt_Heavy_Flexible_Frame', display: 'Heavy Flexible Frame', machine: 'Manufacturer' },
    ],
    'Turbo Motor': [
      { key: 'Alt_Turbo_Electric_Motor', display: 'Turbo Electric Motor', machine: 'Manufacturer' },
      { key: 'Alt_Turbo_Pressure_Motor', display: 'Turbo Pressure Motor', machine: 'Manufacturer' },
    ],
    'Fused Modular Frame': [
      { key: 'Alt_Heat_Fused_Frame', display: 'Heat-Fused Frame', machine: 'Blender' },
    ],
  },
  'Oil': {
    'Heavy Oil Residue': [
      { key: 'Alt_Heavy_Oil_Residue', display: 'Heavy Oil Residue', machine: 'Refinery' },
    ],
    'Polymer Resin': [
      { key: 'Alt_Polymer_Resin', display: 'Polymer Resin', machine: 'Refinery' },
    ],
    'Plastic': [
      { key: 'Alt_Recycled_Plastic', display: 'Recycled Plastic', machine: 'Refinery' },
    ],
    'Rubber': [
      { key: 'Alt_Recycled_Rubber', display: 'Recycled Rubber', machine: 'Refinery' },
    ],
    'Fabric': [
      { key: 'Alt_Polyester_Fabric', display: 'Polyester Fabric', machine: 'Refinery' },
    ],
    'Cable': [
      { key: 'Alt_Coated_Cable',    display: 'Coated Cable',    machine: 'Refinery'  },
      { key: 'Alt_Insulated_Cable', display: 'Insulated Cable', machine: 'Assembler' },
      { key: 'Alt_Quickwire_Cable', display: 'Quickwire Cable', machine: 'Assembler' },
    ],
    'Empty Canister': [
      { key: 'Alt_Coated_Iron_Canister', display: 'Coated Iron Canister', machine: 'Assembler'  },
      { key: 'Alt_Steel_Canister',       display: 'Steel Canister',       machine: 'Constructor' },
    ],
    'Circuit Board': [
      { key: 'Alt_Caterium_Circuit_Board',  display: 'Caterium Circuit Board',  machine: 'Assembler' },
      { key: 'Alt_Electrode_Circuit_Board', display: 'Electrode Circuit Board', machine: 'Assembler' },
      { key: 'Alt_Silicon_Circuit_Board',   display: 'Silicon Circuit Board',   machine: 'Assembler' },
    ],
    'Computer': [
      { key: 'Alt_Caterium_Computer', display: 'Caterium Computer', machine: 'Manufacturer' },
      { key: 'Alt_Crystal_Computer',  display: 'Crystal Computer',  machine: 'Assembler'    },
    ],
    'Supercomputer': [
      { key: 'Alt_OC_Supercomputer',     display: 'OC Supercomputer',     machine: 'Assembler'    },
      { key: 'Alt_Super_State_Computer', display: 'Super-State Computer', machine: 'Manufacturer' },
    ],
    'Fuel': [
      { key: 'Alt_Diluted_Fuel',          display: 'Diluted Fuel',          machine: 'Blender'  },
      { key: 'Alt_Diluted_Packaged_Fuel', display: 'Diluted Packaged Fuel', machine: 'Refinery' },
    ],
    'Turbofuel': [
      { key: 'Alt_Turbo_Blend_Fuel', display: 'Turbo Blend Fuel', machine: 'Blender'  },
      { key: 'Alt_Turbo_Heavy_Fuel', display: 'Turbo Heavy Fuel', machine: 'Refinery' },
    ],
    'Rocket Fuel': [
      { key: 'Alt_Nitro_Rocket_Fuel', display: 'Nitro Rocket Fuel', machine: 'Blender' },
    ],
    'Ionized Fuel': [
      { key: 'Alt_Dark_Ion_Fuel', display: 'Dark-Ion Fuel', machine: 'Converter' },
    ],
  },
  'Sulfur': {
    'Compacted Coal': [
      { key: 'Alt_Compacted_Coal', display: 'Compacted Coal', machine: 'Assembler' },
    ],
    'Black Powder': [
      { key: 'Alt_Fine_Black_Powder', display: 'Fine Black Powder', machine: 'Assembler' },
    ],
  },
  'Quartz': {
    'Quartz Crystal': [
      { key: 'Alt_Fused_Quartz_Crystal', display: 'Fused Quartz Crystal', machine: 'Foundry'  },
      { key: 'Alt_Pure_Quartz_Crystal',  display: 'Pure Quartz Crystal',  machine: 'Refinery' },
      { key: 'Alt_Quartz_Purification',  display: 'Quartz Purification',  machine: 'Refinery' },
    ],
    'Silica': [
      { key: 'Alt_Cheap_Silica',     display: 'Cheap Silica',     machine: 'Assembler' },
      { key: 'Alt_Distilled_Silica', display: 'Distilled Silica', machine: 'Blender'   },
    ],
    'Crystal Oscillator': [
      { key: 'Alt_Insulated_Crystal_Oscillator', display: 'Insulated Crystal Oscillator', machine: 'Manufacturer' },
    ],
  },
  'Aluminum': {
    'Alumina Solution': [
      { key: 'Alt_Sloppy_Alumina', display: 'Sloppy Alumina', machine: 'Refinery' },
    ],
    'Aluminum Scrap': [
      { key: 'Alt_Electrode_Aluminum_Scrap', display: 'Electrode Aluminum Scrap', machine: 'Refinery' },
      { key: 'Alt_Instant_Scrap',            display: 'Instant Scrap',            machine: 'Blender'  },
    ],
    'Aluminum Ingot': [
      { key: 'Alt_Pure_Aluminum_Ingot', display: 'Pure Aluminum Ingot', machine: 'Smelter' },
    ],
    'Aluminum Casing': [
      { key: 'Alt_Alclad_Casing', display: 'Alclad Casing', machine: 'Assembler' },
    ],
    'Heat Sink': [
      { key: 'Alt_Heat_Exchanger', display: 'Heat Exchanger', machine: 'Assembler' },
    ],
    'Cooling System': [
      { key: 'Alt_Cooling_Device', display: 'Cooling Device', machine: 'Blender' },
    ],
    'Battery': [
      { key: 'Alt_Classic_Battery', display: 'Classic Battery', machine: 'Manufacturer' },
    ],
    'Lightweight Frame': [
      { key: 'Alt_Radio_Connection_Unit', display: 'Radio Connection Unit', machine: 'Manufacturer' },
      { key: 'Alt_Radio_Control_System',  display: 'Radio Control System',  machine: 'Manufacturer' },
    ],
  },
  'Uranium': {
    'Encased Uranium Cell': [
      { key: 'Alt_Infused_Uranium_Cell', display: 'Infused Uranium Cell', machine: 'Manufacturer' },
    ],
    'Non-Fissile Uranium': [
      { key: 'Alt_Fertile_Uranium', display: 'Fertile Uranium', machine: 'Blender' },
    ],
    'Uranium Fuel Rod': [
      { key: 'Alt_Uranium_Fuel_Unit', display: 'Uranium Fuel Unit', machine: 'Manufacturer' },
    ],
    'Encased Plutonium Cell': [
      { key: 'Alt_Instant_Plutonium_Cell', display: 'Instant Plutonium Cell', machine: 'Particle_Accelerator' },
    ],
    'Plutonium Fuel Rod': [
      { key: 'Alt_Plutonium_Fuel_Unit', display: 'Plutonium Fuel Unit', machine: 'Assembler' },
    ],
  },
  'SAM': {
    'Diamonds': [
      { key: 'Alt_Cloudy_Diamonds',    display: 'Cloudy Diamonds',    machine: 'Particle_Accelerator' },
      { key: 'Alt_Oil_Based_Diamonds', display: 'Oil-Based Diamonds', machine: 'Particle_Accelerator' },
      { key: 'Alt_Petroleum_Diamonds', display: 'Petroleum Diamonds', machine: 'Particle_Accelerator' },
      { key: 'Alt_Pink_Diamonds',      display: 'Pink Diamonds',      machine: 'Converter'            },
      { key: 'Alt_Turbo_Diamonds',     display: 'Turbo Diamonds',     machine: 'Particle_Accelerator' },
    ],
    'Dark Matter Crystal': [
      { key: 'Alt_Dark_Matter_Crystallization', display: 'Dark Matter Crystallization', machine: 'Particle_Accelerator' },
      { key: 'Alt_Dark_Matter_Trap',            display: 'Dark Matter Trap',            machine: 'Particle_Accelerator' },
    ],
  },
  'Limestone': {
    'Concrete': [
      { key: 'Alt_Fine_Concrete',   display: 'Fine Concrete',   machine: 'Assembler' },
      { key: 'Alt_Rubber_Concrete', display: 'Rubber Concrete', machine: 'Assembler' },
      { key: 'Alt_Wet_Concrete',    display: 'Wet Concrete',    machine: 'Refinery'  },
    ],
  },
  'Biomass': {
    'Coal': [
      { key: 'Alt_Biocoal',  display: 'Biocoal',  machine: 'Constructor' },
      { key: 'Alt_Charcoal', display: 'Charcoal', machine: 'Constructor' },
    ],
    'Portable Miner': [
      { key: 'Alt_Automated_Miner', display: 'Automated Miner', machine: 'Assembler' },
    ],
  },
};

// ── Open/closed state across renders ──────────────────────
const _catOpen  = {};   // { familyLabel: bool }  — default open
const _itemOpen = {};   // { itemLabel: bool }     — default closed
let _altSearch = '';

// ── Render ────────────────────────────────────────────────
export function renderAlts() {
  const p  = document.getElementById('altspanel');

  // ── Search bar — create once, update in place on re-renders ──
  let searchInp = p.querySelector('.alts-search-inp');
  let clearBtn  = p.querySelector('.alts-search-clear');
  let listEl    = p.querySelector('.alts-list');

  if (!searchInp) {
    p.innerHTML = '';

    // ── Unlocked-alts management bar (created once) ──────────
    const mgmtBar = document.createElement('div');
    mgmtBar.style.cssText =
      'display:flex;align-items:center;gap:6px;margin-bottom:8px;' +
      'padding:6px 8px;background:var(--p3);border:1px solid var(--b);border-radius:var(--rsm)';
    mgmtBar.innerHTML =
      '<span style="font-size:13px">🔑</span>' +
      '<span style="font-size:11px;font-weight:600;color:var(--t);flex:1">Hard Drive Unlocks</span>';
    const mgmtBtn = document.createElement('button');
    mgmtBtn.className = 'bsm';
    mgmtBtn.textContent = '📖 Manage';
    mgmtBtn.style.cssText = 'font-size:10px;flex-shrink:0;white-space:nowrap';
    mgmtBtn.addEventListener('click', openUnlockedModal);
    mgmtBar.appendChild(mgmtBtn);
    p.appendChild(mgmtBar);

    const searchWrap = document.createElement('div');
    searchWrap.style.cssText = 'position:relative;margin-bottom:8px';

    searchInp = document.createElement('input');
    searchInp.type        = 'text';
    searchInp.placeholder = 'Search recipes or items…';
    searchInp.className   = 'alts-search-inp';
    searchInp.value       = _altSearch;
    searchInp.style.cssText = [
      'width:100%', 'box-sizing:border-box', 'padding:4px 26px 4px 8px',
      'background:var(--p3)', 'border:1px solid var(--b)', 'border-radius:var(--rsm)',
      'color:var(--t)', 'font-size:11px', 'font-family:var(--font)', 'outline:none',
    ].join(';');
    searchInp.addEventListener('focus', () => { searchInp.style.borderColor = 'var(--acc)'; });
    searchInp.addEventListener('blur',  () => { searchInp.style.borderColor = 'var(--b)'; });
    searchInp.addEventListener('input', () => {
      _altSearch = searchInp.value;
      clearBtn.style.display = _altSearch ? 'block' : 'none';
      _renderAltsList(listEl);
    });

    clearBtn = document.createElement('button');
    clearBtn.className   = 'alts-search-clear';
    clearBtn.textContent = '✕';
    clearBtn.style.cssText = [
      'position:absolute', 'right:5px', 'top:50%', 'transform:translateY(-50%)',
      'background:none', 'border:none', 'color:var(--t3)', 'cursor:pointer',
      'font-size:11px', 'padding:0', 'line-height:1',
      'display:' + (_altSearch ? 'block' : 'none'),
    ].join(';');
    clearBtn.addEventListener('click', () => {
      _altSearch = '';
      searchInp.value = '';
      clearBtn.style.display = 'none';
      searchInp.focus();
      _renderAltsList(listEl);
    });

    searchWrap.appendChild(searchInp);
    searchWrap.appendChild(clearBtn);
    p.appendChild(searchWrap);

    listEl = document.createElement('div');
    listEl.className = 'alts-list';
    p.appendChild(listEl);
  }

  _renderAltsList(listEl);
}

function _renderAltsList(listEl) {
  listEl.innerHTML = '';
  const en = new Set(SC.alternate_recipes_enabled || []);

  const q        = _altSearch.trim().toLowerCase();
  const searching = !!q;
  let anyVisible  = false;

  // ── Family loop ─────────────────────────────────────────
  Object.entries(ALT_TREE).forEach(([family, items]) => {
    // Filter items/recipes by search query
    // Already hard-drive-unlocked alts are always available to the solver
    // (see solver.py: unlocked_set bypasses the enabled-check), so there's
    // nothing to "select" for them here — drop them from the picker.
    const filteredItems = {};
    Object.entries(items).forEach(([iName, alts]) => {
      const selectableAlts = alts.filter(a => !_isUnlocked(a.key));
      if (!selectableAlts.length) return;
      const matchItem   = iName.toLowerCase().includes(q);
      const matchedAlts = searching
        ? (matchItem ? selectableAlts : selectableAlts.filter(a => a.display.toLowerCase().includes(q)))
        : selectableAlts;
      if (!searching || matchedAlts.length) filteredItems[iName] = matchedAlts;
    });
    if (!Object.keys(filteredItems).length) return;
    anyVisible = true;

    const catKeys    = Object.values(filteredItems).flat().map(a => a.key);
    const catEnabled = catKeys.filter(k => en.has(k)).length;
    const catAllOn   = catEnabled === catKeys.length;
    const isOpen     = searching || !!_catOpen[family];  // default closed

    // ── Family header row ──────────────────────────────────
    const catRow = document.createElement('div');
    catRow.style.cssText =
      'display:flex;align-items:center;gap:5px;margin:4px 0 2px;cursor:pointer;user-select:none';

    const catChev = document.createElement('span');
    catChev.style.cssText = 'font-size:9px;color:var(--t3);width:12px;flex-shrink:0';
    catChev.textContent = isOpen ? '▼' : '▶';

    const catToggle = document.createElement('button');
    catToggle.className     = 'bsm' + (catAllOn ? ' act' : '');
    catToggle.style.cssText = 'font-size:10px;padding:1px 5px;min-width:20px;flex-shrink:0';
    catToggle.textContent   = catAllOn ? '✓' : '○';
    catToggle.title         = (catAllOn ? 'Disable all in ' : 'Enable all in ') + family;
    catToggle.addEventListener('click', e => {
      e.stopPropagation();
      catAllOn ? catKeys.forEach(k => en.delete(k)) : catKeys.forEach(k => en.add(k));
      SC.alternate_recipes_enabled = [...en];
      renderAlts();
      updAltBadge();
    });

    const catLabel = document.createElement('span');
    catLabel.style.cssText = 'font-size:12px;font-weight:700;color:var(--t);flex:1';
    catLabel.textContent = family;

    const catBadge = document.createElement('span');
    catBadge.style.cssText = 'font-size:10px;color:var(--t3);font-family:var(--mono)';
    catBadge.textContent = catEnabled ? `${catEnabled}/${catKeys.length}` : `${catKeys.length}`;

    catRow.appendChild(catChev);
    catRow.appendChild(catToggle);
    catRow.appendChild(catLabel);
    catRow.appendChild(catBadge);
    listEl.appendChild(catRow);

    const catBody = document.createElement('div');
    catBody.style.cssText = 'overflow:hidden;' + (isOpen ? '' : 'display:none');
    listEl.appendChild(catBody);

    catRow.addEventListener('click', () => {
      const nowOpen = catBody.style.display === 'none';
      _catOpen[family]       = nowOpen;
      catBody.style.display  = nowOpen ? '' : 'none';
      catChev.textContent    = nowOpen ? '▼' : '▶';
    });

    // ── Item rows ──────────────────────────────────────────
    Object.entries(filteredItems).forEach(([iName, alts]) => {
      const itemKeys    = alts.map(a => a.key);
      const itemEnabled = itemKeys.filter(k => en.has(k)).length;
      const itemAllOn   = itemEnabled === itemKeys.length;
      const iOpen       = searching || !!_itemOpen[iName];  // default closed

      const itemRow = document.createElement('div');
      itemRow.style.cssText =
        'display:flex;align-items:center;gap:4px;margin:2px 0 1px;' +
        'padding-left:14px;cursor:pointer;user-select:none';

      const itemChev = document.createElement('span');
      itemChev.style.cssText = 'font-size:8px;color:var(--t3);width:10px;flex-shrink:0';
      itemChev.textContent = iOpen ? '▾' : '▸';

      const itemToggle = document.createElement('button');
      itemToggle.className     = 'bsm' + (itemAllOn ? ' act' : '');
      itemToggle.style.cssText = 'font-size:9px;padding:1px 4px;min-width:18px;flex-shrink:0';
      itemToggle.textContent   = itemAllOn ? '✓' : '○';
      itemToggle.title         = (itemAllOn ? 'Disable all for ' : 'Enable all for ') + iName;
      itemToggle.addEventListener('click', e => {
        e.stopPropagation();
        itemAllOn ? itemKeys.forEach(k => en.delete(k)) : itemKeys.forEach(k => en.add(k));
        SC.alternate_recipes_enabled = [...en];
        renderAlts();
        updAltBadge();
      });

      const itemLabel = document.createElement('span');
      itemLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--t2);flex:1';
      if (q && iName.toLowerCase().includes(q)) {
        const idx = iName.toLowerCase().indexOf(q);
        itemLabel.innerHTML =
          iName.slice(0, idx) +
          `<mark style="background:var(--acc-glow);color:var(--acc);border-radius:2px">${iName.slice(idx, idx + q.length)}</mark>` +
          iName.slice(idx + q.length);
      } else {
        itemLabel.textContent = iName;
      }

      const itemBadge = document.createElement('span');
      itemBadge.style.cssText = 'font-size:10px;color:var(--t3);font-family:var(--mono)';
      itemBadge.textContent = itemEnabled ? `${itemEnabled}/${itemKeys.length}` : `${itemKeys.length}`;

      itemRow.appendChild(itemChev);
      itemRow.appendChild(itemToggle);
      itemRow.appendChild(itemLabel);
      itemRow.appendChild(itemBadge);
      catBody.appendChild(itemRow);

      const itemBody = document.createElement('div');
      itemBody.style.cssText = 'overflow:hidden;' + (iOpen ? '' : 'display:none');
      catBody.appendChild(itemBody);

      itemRow.addEventListener('click', () => {
        const nowOpen = itemBody.style.display === 'none';
        _itemOpen[iName]      = nowOpen;
        itemBody.style.display = nowOpen ? '' : 'none';
        itemChev.textContent   = nowOpen ? '▾' : '▸';
      });

      // ── Recipe chips ──────────────────────────────────────
      // Note: alts here already excludes hard-drive-unlocked recipes
      // (filtered out above), since those are always available to the
      // solver regardless of this toggle.
      alts.forEach(alt => {
        const on   = en.has(alt.key);
        const chip = document.createElement('div');
        chip.className       = 'altc' + (on ? ' act' : '');
        chip.style.marginLeft = '26px';

        const dot = document.createElement('div');
        dot.className = 'altdot';
        if (on) dot.style.background = 'var(--acc)';

        const nameEl = document.createElement('div');
        nameEl.className = 'altn';
        if (q && alt.display.toLowerCase().includes(q)) {
          const idx = alt.display.toLowerCase().indexOf(q);
          nameEl.innerHTML =
            alt.display.slice(0, idx) +
            `<mark style="background:var(--acc-glow);color:var(--acc);border-radius:2px">${alt.display.slice(idx, idx + q.length)}</mark>` +
            alt.display.slice(idx + q.length);
        } else {
          nameEl.textContent = alt.display;
        }

        const mach = document.createElement('div');
        mach.className   = 'altm';
        mach.textContent = alt.machine.replace(/_/g, ' ');

        chip.appendChild(dot);
        chip.appendChild(nameEl);
        chip.appendChild(mach);
        chip.addEventListener('click', () => {
          on ? en.delete(alt.key) : en.add(alt.key);
          SC.alternate_recipes_enabled = [...en];
          renderAlts();
          updAltBadge();
        });
        itemBody.appendChild(chip);
      });
    });
  });

  if (!anyVisible) {
    const none = document.createElement('div');
    none.style.cssText = 'font-size:11px;color:var(--t3);text-align:center;padding:16px 0';
    none.textContent = 'No matching recipes';
    listEl.appendChild(none);
  }

  updAltBadge();
}

// ══════════════════════════════════════════════════════════
// MANAGE UNLOCKED ALTS MODAL
// ══════════════════════════════════════════════════════════

function _buildUnlockedModal() {
  const modal = document.createElement('div');
  modal.id = 'unlocked-modal';
  modal.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);' +
    'display:none;align-items:center;justify-content:center;' +
    'padding:16px;box-sizing:border-box';

  const box = document.createElement('div');
  box.style.cssText =
    'background:var(--p2);border:1px solid var(--b);border-radius:var(--r);' +
    'width:min(520px,100%);max-height:90vh;display:flex;flex-direction:column;' +
    'box-shadow:0 24px 64px rgba(0,0,0,.6)';

  // Header
  const hdr = document.createElement('div');
  hdr.style.cssText =
    'display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--b);flex-shrink:0';
  hdr.innerHTML =
    '<span style="font-size:12px;font-weight:700;color:var(--t);flex:1">🔑 Unlocked Alt Recipes</span>';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'bsm';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', closeUnlockedModal);
  hdr.appendChild(closeBtn);
  box.appendChild(hdr);

  // Search
  const sWrap = document.createElement('div');
  sWrap.style.cssText = 'padding:8px 16px;flex-shrink:0';
  const sInp = document.createElement('input');
  sInp.type = 'text';
  sInp.placeholder = 'Filter recipes...';
  sInp.id = 'unlocked-modal-search';
  sInp.style.cssText =
    'width:100%;box-sizing:border-box;padding:4px 8px;' +
    'background:var(--p3);border:1px solid var(--b);border-radius:var(--rsm);' +
    'color:var(--t);font-size:11px;font-family:var(--font);outline:none';
  sInp.addEventListener('input', () => _renderUnlockedList(sInp.value));
  sWrap.appendChild(sInp);
  box.appendChild(sWrap);

  // List body
  const bodyEl = document.createElement('div');
  bodyEl.id = 'unlocked-modal-body';
  bodyEl.style.cssText = 'overflow-y:auto;flex:1;padding:0 16px 8px';
  box.appendChild(bodyEl);

  // Footer
  const ftr = document.createElement('div');
  ftr.style.cssText =
    'display:flex;gap:6px;justify-content:flex-end;align-items:center;' +
    'padding:10px 16px;border-top:1px solid var(--b);flex-shrink:0';
  const countEl = document.createElement('span');
  countEl.id = 'unlocked-modal-count';
  countEl.style.cssText = 'font-size:11px;color:var(--t3);flex:1';
  const saveBtn = document.createElement('button');
  saveBtn.id = 'unlocked-modal-save';
  saveBtn.className = 'bsm act';
  saveBtn.textContent = 'Save Unlocks';
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      const keys = [..._unlockedAlts];
      await _saveUnlockedFn(keys);
      // Rebuild alts panel so chip states update
      const altspanel = document.getElementById('altspanel');
      if (altspanel) altspanel.innerHTML = '';
      renderAlts();
      saveBtn.textContent = 'Saved!';
      setTimeout(closeUnlockedModal, 600);
    } catch (err) {
      saveBtn.textContent = 'Error — retry';
      saveBtn.disabled = false;
    }
  });
  ftr.appendChild(countEl);
  ftr.appendChild(saveBtn);
  box.appendChild(ftr);

  modal.appendChild(box);
  modal.addEventListener('click', e => { if (e.target === modal) closeUnlockedModal(); });
  document.body.appendChild(modal);
  return modal;
}

function _renderUnlockedList(query) {
  query = query || '';
  const bodyEl  = document.getElementById('unlocked-modal-body');
  const countEl = document.getElementById('unlocked-modal-count');
  if (!bodyEl) return;
  bodyEl.innerHTML = '';
  const q = query.trim().toLowerCase();
  let total = 0, unlockedCount = 0;

  Object.entries(ALT_TREE).forEach(function(famEntry) {
    const family = famEntry[0];
    const items  = famEntry[1];
    const filtered = {};
    Object.entries(items).forEach(function(itemEntry) {
      const iName = itemEntry[0];
      const alts  = itemEntry[1];
      const matchItem = iName.toLowerCase().indexOf(q) >= 0;
      const matched = q ? (matchItem ? alts : alts.filter(function(a) { return a.display.toLowerCase().indexOf(q) >= 0; })) : alts;
      if (matched.length) filtered[iName] = matched;
    });
    if (!Object.keys(filtered).length) return;

    const famHdr = document.createElement('div');
    famHdr.style.cssText =
      'font-size:10px;font-weight:700;color:var(--t2);margin:10px 0 4px;' +
      'text-transform:uppercase;letter-spacing:.08em';
    famHdr.textContent = family;
    bodyEl.appendChild(famHdr);

    Object.entries(filtered).forEach(function(filtEntry) {
      const iName = filtEntry[0];
      const alts  = filtEntry[1];
      const iHdr = document.createElement('div');
      iHdr.style.cssText = 'font-size:11px;color:var(--t3);margin:4px 0 2px;padding-left:4px';
      iHdr.textContent = iName;
      bodyEl.appendChild(iHdr);

      alts.forEach(function(alt) {
        total++;
        const on = _isUnlocked(alt.key);
        if (on) unlockedCount++;

        const row = document.createElement('div');
        row.style.cssText =
          'display:flex;align-items:center;gap:7px;' +
          'padding:5px 8px;margin:2px 0;border-radius:var(--rsm);' +
          'cursor:pointer;user-select:none;' +
          (on ? 'background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.35)'
              : 'background:var(--p3);border:1px solid var(--b)');

        const chk = document.createElement('div');
        chk.style.cssText =
          'width:14px;height:14px;border-radius:3px;flex-shrink:0;' +
          'border:1px solid;display:flex;align-items:center;justify-content:center;' +
          'font-size:10px;font-weight:700;' +
          (on ? 'background:rgba(245,158,11,.85);border-color:rgba(245,158,11,.85);color:#000'
              : 'background:var(--p2);border-color:var(--b2);color:transparent');
        chk.textContent = 'v'; // checkmark via font

        const lbl = document.createElement('div');
        lbl.style.cssText = 'flex:1';
        lbl.innerHTML =
          '<span style="font-size:11px;color:' + (on ? 'rgba(245,158,11,.95)' : 'var(--t)') + '">' + alt.display + '</span>' +
          '<span style="font-size:10px;color:var(--t3);margin-left:6px">' + alt.machine.replace(/_/g, ' ') + '</span>';

        row.appendChild(chk);
        row.appendChild(lbl);
        row.addEventListener('click', function() {
          _toggleUnlocked(alt.key);
          _renderUnlockedList(query);
        });
        bodyEl.appendChild(row);
      });
    });
  });

  if (countEl) countEl.textContent = unlockedCount + ' / ' + total + ' unlocked';
}

export function openUnlockedModal() {
  let modal = document.getElementById('unlocked-modal');
  if (!modal) modal = _buildUnlockedModal();
  modal.style.display = 'flex';
  const sInp = document.getElementById('unlocked-modal-search');
  if (sInp) sInp.value = '';
  _renderUnlockedList('');
}

export function closeUnlockedModal() {
  const modal = document.getElementById('unlocked-modal');
  if (modal) modal.style.display = 'none';
}


export function updAltBadge() {
  const el = document.getElementById('ab');
  if (!el) return;
  let total = 0, enabled = 0;
  const en = new Set(SC.alternate_recipes_enabled || []);
  Object.entries(RECIPES).forEach(([key, r]) => {
    if (!r.alternate) return;
    total++;
    if (en.has(key)) enabled++;
  });
  el.textContent = `${enabled}/${total}`;
}

export function altsAll() {
  SC.alternate_recipes_enabled = Object.entries(RECIPES)
    .filter(([, r]) => r.alternate).map(([k]) => k);
  renderAlts();
  updAltBadge();
}

export function altsNone() {
  SC.alternate_recipes_enabled = [];
  renderAlts();
  updAltBadge();
}
