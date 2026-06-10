/**
 * sidebar.js — sidebar panels (Build, Machines & Alts, Saved tabs).
 * Recipe lookup → recipe-lookup.js
 * Analysis modal → analysis.js
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
      // Sync rail
      document.querySelectorAll('.rail-btn[data-tab]').forEach(b =>
        b.classList.toggle('act', b.dataset.tab === tab));
      onTabChange(tab);
    });
  });
}

// Called by rail buttons when sidebar is collapsed
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
  let _lastQ = null, _lastSuggestions = null;  // memoize last result

  function suggestions(q) {
    if (q === _lastQ) return _lastSuggestions;   // same query — skip rescan
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
      // Reuse existing dropdown: diff against current children to avoid
      // rebuilding the DOM when only values change or list is identical.
      const existing = drop.querySelectorAll('.aci');
      const same = existing.length === s.length &&
        [...existing].every((el, i) => el.dataset.key === s[i]);
      if (same) return;  // nothing changed — skip all DOM work

      // Update in-place: patch existing rows or add/remove as needed
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
      // Remove surplus rows
      for (let i = existing.length - 1; i >= s.length; i--) existing[i].remove();
      return;
    }

    // First open: create the dropdown fresh
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
      // No autocomplete open — Enter on a non-empty input picks the top suggestion
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
      // If user arrowed to a specific item use it, otherwise pick the top result
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
      div.remove();   // remove just this row — no full re-render needed
      syncKv(name);
    });

    div.appendChild(wrap); div.appendChild(vi); div.appendChild(rb);
    c.appendChild(div);
  });

  // Wire autocomplete: picking an item jumps focus to the value input
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

  // Wire value Enter: advance to next row or add a new row
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

  // Restore focus after re-render
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
// ALTERNATES PANEL
// ══════════════════════════════════════════════════════════
let ALT_FAMILIES = null;
function buildAltFamilies() {
  if (ALT_FAMILIES) return ALT_FAMILIES;
  const families = {};
  const FAMILY_MAP = [
    [['Iron_Ingot','Iron_Plate','Iron_Rod','Reinforced_Iron_Plate','Modular_Frame','Rotor','Stator','Motor','Screw','Wire','Iron_Rebar','Heavy_Modular_Frame','Smart_Plating','Automated_Wiring'], 'Iron'],
    [['Steel_Ingot','Steel_Beam','Steel_Pipe','Encased_Industrial_Beam','Versatile_Framework'], 'Steel'],
    [['Copper_Ingot','Copper_Sheet','Wire','Cable','Quickwire'], 'Copper'],
    [['Caterium_Ingot','Quickwire'], 'Caterium'],
    [['Circuit_Board','Circuit_Board_HS','Computer','Supercomputer','High_Speed_Connector','Crystal_Oscillator','Heat_Sink','Cooling_System','Battery','Electromagnetic_Control_Rod','Turbo_Motor'], 'Electronics'],
    [['Fuel','Turbofuel','Rocket_Fuel','Heavy_Oil_Residue','Plastic','Rubber','Polymer_Resin','Fabric','Empty_Canister','Concrete','Compacted_Coal'], 'Oil & Fuel'],
    [['Alumina_Solution','Aluminum_Scrap','Aluminum_Ingot','Silica','Quartz_Crystal','Dissolved_Silica','Aluminum_Casing'], 'Aluminum'],
    [['Encased_Uranium_Cell','Uranium_Fuel_Rod','Non_Fissile_Uranium','Encased_Plutonium_Cell','Plutonium_Fuel_Rod'], 'Nuclear'],
    [['Dark_Matter_Crystal','Diamonds','Time_Crystal','Ionized_Fuel'], 'Quantum'],
  ];
  Object.entries(RECIPES).forEach(([key, r]) => {
    if (!r.alternate) return;
    const outKeys = Object.keys(r.outputs);
    let fam = 'Other';
    for (const [items, f] of FAMILY_MAP) {
      if (outKeys.some(k => items.includes(k))) { fam = f; break; }
    }
    if (!families[fam]) families[fam] = [];
    families[fam].push({ key, display: r.display.replace(/^Alternate:\s*/i, ''), machine: r.machine });
  });
  ALT_FAMILIES = families;
  return families;
}

