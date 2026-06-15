/**
 * sidebar.js — sidebar panels (Build, Machines & Alts, Saved tabs).
 * Recipe lookup → recipe-lookup.js
 * Analysis modal → analysis.js
 * Results bar / build cost / warnings / saved → ui.js
 */

import {
  SC, RESULT, ALL_ITEMS, RECIPES,
  mCol, MABBR, itemName, MTIERS, ALL_MACHINES,
} from './state.js';

// ══════════════════════════════════════════════════════════
// SECTION COLLAPSE
// ══════════════════════════════════════════════════════════
export function toggleSec(id) {
  const sec  = document.getElementById('sec-' + id);
  const body = sec.querySelector('.secb');
  const chev = sec.querySelector('.chev');
  const hide = body.style.display === 'none';
  body.style.display = hide ? '' : 'none';
  chev.textContent   = hide ? '▼' : '▶';
}

// ══════════════════════════════════════════════════════════
// TABS  (Build | Machines & Alts | Saved)
// ══════════════════════════════════════════════════════════
const TABS = ['build', 'machalt', 'saved'];

export function initTabs(onTabChange) {
  document.querySelectorAll('.tabbt').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabbt').forEach(b => b.classList.remove('act'));
      btn.classList.add('act');
      const tab = btn.dataset.tab;
      TABS.forEach(t => {
        const el = document.getElementById('tab-' + t);
        if (el) el.style.display = t === tab ? '' : 'none';
      });
      document.querySelectorAll('.rail-btn[data-tab]').forEach(b =>
        b.classList.toggle('act', b.dataset.tab === tab));
      onTabChange(tab);
    });
  });
}

export function activateTab(tab) {
  document.querySelectorAll('.tabbt').forEach(b =>
    b.classList.toggle('act', b.dataset.tab === tab));
  TABS.forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  document.querySelectorAll('.rail-btn[data-tab]').forEach(b =>
    b.classList.toggle('act', b.dataset.tab === tab));
}

