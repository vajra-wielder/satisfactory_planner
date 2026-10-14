/**
 * unlocks.js — the Unlocks window (machines, miner, unlocked alternates), the
 * Alternates tab (what's worth unlocking), and reading a game save.
 *
 * Owns:
 *   - renderMachines / updMachBadge
 *   - the Manage unlocked alternates window (hard drives, for every factory)
 *   - ALT_TREE (fully hardcoded, computed offline)
 */
import { SC, RECIPES, mCol, MABBR, itemName, MTIERS, ALL_MACHINES, MINER_TIERS, PROGRESS, TRANSPORT, UNLOCKED_ALTS, isUnlocked, toggleUnlocked, setUnlockedAlts as setStateAlts, UNLOCKS, saveProgress, RESULT, saveUnlockedAlts, fetchUnlockedAlts, unlockName } from './state.js';
import { setBadge, dockTab } from './nav.js';

// ── Unlock state: the one list, in state.js — this window, the Alternates
// tab's Unlock ticked and reading a save all change the same set ─
let _saveUnlockedFn = async () => {};

export function setUnlockedSaver(fn)  { _saveUnlockedFn  = fn; }
export function setUnlockedAlts(keys) { setStateAlts(keys); }
const _isUnlocked = isUnlocked, _toggleUnlocked = toggleUnlocked;

// ══════════════════════════════════════════════════════════
// MACHINES PANEL
// ══════════════════════════════════════════════════════════

export function renderMachines() {
  const p  = document.getElementById('machpanel');
  p.innerHTML = '';
  renderProgress(p);
  const en = new Set(PROGRESS.machines || ALL_MACHINES);

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
  renderMinerUnlock(p);
  renderBeltUnlock(p);
}