const altFamOpen = {};
export function renderAlts() {
  const p    = document.getElementById('altspanel'); p.innerHTML = '';
  const en   = new Set(SC.alternate_recipes_enabled || []);
  const fams = buildAltFamilies();

  Object.entries(fams).forEach(([fam, alts]) => {
    const fKeys = alts.map(a => a.key);
    const cnt   = fKeys.filter(k => en.has(k)).length;
    const open  = !!altFamOpen[fam];

    const wrap = document.createElement('div'); wrap.style.marginBottom = '3px';
    const hdr  = document.createElement('div');
    hdr.style.cssText = `display:flex;align-items:center;gap:5px;margin-bottom:${open ? '3' : '0'}px`;

    const hbtn = document.createElement('button');
    hbtn.className    = 'bsm' + (cnt === fKeys.length ? ' act' : '');
    hbtn.style.cssText = 'font-size:10px;padding:2px 5px;min-width:28px';
    hbtn.textContent  = `${cnt}/${fKeys.length}`;
    hbtn.addEventListener('click', () => {
      const aon = fKeys.every(k => en.has(k));
      aon ? fKeys.forEach(k => en.delete(k)) : fKeys.forEach(k => en.add(k));
      SC.alternate_recipes_enabled = [...en]; renderAlts(); updAltBadge();
    });

    const ft = document.createElement('div');
    ft.style.cssText = 'cursor:pointer;flex:1;font-size:11px;font-weight:500;color:var(--t2);display:flex;align-items:center;gap:3px';
    ft.innerHTML = `${fam} <span style="font-size:10px;color:var(--t3)">${open ? '▼' : '▶'}</span>`;
    ft.addEventListener('click', () => { altFamOpen[fam] = !altFamOpen[fam]; renderAlts(); });

    hdr.appendChild(hbtn); hdr.appendChild(ft); wrap.appendChild(hdr);

    if (open) alts.forEach(alt => {
      const on   = en.has(alt.key);
      const chip = document.createElement('div'); chip.className = 'altc' + (on ? ' act' : '');
      chip.innerHTML = `<div class="altdot"></div><div class="altn">${alt.display}</div><div class="altm">${alt.machine.replace(/_/g, ' ')}</div>`;
      chip.addEventListener('click', () => {
        on ? en.delete(alt.key) : en.add(alt.key);
        SC.alternate_recipes_enabled = [...en]; renderAlts(); updAltBadge();
      });
      wrap.appendChild(chip);
    });
    p.appendChild(wrap);
  });
  updAltBadge();
}

export function updAltBadge() {
  const el = document.getElementById('ab'); if (!el) return;
  const fams  = buildAltFamilies();
  const total = Object.values(fams).flat().length;
  el.textContent = `${(SC.alternate_recipes_enabled || []).length}/${total}`;
}
export function altsAll()  {
  const fams = buildAltFamilies();
  SC.alternate_recipes_enabled = Object.values(fams).flat().map(a => a.key);
  renderAlts(); updAltBadge();
}
export function altsNone() { SC.alternate_recipes_enabled = []; renderAlts(); updAltBadge(); }


// ══════════════════════════════════════════════════════════
// WARNINGS MODAL
// ══════════════════════════════════════════════════════════
export function openWarn() {
  if (!RESULT) return;
  const items = [
    ...Object.entries(RESULT.error_sources       ?? {}).map(([k, v]) => ({ t: 'error',   txt: `Missing: ${itemName(k)} — needs ${Number(v).toFixed(1)}/min` })),
    ...Object.entries(RESULT.error_sinks         ?? {}).map(([k, v]) => ({ t: 'error',   txt: `Byproduct: ${itemName(k)} — surplus ${Number(v).toFixed(1)}/min` })),
    ...Object.entries(RESULT.surplus_intermediates ?? {}).map(([k, v]) => ({ t: 'surplus', txt: `Reusable surplus: ${itemName(k)} — +${Number(v).toFixed(1)}/min` })),
    ...(RESULT.conflict_hints ?? []).map(t => ({ t: 'warning', txt: t })),
    ...(RESULT.warnings       ?? []).map(t => ({ t: 'info',    txt: t })),
  ];
  const COL = { error:'var(--err)', warning:'var(--warn)', info:'var(--t3)', surplus:'#f59e0b' };
  const BG  = { error:'var(--err-dim)', warning:'var(--warn-dim)', info:'var(--p3)', surplus:'rgba(245,158,11,.1)' };
  const ICO = { error:'✕', warning:'⚠', info:'ℹ', surplus:'↗' };
  document.getElementById('wmtit').textContent = `Solve Issues — ${items.length}`;
  const list = document.getElementById('wmit-list'); list.innerHTML = '';
  items.forEach(({ t, txt }) => {
    const d = document.createElement('div'); d.className = 'wmit';
    d.style.cssText = `border:1px solid ${COL[t]};background:${BG[t]};color:${COL[t]}`;
    d.innerHTML = `<span style="flex-shrink:0">${ICO[t]}</span><span>${txt}</span>`;
    list.appendChild(d);
  });
  document.getElementById('wo').classList.add('show');
}
export function closeWarn() { document.getElementById('wo').classList.remove('show'); }