// ══════════════════════════════════════════════════════════
// AUTOCOMPLETE  (shared helper)
// ══════════════════════════════════════════════════════════
export function makeAC(input, onPick, dropParent) {
  let drop = null, cursor = -1;
  let _lastQ = null, _lastSuggestions = null;

  function suggestions(q) {
    if (q === _lastQ) return _lastSuggestions;
    _lastQ = q;
    if (!q) return (_lastSuggestions = ALL_ITEMS.slice(0, 10));
    const ql = q.toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
    const qd = q.toLowerCase();
    _lastSuggestions = ALL_ITEMS
      .map(key => {
        const kl = key.toLowerCase(), dl = itemName(key).toLowerCase();
        let score = 0;
        if (kl.startsWith(ql) || dl.startsWith(qd))  score = 3;
        else if (kl.includes(ql) || dl.includes(qd))  score = 2;
        else if (dl.includes(qd.replace(/_/g, ' ')))  score = 1;
        return { key, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 14)
      .map(x => x.key);
    return _lastSuggestions;
  }

  function openDrop() {
    const s = suggestions(input.value);
    if (!s.length) { closeDrop(); return; }

    if (drop) {
      const existing = drop.querySelectorAll('.aci');
      const same = existing.length === s.length &&
        [...existing].every((el, i) => el.dataset.key === s[i]);
      if (same) return;
      s.forEach((key, i) => {
        if (i < existing.length) {
          if (existing[i].dataset.key !== key) {
            existing[i].textContent = itemName(key);
            existing[i].dataset.key = key;
          }
        } else {
          const d = document.createElement('div');
          d.className = 'aci';
          d.textContent = itemName(key);
          d.dataset.key = key;
          d.addEventListener('mousedown', ev => { ev.preventDefault(); pick(key); });
          drop.appendChild(d);
        }
      });
      for (let i = existing.length - 1; i >= s.length; i--) existing[i].remove();
      return;
    }

    drop = document.createElement('div');
    drop.className = 'acd';
    s.forEach(key => {
      const d = document.createElement('div');
      d.className = 'aci';
      d.textContent = itemName(key);
      d.dataset.key = key;
      d.addEventListener('mousedown', ev => { ev.preventDefault(); pick(key); });
      drop.appendChild(d);
    });
    (dropParent || input.parentNode).appendChild(drop);
  }

  function closeDrop() {
    if (drop) { drop.remove(); drop = null; }
    cursor = -1;
  }

  function pick(key) {
    input.value = itemName(key);
    onPick(key);
    closeDrop();
  }

  let _inputTimer = null;
  input.addEventListener('focus', openDrop);
  input.addEventListener('input', () => {
    clearTimeout(_inputTimer);
    _inputTimer = setTimeout(() => { closeDrop(); openDrop(); }, 120);
  });
  input.addEventListener('blur',  () => setTimeout(closeDrop, 160));
  input.addEventListener('keydown', e => {
    if (!drop) {
      if (e.key === 'Enter' && input.value.trim()) {
        const top = suggestions(input.value)[0];
        if (top) { e.preventDefault(); pick(top); }
      }
      return;
    }
    const its = drop.querySelectorAll('.aci');
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(cursor + 1, its.length - 1); its.forEach((el, i) => el.classList.toggle('active', i === cursor)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); cursor = Math.max(cursor - 1, 0);               its.forEach((el, i) => el.classList.toggle('active', i === cursor)); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const key = cursor >= 0 ? its[cursor].dataset.key : its[0]?.dataset.key;
      if (key) pick(key);
    }
    if (e.key === 'Escape') closeDrop();
  });

  return { closeDrop };
}

// ══════════════════════════════════════════════════════════
// KV EDITOR
// ══════════════════════════════════════════════════════════
const KVS = {
  res:  { field: 'available_resources', rows: [] },
  obj:  { field: 'objective',           rows: [] },
  must: { field: 'must_produce',        rows: [] },
  min:  { field: 'min_produce',         rows: [] },
  max:  { field: 'max_produce',         rows: [] },
};

function syncKv(name) {
  const st = KVS[name];
  SC[st.field] = {};
  st.rows.forEach(({ key, val }) => { if (key) SC[st.field][key] = parseFloat(val) || 0; });
}

export function renderKv(name, focusRowIndex = -1, focusTarget = 'key') {
  const st = KVS[name];
  const c  = document.getElementById('kv-' + name);
  c.innerHTML = '';

  const keyInputs = [];
  const valInputs = [];

  st.rows.forEach((row, i) => {
    const div  = document.createElement('div'); div.className = 'kvr';
    const wrap = document.createElement('div'); wrap.className = 'acw';
    const ki   = document.createElement('input'); ki.type = 'text'; ki.placeholder = 'Item…';
    ki.value = row.key ? itemName(row.key) : '';
    ki.addEventListener('change', () => {
      const raw = ki.value.trim().replace(/\s+/g, '_');
      const found = ALL_ITEMS.find(k =>
        k.toLowerCase() === raw.toLowerCase() ||
        itemName(k).toLowerCase() === ki.value.trim().toLowerCase());
      row.key = found || raw;
      syncKv(name);
    });
    wrap.appendChild(ki);
    keyInputs.push(ki);

    const vi = document.createElement('input'); vi.type = 'number'; vi.placeholder = '0'; vi.min = '0';
    vi.style.fontFamily = 'var(--mono)'; vi.style.fontSize = '12px';
    vi.value = row.val || '';
    vi.addEventListener('input', () => { row.val = vi.value; syncKv(name); });
    valInputs.push(vi);

    const rb = document.createElement('button'); rb.className = 'bi'; rb.innerHTML = '✕';
    rb.addEventListener('click', () => {
      st.rows.splice(i, 1);
      div.remove();
      syncKv(name);
    });

    div.appendChild(wrap); div.appendChild(vi); div.appendChild(rb);
    c.appendChild(div);
  });

  keyInputs.forEach((ki, i) => {
    makeAC(ki, key => {
      st.rows[i].key = key;
      syncKv(name);
      requestAnimationFrame(() => {
        valInputs[i].focus();
        valInputs[i].select();
      });
    });
  });

  valInputs.forEach((vi, i) => {
    vi.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      st.rows[i].val = vi.value;
      syncKv(name);
      if (i < st.rows.length - 1) {
        keyInputs[i + 1].focus();
        keyInputs[i + 1].select();
      } else {
        st.rows.push({ key: '', val: '' });
        renderKv(name, st.rows.length - 1, 'key');
      }
    });
  });

  if (focusRowIndex >= 0 && focusRowIndex < st.rows.length) {
    requestAnimationFrame(() => {
      const el = focusTarget === 'val' ? valInputs[focusRowIndex] : keyInputs[focusRowIndex];
      if (el) { el.focus(); el.select(); }
    });
  }
}