// ── Progress: the tier you've reached and its sub-tiers, and MAM research ──
// Only milestones and research that unlock a recipe or machine are listed
// (the rest don't change a plan). Picking a tier counts every sub-tier below
// it done and shows its own to tick; the machines follow. Not set: everything
// is allowed, as before.
function renderProgress(p) {
  const S = UNLOCKS.schematics, used = new Set([...Object.values(UNLOCKS.recipes), ...Object.values(UNLOCKS.machines)]);
  const ids = Object.keys(S).filter(id => used.has(id));
  if (!ids.length) return;
  const done = PROGRESS.schematics ? new Set(PROGRESS.schematics) : null;
  const ms = ids.filter(id => S[id].kind !== 'mam'), mam = ids.filter(id => S[id].kind === 'mam');
  const tiers = [...new Set(ms.map(id => S[id].tier))].sort((a, b) => a - b);
  const reached = done ? Math.max(0, ...ms.filter(id => done.has(id)).map(id => S[id].tier)) : null;
  const wrap = document.createElement('div');
  wrap.className = 'pg';
  // what each lets you make: its recipes' products
  // (packing left out)
  const made = {}, count = {};
  Object.entries(UNLOCKS.recipes).forEach(([k, id]) => {
    const r = RECIPES[k], out = r && Object.keys(r.outputs)[0];
    if (!r || r.machine === 'Packager') return;
    (made[id] = made[id] || []).push([out, Object.keys(r.inputs)[0]]);
    count[out] = (count[out] || 0) + 1;
  });
  // two ways to the same thing: short, by what it's from — Hog Protein, Blue Shard, Mycelia Biomass
  const short = (o, i) => `${itemName(i).split(' ')[0]} ${itemName(o).split(' ').pop()}`;
  const makes = Object.fromEntries(Object.entries(made).map(([id, l]) => [id, new Set(l.map(([o, i]) =>
    count[o] > 1 && i ? short(o, i) : itemName(o)))]));
  const what = id => [...(makes[id] || [])].join(' · ');
  // a milestone: the machine it gives you, else its first products
  const gives = {};
  Object.entries(UNLOCKS.machines).forEach(([m, id]) => (gives[id] = gives[id] || []).push(m.replace(/_/g, ' ')));
  const brief = id => {
    if (gives[id]) return gives[id].join(' · ');
    const l = [...(makes[id] || [])];
    return l.length > 2 ? `${l.slice(0, 2).join(' · ')} +${l.length - 2}` : l.join(' · ') || S[id].name;
  };
  const chip = (id, label) => `<button class="mchip pg-c ${done?.has(id) ? 'on' : ''}" data-s="${id}"
    title="${S[id].name}${what(id) ? ` — makes ${what(id)}` : ''}">${label || S[id].name}</button>`;
  const trees = {};
  mam.filter(id => makes[id]).forEach(id => (trees[S[id].tree] = trees[S[id].tree] || []).push(id));
  wrap.innerHTML = `
    <div class="pg-h">Progress <span class="n-hint">${done ? `Tier ${reached} · ${ms.filter(id => done.has(id)).length} milestones, ${mam.filter(id => done.has(id)).length} research` : 'not set — every recipe allowed'}</span></div>
    <div class="pg-tiers">${tiers.map(t => `<button class="bsm pg-t ${reached === t ? 'act' : ''}" data-t="${t}" title="Tier ${t}: every sub-tier below it done">${t}</button>`).join('')}
      <button class="bsm pg-t ${done ? '' : 'act'}" data-t="none" title="Everything unlocked: every recipe and machine">All</button></div>
    ${done ? `<div class="pg-sub"><span class="n-hint">Tier ${reached}:</span>${ms.filter(id => S[id].tier === reached).map(id => chip(id, brief(id))).join('')}</div>
    <div class="pg-mam"><span class="n-hint">MAM</span>${Object.entries(trees).map(([t, l]) =>
      `<div class="pg-tree"><b>${t}</b><span>${l.map(id => chip(id, what(id))).join('')}</span></div>`).join('')}</div>` : ''}`;
  const save = sch => {
    // the machines follow: unlocked where their milestone is done (those no milestone unlocks stay)
    const on = new Set(sch || []), mm = UNLOCKS.machines;
    const machines = sch ? [...new Set([...(PROGRESS.machines || ALL_MACHINES).filter(m => !mm[m]), ...Object.keys(mm).filter(m => on.has(mm[m]))])].sort()
      : [...new Set([...(PROGRESS.machines || []), ...ALL_MACHINES])].sort();    // All: everything, machines too
    Object.assign(PROGRESS, { schematics: sch ? [...on].sort() : null, machines });
    SC.enabled_machines = [...(machines || [])];
    saveProgress({ schematics: PROGRESS.schematics, machines }).catch(() => {});
    renderMachines(); updMachBadge();
    document.dispatchEvent(new CustomEvent('progress-changed'));
  };
  wrap.querySelectorAll('.pg-t').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.t === 'none') return save(null);
    const t = +b.dataset.t;
    // below: all done; this tier: as ticked (all, the first time you reach it); above: none; MAM as it was
    const keep = done || new Set();
    const first = !ms.some(id => S[id].tier === t && keep.has(id));
    save([...ms.filter(id => S[id].tier < t || (S[id].tier === t && (first || keep.has(id)))), ...mam.filter(id => !done || keep.has(id))]);
  }));
  wrap.querySelectorAll('.pg-c').forEach(b => b.addEventListener('click', () => {
    const on = new Set(done || []);
    on.has(b.dataset.s) ? on.delete(b.dataset.s) : on.add(b.dataset.s);
    save([...on]);
  }));
  p.appendChild(wrap);
}