// ══════════════════════════════════════════════════════════
// RESULTS BAR + BUILD COST
// ══════════════════════════════════════════════════════════
let _rbLastHTML = null;
export function renderResultsBar() {
  const rb = document.getElementById('rb');
  if (!RESULT?.status?.startsWith('Optimal')) {
    rb.style.display = 'none';
    _rbLastHTML = null;
    return;
  }
  const st  = (label, val, color = 'var(--acc)') =>
    `<div class="rbs"><div class="rbv" style="color:${color}">${val}</div><div class="rbl">${label}</div></div>`;
  const sep = '<div class="rbsep"></div>';

  const objKeys = new Set(Object.keys(RESULT.objective_items || {}));
  const allOutputs = Object.entries(RESULT.net_items || {})
    .filter(([, v]) => v > 0.01)
    .sort(([ka, va], [kb, vb]) => {
      const aObj = objKeys.has(ka) ? 1 : 0;
      const bObj = objKeys.has(kb) ? 1 : 0;
      if (bObj !== aObj) return bObj - aObj;
      return vb - va;
    });

  let h = '';
  allOutputs.forEach(([k, v], i) => {
    const color = objKeys.has(k) ? 'var(--ok)' : 'var(--acc)';
    h += st(itemName(k), `${v.toFixed(1)}/m`, color);
    if (i < allOutputs.length - 1) h += sep;
  });
  if (allOutputs.length) h += sep;
  h += st('Machines', RESULT.total_machines) + sep;
  h += st('Power', `${RESULT.total_power_mw?.toFixed(0)} MW`, 'var(--warn)');
  if (RESULT.shards_used > 0) h += sep + st('Shards', RESULT.shards_used, '#3b82f6');
  if (RESULT.sloops_used > 0) h += sep + st('Sloops', RESULT.sloops_used, '#a855f7');

  // Only touch the DOM if content actually changed
  if (h === _rbLastHTML) { rb.style.display = 'flex'; return; }
  _rbLastHTML = h;
  rb.style.display = 'flex';
  rb.innerHTML = h;
}

let bcOpen = false;
let _bcLastKey = null;  // tracks last rendered (open-state + result) to skip no-op redraws
export function toggleBC() { bcOpen = !bcOpen; renderBuildCost(); }
export function renderBuildCost() {
  const panel  = document.getElementById('bc');
  const cost   = RESULT?.build_cost ?? {};
  const entries = Object.entries(cost);
  const shards = RESULT?.build_cost_shards ?? 0;
  const sloops = RESULT?.build_cost_sloops ?? 0;
  if (!entries.length && !shards && !sloops) {
    panel.style.display = 'none';
    _bcLastKey = null;
    return;
  }
  panel.style.display = '';
  document.getElementById('bcc').textContent = `${entries.length} items ${bcOpen ? '▲' : '▼'}`;
  const body = document.getElementById('bcb');
  body.style.display = bcOpen ? '' : 'none';
  if (!bcOpen) return;

  // Skip full body rebuild if nothing has changed
  const cacheKey = JSON.stringify(cost) + shards + sloops;
  if (cacheKey === _bcLastKey) return;
  _bcLastKey = cacheKey;

  body.innerHTML = '';
  entries.forEach(([item, qty]) => {
    const r = document.createElement('div'); r.className = 'bcr';
    r.innerHTML = `<span>${itemName(item)}</span><span>×${qty}</span>`;
    body.appendChild(r);
  });
  if (shards) { const r = document.createElement('div'); r.className = 'bcr'; r.innerHTML = `<span style="color:#3b82f6">💎 Power Shards</span><span style="color:#3b82f6">×${shards}</span>`; body.appendChild(r); }
  if (sloops) { const r = document.createElement('div'); r.className = 'bcr'; r.innerHTML = `<span style="color:#a855f7">🔮 Somersloops</span><span style="color:#a855f7">×${sloops}</span>`; body.appendChild(r); }
}

// ══════════════════════════════════════════════════════════
// SAVED SCENARIOS TAB
// ══════════════════════════════════════════════════════════
export function renderSaved(saved, onLoad, onDelete) {
  const el = document.getElementById('savedlist');
  if (!saved.length) { el.innerHTML = '<p style="font-size:12px;color:var(--t3)">No saved scenarios.</p>'; return; }
  el.innerHTML = '';
  saved.forEach(s => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:5px;padding:6px 8px;background:var(--p3);border-radius:var(--rsm);border:1px solid var(--b)';
    row.innerHTML = `
      <div style="flex:1">
        <div style="font-size:12px;color:var(--t)">${s.name}</div>
        <div style="font-size:10px;color:var(--t3);margin-top:1px">${(s.resources||[]).slice(0,3).join(', ')}</div>
      </div>
      <button class="bsm">Load</button>
      <button class="bsm dan">✕</button>
    `;
    row.querySelectorAll('button')[0].addEventListener('click', () => onLoad(s.key));
    row.querySelectorAll('button')[1].addEventListener('click', () => onDelete(s.key));
    el.appendChild(row);
  });
}