export function addKv(name) {
  KVS[name].rows.push({ key: '', val: '' });
  renderKv(name, KVS[name].rows.length - 1, 'key');
}

function loadKvFromScenario(name) {
  const st = KVS[name];
  st.rows = Object.entries(SC[st.field] || {}).map(([key, val]) => ({ key, val: String(val) }));
  renderKv(name);
}
export function loadAllKv() { Object.keys(KVS).forEach(loadKvFromScenario); }

// ══════════════════════════════════════════════════════════
// FILL / READ UI
// ══════════════════════════════════════════════════════════
export function fillUI() {
  document.getElementById('sc-name').value = SC.name || '';
  document.getElementById('sc-desc').value = SC.description || '';
  document.getElementById('sc-sh').value   = SC.power_shards_available ?? '';
  document.getElementById('sc-sl').value   = SC.somersloops_available  ?? '';
  document.getElementById('sc-mp').value   = SC.max_power_mw           ?? '';
  document.getElementById('sc-mm').value   = SC.max_machines           ?? '';
  document.getElementById('sc-nt').value   = SC.notes || '';
  loadAllKv();
  renderMachines(); updMachBadge();
  renderAlts();     updAltBadge();
}

export function readUI() {
  SC.name                   = document.getElementById('sc-name').value || 'New Factory';
  SC.description            = document.getElementById('sc-desc').value || '';
  SC.power_shards_available = pn(document.getElementById('sc-sh').value);
  SC.somersloops_available  = pn(document.getElementById('sc-sl').value);
  SC.max_power_mw           = pn(document.getElementById('sc-mp').value);
  SC.max_machines           = pn(document.getElementById('sc-mm').value);
  SC.notes                  = document.getElementById('sc-nt').value || '';
  Object.keys(KVS).forEach(syncKv);
}

function pn(v) { return (v === '' || v == null) ? null : parseFloat(v) || 0; }

// ══════════════════════════════════════════════════════════
// MACHINES PANEL
// ══════════════════════════════════════════════════════════
export function renderMachines() {
  const p  = document.getElementById('machpanel'); p.innerHTML = '';
  const en = new Set(SC.enabled_machines.length ? SC.enabled_machines : ALL_MACHINES);

  MTIERS.forEach(tier => {
    const wrap = document.createElement('div'); wrap.style.marginBottom = '8px';
    const hdr  = document.createElement('div'); hdr.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:4px';
    const hbtn = document.createElement('button');
    hbtn.className    = 'bsm' + (tier.ms.every(m => en.has(m)) ? ' act' : '');
    hbtn.style.cssText = 'font-size:10px;padding:2px 7px';
    hbtn.textContent  = tier.label;
    hbtn.addEventListener('click', () => {
      const aon = tier.ms.every(m => en.has(m));
      tier.ms.forEach(m => aon ? en.delete(m) : en.add(m));
      saveEn(en);
    });
    hdr.appendChild(hbtn); wrap.appendChild(hdr);

    const chips = document.createElement('div');
    chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;padding-left:2px';
    tier.ms.forEach(m => {
      const on   = en.has(m); const c = mCol(m);
      const chip = document.createElement('div'); chip.className = 'mchip';
      chip.style.cssText = `border-color:${on ? c : 'var(--b)'};background:${on ? c + '22' : 'var(--p3)'};color:${on ? c : 'var(--t3)'}`;
      chip.textContent = m.replace(/_/g, ' ');
      chip.addEventListener('click', () => { on ? en.delete(m) : en.add(m); saveEn(en); });
      chips.appendChild(chip);
    });
    wrap.appendChild(chips); p.appendChild(wrap);
  });
}

function saveEn(en) {
  SC.enabled_machines = [...en].length === ALL_MACHINES.length ? [] : [...en];
  renderMachines(); updMachBadge();
}
export function updMachBadge() {
  const el = document.getElementById('mb');
  if (el) el.textContent = SC.enabled_machines.length
    ? `${SC.enabled_machines.length}/${ALL_MACHINES.length}` : 'All';
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
// Each entry: { key, display, machine }  — all baked in, no
// runtime resolution needed.
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
      { key: 'Alt_Cast_Screws',  display: 'Cast Screws',  machine: 'Constructor' },
      { key: 'Alt_Steel_Screws', display: 'Steel Screws', machine: 'Constructor' },
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
      { key: 'Alt_Iron_Pipe',         display: 'Iron Pipe',         machine: 'Constructor' },
      { key: 'Alt_Molded_Steel_Pipe', display: 'Molded Steel Pipe', machine: 'Foundry'     },
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
};