// Miner tier unlocked — for every factory; miners always run at the highest
function renderMinerUnlock(p) {
  const wrap = document.createElement('div');
  wrap.style.marginBottom = '8px';
  wrap.innerHTML = `<div style="font-size:10px;color:var(--t3);margin:2px 0 4px">Miner unlocked
    <span style="color:var(--t4)">— every factory mines at this tier</span></div>`;
  const chips = document.createElement('div');
  chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;padding-left:2px';
  Object.keys(MINER_TIERS).forEach(t => {
    const on = PROGRESS.miner === t, c = mCol('Miner');
    const chip = document.createElement('div');
    chip.className = 'mchip';
    chip.dataset.miner = t;
    chip.style.cssText = `border-color:${on ? c : 'var(--b)'};background:${on ? c + '22' : 'var(--p3)'};color:${on ? c : 'var(--t3)'}`;
    chip.textContent = `Miner ${t.replace('Mk', 'Mk.')} · ${MINER_TIERS[t]}/min`;
    chip.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('miner-changing', { detail: PROGRESS.miner }));
      PROGRESS.miner = t;
      saveProgress({ miner: t }).catch(() => {});
      renderMachines();
      document.dispatchEvent(new CustomEvent('progress-changed'));
    });
    chips.appendChild(chip);
  });
  wrap.appendChild(chips);
  p.appendChild(wrap);
}

// Belt tier unlocked: the splitters and mergers the find box draws keep to it
function renderBeltUnlock(p) {
  const wrap = document.createElement('div');
  wrap.style.marginBottom = '8px';
  wrap.innerHTML = `<div style="font-size:10px;color:var(--t3);margin:2px 0 4px">Belt unlocked
    <span style="color:var(--t4)">— inside factories; splits in the find box keep to it</span></div>`;
  const chips = document.createElement('div');
  chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;padding-left:2px';
  Object.entries(TRANSPORT.belts || {}).forEach(([t, cap]) => {
    const on = PROGRESS.belt === t, c = '#5aa0e8';
    const chip = document.createElement('div');
    chip.className = 'mchip';
    chip.dataset.belt = t;
    chip.style.cssText = `border-color:${on ? c : 'var(--b)'};background:${on ? c + '22' : 'var(--p3)'};color:${on ? c : 'var(--t3)'}`;
    chip.textContent = `${t.replace('Mk', 'Mk.')} · ${cap}/min`;
    chip.addEventListener('click', () => {
      PROGRESS.belt = t;
      saveProgress({ belt: t }).catch(() => {});
      renderMachines();
      document.dispatchEvent(new CustomEvent('progress-changed'));
    });
    chips.appendChild(chip);
  });
  wrap.appendChild(chips);
  p.appendChild(wrap);
}

// Persist enabled set back into SC and refresh
// Machines are unlocked once, for every factory
function _saveEnabledMachines(en) {
  PROGRESS.machines = [...en].sort();
  SC.enabled_machines = [...PROGRESS.machines];
  saveProgress({ machines: PROGRESS.machines }).catch(() => {});
  renderMachines();
  updMachBadge();
}