// Track open/closed state of category and item dropdowns across renders
const _catOpen  = {};   // { catLabel: bool }
const _itemOpen = {};   // { itemLabel: bool }
let _altSearch = '';

// Simple accessor — tree is fully baked at module load time
function buildAltTree() { return ALT_TREE; }

export function renderAlts() {
  const p  = document.getElementById('altspanel');
  p.innerHTML = '';
  const en   = new Set(SC.alternate_recipes_enabled || []);
  const tree = buildAltTree();

  // ── Search bar ──────────────────────────────────────────
  const searchWrap = document.createElement('div');
  searchWrap.style.cssText = 'position:relative;margin-bottom:8px';
  const searchInp = document.createElement('input');
  searchInp.type        = 'text';
  searchInp.placeholder = 'Search recipes or items…';
  searchInp.value       = _altSearch;
  searchInp.style.cssText = [
    'width:100%', 'box-sizing:border-box', 'padding:4px 26px 4px 8px',
    'background:var(--p3)', 'border:1px solid var(--b)', 'border-radius:var(--rsm)',
    'color:var(--t)', 'font-size:11px', 'font-family:var(--font)', 'outline:none',
  ].join(';');
  searchInp.addEventListener('focus', () => searchInp.style.borderColor = 'var(--acc)');
  searchInp.addEventListener('blur',  () => searchInp.style.borderColor = 'var(--b)');
  searchInp.addEventListener('input', () => { _altSearch = searchInp.value; renderAlts(); });

  const clearBtn = document.createElement('button');
  clearBtn.textContent = '✕';
  clearBtn.style.cssText = [
    'position:absolute', 'right:5px', 'top:50%', 'transform:translateY(-50%)',
    'background:none', 'border:none', 'color:var(--t3)', 'cursor:pointer',
    'font-size:11px', 'padding:0', 'line-height:1',
    'display:' + (_altSearch ? 'block' : 'none'),
  ].join(';');
  clearBtn.addEventListener('click', () => { _altSearch = ''; renderAlts(); });
  searchWrap.appendChild(searchInp);
  searchWrap.appendChild(clearBtn);
  p.appendChild(searchWrap);

  const q = _altSearch.trim().toLowerCase();
  const searching = !!q;

  // ── Render tree ─────────────────────────────────────────
  let anyVisible = false;

  Object.entries(tree).forEach(([cat, items]) => {
    // Filter items/recipes by search
    const filteredItems = {};
    Object.entries(items).forEach(([iName, alts]) => {
      const matchItem = iName.toLowerCase().includes(q);
      const matchedAlts = searching
        ? (matchItem ? alts : alts.filter(a => a.display.toLowerCase().includes(q)))
        : alts;
      if (!searching || matchedAlts.length) filteredItems[iName] = matchedAlts;
    });
    if (!Object.keys(filteredItems).length) return;
    anyVisible = true;

    // Count enabled in this category
    const catKeys    = Object.values(filteredItems).flat().map(a => a.key);
    const catEnabled = catKeys.filter(k => en.has(k)).length;
    const catAllOn   = catEnabled === catKeys.length;
    const isOpen     = searching || (_catOpen[cat] !== false);  // default open

    // ── Category row ──────────────────────────────────────
    const catRow = document.createElement('div');
    catRow.style.cssText = 'display:flex;align-items:center;gap:5px;margin:4px 0 2px;cursor:pointer;user-select:none';

    const catChev = document.createElement('span');
    catChev.style.cssText = 'font-size:9px;color:var(--t3);width:12px;flex-shrink:0;transition:transform .12s';
    catChev.textContent = isOpen ? '▼' : '▶';

    const catToggle = document.createElement('button');
    catToggle.className    = 'bsm' + (catAllOn ? ' act' : '');
    catToggle.style.cssText = 'font-size:10px;padding:1px 5px;min-width:20px;flex-shrink:0';
    catToggle.textContent  = catAllOn ? '✓' : '○';
    catToggle.title        = catAllOn ? 'Disable all in ' + cat : 'Enable all in ' + cat;
    catToggle.addEventListener('click', e => {
      e.stopPropagation();
      catAllOn ? catKeys.forEach(k => en.delete(k)) : catKeys.forEach(k => en.add(k));
      SC.alternate_recipes_enabled = [...en]; renderAlts(); updAltBadge();
    });

    const catLabel = document.createElement('span');
    catLabel.style.cssText = 'font-size:12px;font-weight:700;color:var(--t);flex:1';
    catLabel.textContent = cat;

    const catBadge = document.createElement('span');
    catBadge.style.cssText = 'font-size:10px;color:var(--t3);font-family:var(--mono)';
    catBadge.textContent = catEnabled ? `${catEnabled}/${catKeys.length}` : `${catKeys.length}`;

    catRow.appendChild(catChev);
    catRow.appendChild(catToggle);
    catRow.appendChild(catLabel);
    catRow.appendChild(catBadge);
    p.appendChild(catRow);

    // Category body (collapsible)
    const catBody = document.createElement('div');
    catBody.style.cssText = 'overflow:hidden;' + (isOpen ? '' : 'display:none');
    p.appendChild(catBody);

    catRow.addEventListener('click', () => {
      const nowOpen = catBody.style.display === 'none';
      _catOpen[cat] = nowOpen;
      catBody.style.display = nowOpen ? '' : 'none';
      catChev.textContent = nowOpen ? '▼' : '▶';
    });

    // ── Item rows inside category ─────────────────────────
    Object.entries(filteredItems).forEach(([iName, alts]) => {
      const itemKeys    = alts.map(a => a.key);
      const itemEnabled = itemKeys.filter(k => en.has(k)).length;
      const itemAllOn   = itemEnabled === itemKeys.length;
      const iOpen       = searching || !!_itemOpen[iName];  // default closed

      const itemRow = document.createElement('div');
      itemRow.style.cssText = 'display:flex;align-items:center;gap:4px;margin:2px 0 1px;padding-left:14px;cursor:pointer;user-select:none';

      const itemChev = document.createElement('span');
      itemChev.style.cssText = 'font-size:8px;color:var(--t3);width:10px;flex-shrink:0';
      itemChev.textContent = iOpen ? '▾' : '▸';

      const itemToggle = document.createElement('button');
      itemToggle.className    = 'bsm' + (itemAllOn ? ' act' : '');
      itemToggle.style.cssText = 'font-size:9px;padding:1px 4px;min-width:18px;flex-shrink:0';
      itemToggle.textContent  = itemAllOn ? '✓' : '○';
      itemToggle.title        = itemAllOn ? 'Disable all for ' + iName : 'Enable all for ' + iName;
      itemToggle.addEventListener('click', e => {
        e.stopPropagation();
        itemAllOn ? itemKeys.forEach(k => en.delete(k)) : itemKeys.forEach(k => en.add(k));
        SC.alternate_recipes_enabled = [...en]; renderAlts(); updAltBadge();
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

      // Item recipes body (collapsible)
      const itemBody = document.createElement('div');
      itemBody.style.cssText = 'overflow:hidden;' + (iOpen ? '' : 'display:none');
      catBody.appendChild(itemBody);

      itemRow.addEventListener('click', () => {
        const nowOpen = itemBody.style.display === 'none';
        _itemOpen[iName] = nowOpen;
        itemBody.style.display = nowOpen ? '' : 'none';
        itemChev.textContent = nowOpen ? '▾' : '▸';
      });

      // ── Recipe chips ─────────────────────────────────────
      alts.forEach(alt => {
        const on   = en.has(alt.key);
        const chip = document.createElement('div');
        chip.className = 'altc' + (on ? ' act' : '');
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

        chip.appendChild(dot); chip.appendChild(nameEl); chip.appendChild(mach);
        chip.addEventListener('click', () => {
          on ? en.delete(alt.key) : en.add(alt.key);
          SC.alternate_recipes_enabled = [...en]; renderAlts(); updAltBadge();
        });
        itemBody.appendChild(chip);
      });
    });
  });

  if (!anyVisible) {
    const none = document.createElement('div');
    none.style.cssText = 'font-size:11px;color:var(--t3);text-align:center;padding:16px 0';
    none.textContent = 'No matching recipes';
    p.appendChild(none);
  }

  updAltBadge();
}

export function updAltBadge() {
  const el = document.getElementById('ab'); if (!el) return;
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
  renderAlts(); updAltBadge();
}
export function altsNone() { SC.alternate_recipes_enabled = []; renderAlts(); updAltBadge(); }