export function updMachBadge() {
  const el = document.getElementById('mb');
  const n = (PROGRESS.machines || ALL_MACHINES).filter(m => ALL_MACHINES.includes(m)).length;
  if (el) el.textContent = n === ALL_MACHINES.length ? 'All' : `${n}/${ALL_MACHINES.length}`;
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
  closeBtn.id = 'unlocked-modal-x';
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
      const keys = [...UNLOCKED_ALTS];
      await _saveUnlockedFn(keys);
      _before = null;                      // saved: nothing to put back
      document.dispatchEvent(new Event('unlocks-changed'));
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

        row.dataset.k = alt.key;
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

let _before = null;   // the unlocks when the window opened: closing without Save puts them back
export function openUnlockedModal() {
  _before = [...UNLOCKED_ALTS];
  let modal = document.getElementById('unlocked-modal');
  if (!modal) modal = _buildUnlockedModal();
  modal.style.display = 'flex';
  const sInp = document.getElementById('unlocked-modal-search');
  if (sInp) sInp.value = '';
  _renderUnlockedList('');
}

export function closeUnlockedModal() {
  if (_before) setStateAlts(_before);
  _before = null;
  const modal = document.getElementById('unlocked-modal');
  if (modal) modal.style.display = 'none';
}




// ══════════════════════════════════════════════════════════
// THE ALTERNATES TAB
// ══════════════════════════════════════════════════════════
/**
 * The Alternates tab: alternates worth unlocking, and how the
 * solver pruned the recipes.
 *
 * After each solve the server works out the best plan with every alternate
 * you haven't unlocked (solver.suggest_alts) and lists the ones it uses, in
 * the order to unlock them: each with what it adds on top of those above —
 * output, and the resources and space of the plan a solve then makes. Tick the ones to use
 * in this factory, untick the ones you don't want, then Solve — or unlock the
 * ticked ones (you found their hard drives): then every factory has them.
 */
const $ = id => document.getElementById(id);
const name = k => (RECIPES[k]?.display || k).replace(/^Alternate:\s*/i, '');
const pct = v => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;

// What a set of gains says, shortest first: "+106% output · +4,239 space" —
// each the plan a solve makes with them against today's; what gets worse
// (more space for more output) in amber
export function gainText(g, html = true) {
  if (!g) return '';
  const span = (t, c) => (html ? `<span style="color:${c}">${t}</span>` : t);
  const up = 'var(--warn)';
  const r = g.resources || 0, m = g.machines || 0;
  return [g.output > 0.1 ? span(`+${pct(g.output)} output`, 'var(--ok)') : '',
          r > 0.1 ? span(`−${pct(r)} resources`, 'var(--ok)') : r < -0.1 ? span(`+${pct(-r)} resources`, up) : '',
          m > 0.5 ? span(`−${Math.round(m).toLocaleString()} space`, '#60a5fa') : m < -0.5 ? span(`+${Math.round(-m).toLocaleString()} space`, up) : '']
    .filter(Boolean).join(html ? '<span class="na-dot"> · </span>' : ' · ');
}

let seq = 0, later = 0;
/** Ask for the last solve's suggestions, then draw them. */
export function refreshNewAlts(onChange) {
  const el = $('new-alts');
  if (!el) return;
  drawEverywhere();
  const res = RESULT;
  if (!res?.status?.startsWith('Optimal')) {
    el.innerHTML = '<div class="na-head"><b>New alternates</b></div><p class="n-hint">After a solve: the alternates you haven\'t unlocked that would make it better.</p>';
    setBadge('dkb-alts', '');
    drawPrune();
    return;
  }
  drawPrune();
  if (res.suggest) { draw(onChange); return; }
  const mine = ++seq;
  el.innerHTML = '<div class="na-head"><b>New alternates</b><span class="n-hint">checking…</span></div>';
  // the tab not open: asked once the solves settle, not after each one while you edit
  clearTimeout(later);
  if (dockTab() !== 'alts') { later = setTimeout(() => mine === seq && ask(), 1200); return; }
  ask();
  function ask() { fetch('/api/suggest-alts').then(r => r.json()).then(d => {
    if (mine !== seq || res !== RESULT) return;      // a newer solve took over
    res.suggest = d;
    draw(onChange);
    document.dispatchEvent(new Event('suggest-ready'));
  }).catch(() => { el.innerHTML = ''; }); }
}

function draw(onChange) {
  const el = $('new-alts'), d = RESULT?.suggest;
  if (!el || !d) return;
  setBadge('dkb-alts', d.steps?.length ? String(d.steps.length) : '', 'ok');
  const on = new Set(SC.alternate_recipes_enabled || []);
  const listed = new Set((d.steps || []).map(s => s.key));
  // on here, but neither suggested nor unlocked: still in the plan's recipes, so you can untick it
  const extra = [...on].filter(k => RECIPES[k]?.alternate && !listed.has(k) && !UNLOCKED_ALTS.has(k));
  if (!d.steps?.length && !extra.length) {
    el.innerHTML = `<div class="na-head"><b>New alternates</b></div>
      <p class="n-hint">None you haven't unlocked would help this factory — its recipes are as good as they get.</p>`;
    return;
  }
  const ticked = d.steps.filter(s => on.has(s.key));
  const planHas = new Set((RESULT.flows || []).map(f => f.recipe_key));
  const pending = [...d.steps.map(s => s.key), ...extra].some(k => on.has(k) !== planHas.has(k));
  const row = (k, i, gain) => {
    const r = RECIPES[k] || {}, c = mCol(r.machine);
    return `<label class="na-row" title="${name(k)}: tick to use it in this factory">
      <input type="checkbox" data-k="${k}" ${on.has(k) ? 'checked' : ''}/>
      <span class="na-i">${i}</span>
      <span class="na-m" style="background:${c}22;color:${c};border:1px solid ${c}44">${MABBR[r.machine] || r.machine || ''}</span>
      <span class="na-n">${name(k)}<br><span class="na-g">${gain}</span></span>
    </label>`;
  };
  el.innerHTML = `
    <div class="na-head"><b>New alternates</b><span class="n-hint">${ticked.length}/${d.steps.length} on here</span></div>
    ${d.steps.length ? `<p class="n-hint" style="margin:2px 0 6px">The best plan with alternates you haven't unlocked uses these — in the
      order to unlock them, each with what solving with it changes on top of the ones above. With all ${d.steps.length}:
      <b>${gainText(d.all)}</b>.</p>` : ''}
    ${d.steps.map((s, i) => row(s.key, i + 1, gainText(s) || '<span class="n-hint">rounds out the set</span>')).join('')}
    ${extra.map(k => row(k, '·', '<span class="n-hint">on here — the best plan doesn\'t use it</span>')).join('')}
    <div class="na-btns">
      ${d.steps.length ? `<button class="bsm" id="na-all">${ticked.length === d.steps.length ? 'Untick all' : 'Tick all'}</button>` : ''}
      <button class="bsm" id="na-unlock" ${ticked.length ? '' : 'disabled'}
        title="You've found their hard drives: unlock the ticked ones for every factory">🔓 Unlock ticked${ticked.length ? ` (${ticked.length})` : ''}</button>
      <button class="bsm ${pending ? 'act' : ''}" id="na-solve" ${pending ? '' : 'disabled'}
        title="${pending ? 'Solve with the ticked ones' : 'The plan already has these'}">${pending ? '▶ Solve with these' : 'Plan is up to date'}</button>
    </div>`;
  const set = (keys, yes) => {
    const s = new Set(SC.alternate_recipes_enabled || []);
    keys.forEach(k => (yes ? s.add(k) : s.delete(k)));
    SC.alternate_recipes_enabled = [...s];
    onChange?.();
    draw(onChange);
  };
  el.querySelectorAll('input[data-k]').forEach(b => b.addEventListener('change', () => set([b.dataset.k], b.checked)));
  $('na-all')?.addEventListener('click', () => set(d.steps.map(s => s.key), ticked.length !== d.steps.length));
  $('na-solve').addEventListener('click', () => $('bsolve').click());
  $('na-unlock').addEventListener('click', async e => {
    e.target.disabled = true; e.target.textContent = 'Unlocking…';
    try {
      // on top of what's unlocked — as saved, so nothing you unlocked elsewhere is lost
      const have = (await fetchUnlockedAlts()).unlocked || [];
      const keys = [...new Set([...have, ...UNLOCKED_ALTS, ...ticked.map(s => s.key)])];
      setUnlockedAlts((await saveUnlockedAlts(keys)).unlocked || keys);
      document.dispatchEvent(new Event('unlocks-changed'));
      $('bsolve').click();                 // with them unlocked: the plan, and what's left to suggest
    } catch (err) { e.target.textContent = 'Failed — retry'; e.target.disabled = false; }
  });
}


// Every alternate you haven't unlocked, by what it adds to all your saved
// factories as they are — each on its own, so the first is the hard drive
// worth most across the lot
// (the server keeps the answer until a factory, the unlocks or progress change)
let ALL_SEQ = 0, ALL_OPEN = false;
function drawEverywhere() {
  const el = $('alts-all');
  if (!el || dockTab() !== 'alts') return;     // drawn when the tab is open
  const mine = ++ALL_SEQ;
  fetch('/api/alts-everywhere').then(r => r.json()).then(d => {
    if (mine !== ALL_SEQ) return;
    const list = d.alts || [];
    const nm = k => d.names?.[k] || k;
    const pc = v => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;
    const row = (a, i) => {
      const r = RECIPES[a.key] || {}, c = mCol(r.machine);
      const gains = [...Object.entries(a.output).map(([f, v]) => `<span style="color:var(--ok)">+${pc(v)}</span> ${nm(f)}`),
                     ...Object.entries(a.resources).map(([f, v]) => `<span style="color:var(--ok)">−${pc(v)} resources</span> ${nm(f)}`)];
      return `<div class="na-row"><span class="na-i">${i + 1}</span>
        <span class="na-m" style="background:${c}22;color:${c};border:1px solid ${c}44">${MABBR[r.machine] || r.machine || ''}</span>
        <span class="na-n">${name(a.key)}<br><span class="na-g">${gains.join('<span class="na-dot"> · </span>')}</span></span></div>`;
    };
    const shown = ALL_OPEN ? list : list.slice(0, 6);
    el.innerHTML = `<div class="na-head"><b>Across all factories</b><span class="n-hint">${list.length ? 'each on its own' : ''}</span></div>
      ${list.length ? shown.map(row).join('') + (list.length > 6 ? `<button class="bsm" id="aa-more">${ALL_OPEN ? 'Fewer' : `All ${list.length}`}</button>` : '')
        : '<p class="n-hint">None you haven\'t unlocked would help a saved factory.</p>'}`;
    $('aa-more')?.addEventListener('click', () => { ALL_OPEN = !ALL_OPEN; drawEverywhere(); });
  }).catch(() => { el.innerHTML = ''; });
}

// How the solver narrowed the recipes down before solving: each step and what's left
function drawPrune() {
  const el = $('prune-box');
  if (!el) return;
  const p = RESULT?.prune, n = RESULT?.pruned_recipe_count;
  if (!RESULT || (!p?.total && !n)) {
    el.innerHTML = '<div class="na-head"><b style="color:var(--t2)">Solver pruning</b></div><p class="n-hint">After a solve: how far the recipes were narrowed down before solving.</p>';
    return;
  }
  const inPlan = new Set((RESULT.flows || []).map(f => f.recipe_key)).size;
  const steps = p?.total ? [
    ['Every recipe in the game', p.total, ''],
    ['Allowed by your unlocks', p.allowed, 'machines, and alternates unlocked or on here'],
    ['Makeable from your resources', p.fireable, 'forward: every input can be had'],
    ['On a path to your goals', p.needed, 'backward: an output something needs'],
    ['Into the solver', p.usable, 'pointless loops (pack ⇄ unpack) dropped'],
    ['In the plan', inPlan, 'what the optimum uses'],
  ] : [['Into the solver', n, ''], ['In the plan', inPlan, '']];
  const top = steps[0][1] || 1;
  const cut = p?.total ? 100 * (1 - p.usable / p.total) : null;
  el.innerHTML = `
    <div class="na-head"><b style="color:var(--t2)">Solver pruning</b><span class="n-hint">${
      [cut != null ? `${cut.toFixed(0)}% cut before solving` : '', RESULT.solve_s != null ? `solved in ${RESULT.solve_s < 1 ? `${Math.round(RESULT.solve_s * 1000)} ms` : `${RESULT.solve_s.toFixed(1)} s`}` : '']
      .filter(Boolean).join(' · ')}</span></div>
    ${steps.map(([label, v, how], i) => `<div class="pr-row" title="${how}">
      <span class="pr-l">${label}</span><span class="pr-v">${v}</span>
      <div class="pr-bar"><i style="width:${(100 * v / top).toFixed(1)}%;${i === steps.length - 1 ? 'background:#34d399' : ''}"></i></div></div>`).join('')}
    <p class="n-hint" style="margin-top:4px">${p?.total ? 'Hover a step for what it drops. ' : 'Solve again for every step. '}New-alternate suggestions are pruned the same way.</p>`;
}


// ══════════════════════════════════════════════════════════
// READING A SAVE
// ══════════════════════════════════════════════════════════
/**
 * Read a game save: the nodes it mines (marked on the maps)
 * and what it has unlocked. The unlocks are shown against the planner's own
 * (alternates, machines, miner, belt); one click makes them match.
 */
const sname = k => (RECIPES[k]?.display || k.replace(/_/g, ' ')).replace(/^Alternate:\s*/, '');
const tier = t => t.replace('Mk', 'Mk.');

/** POST the .sav; resolves to {file, nodes, unlocks, changes}. */
export function uploadSave(file) {
  return fetch('/api/save-file', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': file.name }, body: file })
    .then(r => r.json()).then(d => { if (d.error) throw new Error(d.error); document.dispatchEvent(new CustomEvent('save-read', { detail: d })); return d; });
}

/** How the save's unlocks differ from the planner's, with the button that matches them. */
export function changesHTML(d) {
  const c = d?.changes || {};
  if (!d?.unlocks) return '';
  const rows = [];
  ['miner', 'belt'].forEach(k => {
    if (c[k]) rows.push(`${k[0].toUpperCase() + k.slice(1)} ${tier(c[k][0])} → <b>${tier(c[k][1])}</b>`);
  });
  if (c.machines?.add.length) rows.push(`+ ${c.machines.add.map(m => m.replace(/_/g, ' ')).join(', ')}`);
  if (c.machines?.drop.length) rows.push(`− ${c.machines.drop.map(m => m.replace(/_/g, ' ')).join(', ')} <span class="n-hint">(not unlocked in the save)</span>`);
  if (c.alts?.add.length) rows.push(`+ ${c.alts.add.length} alternate${c.alts.add.length > 1 ? 's' : ''}: ${c.alts.add.map(sname).join(', ')}`);
  if (c.alts?.drop.length) rows.push(`− ${c.alts.drop.length} alternate${c.alts.drop.length > 1 ? 's' : ''} not in the save: ${c.alts.drop.map(sname).join(', ')}`);
  if (c.schematics) {
    const n = l => l.map(unlockName).join(', ');
    if (c.schematics.add.length) rows.push(`+ ${c.schematics.add.length} milestone${c.schematics.add.length > 1 ? 's and research' : ''}: ${n(c.schematics.add)}`);
    if (c.schematics.drop.length) rows.push(`− ${n(c.schematics.drop)} <span class="n-hint">(not done in the save)</span>`);
  }
  if (!rows.length) return `<div class="sv-unl">Your unlocks match ${d.file || 'the save'}.</div>`;
  return `<div class="sv-unl"><div class="n-sent-t">${d.file || 'Your save'} has unlocked differently</div>
    ${rows.map(r => `<div>${r}</div>`).join('')}
    <button class="bsm act sv-unl-go">Use the save's unlocks</button>
    <span class="n-hint">Every factory's supply and plan follow; re-solve them after.</span></div>`;
}

/** Make the planner's shared unlocks match the save; re-render what shows them. */
export function applySaveUnlocks() {
  return fetch('/api/save-unlocks', { method: 'POST' }).then(r => r.json()).then(d => {
    if (d.error) throw new Error(d.error);
    Object.assign(PROGRESS, d.progress);
    setUnlockedAlts(d.unlocked);
    renderMachines(); updMachBadge();
    document.dispatchEvent(new CustomEvent('progress-changed'));
    return d;
  });
}

// Wire a container holding changesHTML (re-rendered by `refresh` after applying)
export function wireChanges(el, refresh) {
  el.querySelector('.sv-unl-go')?.addEventListener('click', () => applySaveUnlocks().then(refresh));
}
