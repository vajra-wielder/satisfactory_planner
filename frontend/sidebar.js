/**
 * sidebar.js — all sidebar panel logic.
 * Data (items, recipes) is fetched from the server via api.js.
 */

import {
  SC, RESULT, ALL_ITEMS, RECIPES,
  mCol, MABBR, itemName, MTIERS, ALL_MACHINES,
} from './state.js';
import { fetchItems } from './api.js';

// ── Section collapse ──────────────────────────────────────
export function toggleSec(id) {
  const sec  = document.getElementById('sec-' + id);
  const body = sec.querySelector('.secb');
  const chev = sec.querySelector('.chev');
  const hide = body.style.display === 'none';
  body.style.display = hide ? '' : 'none';
  chev.textContent   = hide ? '▼' : '▶';
}

// ── Tabs ──────────────────────────────────────────────────
const TABS = ['build', 'machines', 'alts', 'recipes', 'saved'];
export function initTabs(onTabChange) {
  document.querySelectorAll('.tabbt').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabbt').forEach(b => b.classList.remove('act'));
      btn.classList.add('act');
      const tab = btn.dataset.tab;
      TABS.forEach(t => { document.getElementById('tab-' + t).style.display = t === tab ? '' : 'none'; });
      onTabChange(tab);
    });
  });
}

// ── Autocomplete ──────────────────────────────────────────
// Searches by both item key and display name, shows display name in dropdown
export function makeAC(input, onPick) {
  let drop = null, cursor = -1;

  function suggestions(q) {
    if (!q) return ALL_ITEMS.slice(0, 10);
    const ql = q.toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
    const qd = q.toLowerCase();
    return ALL_ITEMS
      .map(key => {
        const kl = key.toLowerCase();
        const dl = itemName(key).toLowerCase();
        let score = 0;
        if (kl.startsWith(ql) || dl.startsWith(qd))            score = 3;
        else if (kl.includes(ql) || dl.includes(qd))           score = 2;
        else if (dl.includes(qd.replace(/_/g, ' ')))           score = 1;
        return { key, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 14)
      .map(x => x.key);
  }

  function openDrop() {
    closeDrop();
    const s = suggestions(input.value);
    if (!s.length) return;
    drop = document.createElement('div');
    drop.className = 'acd';
    s.forEach(key => {
      const d  = document.createElement('div');
      d.className = 'aci';
      const dn = itemName(key);
      // Show display name; if internal key differs meaningfully, show it too
      d.textContent = dn;
      d.dataset.key = key;
      d.addEventListener('mousedown', ev => { ev.preventDefault(); pick(key); });
      drop.appendChild(d);
    });
    input.parentNode.appendChild(drop);
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

  input.addEventListener('focus', openDrop);
  input.addEventListener('input', () => { closeDrop(); openDrop(); });
  input.addEventListener('blur',  () => setTimeout(closeDrop, 150));
  input.addEventListener('keydown', e => {
    if (!drop) return;
    const items = drop.querySelectorAll('.aci');
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(cursor + 1, items.length - 1); items.forEach((el, i) => el.classList.toggle('active', i === cursor)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); cursor = Math.max(cursor - 1, 0);                items.forEach((el, i) => el.classList.toggle('active', i === cursor)); }
    if (e.key === 'Enter' && cursor >= 0) { e.preventDefault(); pick(items[cursor].dataset.key); }
    if (e.key === 'Escape') closeDrop();
  });
}

// ── KV editor ─────────────────────────────────────────────
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

export function renderKv(name) {
  const st = KVS[name];
  const c  = document.getElementById('kv-' + name);
  c.innerHTML = '';
  st.rows.forEach((row, i) => {
    const div  = document.createElement('div'); div.className = 'kvr';
    const wrap = document.createElement('div'); wrap.className = 'acw';
    const ki   = document.createElement('input'); ki.type = 'text'; ki.placeholder = 'Item…';
    ki.value = row.key ? itemName(row.key) : '';
    ki.addEventListener('change', () => {
      const raw = ki.value.trim().replace(/\s+/g, '_');
      const found = ALL_ITEMS.find(k => k.toLowerCase() === raw.toLowerCase()
                                    || itemName(k).toLowerCase() === ki.value.trim().toLowerCase());
      row.key = found || raw;
      syncKv(name);
    });
    wrap.appendChild(ki);
    makeAC(ki, key => { row.key = key; syncKv(name); });

    const vi = document.createElement('input'); vi.type = 'number'; vi.placeholder = '0'; vi.min = '0';
    vi.style.fontFamily = 'var(--mono)'; vi.style.fontSize = '12px';
    vi.value = row.val || '';
    vi.addEventListener('input', () => { row.val = vi.value; syncKv(name); });

    const rb = document.createElement('button'); rb.className = 'bi'; rb.innerHTML = '✕';
    rb.addEventListener('click', () => { st.rows.splice(i, 1); renderKv(name); syncKv(name); });

    div.appendChild(wrap); div.appendChild(vi); div.appendChild(rb);
    c.appendChild(div);
  });
}

export function addKv(name) { KVS[name].rows.push({ key: '', val: '' }); renderKv(name); }

export function loadKvFromScenario(name) {
  const st = KVS[name];
  st.rows = Object.entries(SC[st.field] || {}).map(([key, val]) => ({ key, val: String(val) }));
  renderKv(name);
}
export function loadAllKv() { Object.keys(KVS).forEach(loadKvFromScenario); }

// ── Fill / read UI ────────────────────────────────────────
export function fillUI() {
  document.getElementById('sc-name').value = SC.name || '';
  document.getElementById('sc-desc').value = SC.description || '';
  document.getElementById('sc-sh').value   = SC.power_shards_available ?? '';
  document.getElementById('sc-sl').value   = SC.somersloops_available  ?? '';
  document.getElementById('sc-mp').value   = SC.max_power_mw           ?? '';
  document.getElementById('sc-mm').value   = SC.max_machines            ?? '';
  document.getElementById('sc-nt').value   = SC.notes || '';
  loadAllKv();
  renderMachines();
  updMachBadge();
  renderAlts();
  updAltBadge();
}

export function readUI() {
  SC.name                    = document.getElementById('sc-name').value || 'New Factory';
  SC.description             = document.getElementById('sc-desc').value || '';
  SC.power_shards_available  = pn(document.getElementById('sc-sh').value);
  SC.somersloops_available   = pn(document.getElementById('sc-sl').value);
  SC.max_power_mw            = pn(document.getElementById('sc-mp').value);
  SC.max_machines            = pn(document.getElementById('sc-mm').value);
  SC.notes                   = document.getElementById('sc-nt').value || '';
  Object.keys(KVS).forEach(syncKv);
}

function pn(v) { return (v === '' || v == null) ? null : parseFloat(v) || 0; }

// ── Machines panel ────────────────────────────────────────
export function renderMachines() {
  const p  = document.getElementById('machpanel'); p.innerHTML = '';
  const en = new Set(SC.enabled_machines.length ? SC.enabled_machines : ALL_MACHINES);

  MTIERS.forEach(tier => {
    const wrap = document.createElement('div'); wrap.style.marginBottom = '10px';
    const hdr  = document.createElement('div'); hdr.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:5px';
    const hbtn = document.createElement('button');
    hbtn.className = 'bsm' + (tier.ms.every(m => en.has(m)) ? ' act' : '');
    hbtn.style.cssText = 'font-size:10px;padding:2px 8px';
    hbtn.textContent = tier.label;
    hbtn.addEventListener('click', () => {
      const aon = tier.ms.every(m => en.has(m));
      tier.ms.forEach(m => aon ? en.delete(m) : en.add(m));
      saveEn(en);
    });
    hdr.appendChild(hbtn); wrap.appendChild(hdr);

    const chips = document.createElement('div');
    chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding-left:2px';
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
  const next = [...en];
  SC.enabled_machines = next.length === ALL_MACHINES.length ? [] : next;
  renderMachines(); updMachBadge();
}

export function updMachBadge() {
  document.getElementById('mb').textContent =
    SC.enabled_machines.length ? `${SC.enabled_machines.length}/${ALL_MACHINES.length}` : 'All';
}

// ── Alternates panel ──────────────────────────────────────
// Alt families fetched from server RECIPES, grouped by a heuristic
let ALT_FAMILIES = null; // built lazily from RECIPES

function buildAltFamilies() {
  if (ALT_FAMILIES) return ALT_FAMILIES;
  // Group all alternate recipes by a simple family heuristic based on outputs
  const families = {};
  Object.entries(RECIPES).forEach(([key, r]) => {
    if (!r.alternate) return;
    // Determine family from outputs
    const outKeys = Object.keys(r.outputs);
    let fam = 'Other';
    const FAMILY_MAP = [
      [['Iron_Ingot','Iron_Plate','Iron_Rod','Reinforced_Iron_Plate','Modular_Frame','Rotor','Stator','Motor','Screw','Wire','Iron_Rebar','Heavy_Modular_Frame','Smart_Plating','Automated_Wiring'], 'Iron & Steel'],
      [['Steel_Ingot','Steel_Beam','Steel_Pipe','Encased_Industrial_Beam','Versatile_Framework'], 'Steel'],
      [['Copper_Ingot','Copper_Sheet','Wire','Cable','Quickwire'], 'Copper'],
      [['Caterium_Ingot','Quickwire'], 'Caterium'],
      [['Circuit_Board','Circuit_Board_HS','Computer','Supercomputer','High_Speed_Connector','Crystal_Oscillator','Heat_Sink','Cooling_System','Battery','Electromagnetic_Control_Rod','Turbo_Motor'], 'Electronics'],
      [['Fuel','Turbofuel','Rocket_Fuel','Heavy_Oil_Residue','Plastic','Rubber','Polymer_Resin','Fabric','Empty_Canister','Concrete','Compacted_Coal'], 'Oil & Fuel'],
      [['Alumina_Solution','Aluminum_Scrap','Aluminum_Ingot','Silica','Quartz_Crystal','Dissolved_Silica','Aluminum_Casing'], 'Aluminum'],
      [['Encased_Uranium_Cell','Uranium_Fuel_Rod','Non_Fissile_Uranium','Encased_Plutonium_Cell','Plutonium_Fuel_Rod'], 'Nuclear'],
      [['Dark_Matter_Crystal','Diamonds','Time_Crystal','Ionized_Fuel'], 'Quantum'],
    ];
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

    const wrap = document.createElement('div'); wrap.style.marginBottom = '4px';
    const hdr  = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:' + (open ? '3' : '0') + 'px';

    const hbtn = document.createElement('button');
    hbtn.className = 'bsm' + (cnt === fKeys.length ? ' act' : '');
    hbtn.style.cssText = 'font-size:10px;padding:2px 6px;min-width:30px';
    hbtn.textContent = `${cnt}/${fKeys.length}`;
    hbtn.addEventListener('click', () => {
      const aon = fKeys.every(k => en.has(k));
      aon ? fKeys.forEach(k => en.delete(k)) : fKeys.forEach(k => en.add(k));
      SC.alternate_recipes_enabled = [...en]; renderAlts(); updAltBadge();
    });

    const ft = document.createElement('div');
    ft.style.cssText = 'cursor:pointer;flex:1;font-size:12px;font-weight:500;color:var(--t2);display:flex;align-items:center;gap:3px';
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
  const fams    = buildAltFamilies();
  const total   = Object.values(fams).flat().length;
  const enabled = (SC.alternate_recipes_enabled || []).length;
  document.getElementById('ab').textContent = `${enabled}/${total}`;
}

export function altsAll() {
  const fams = buildAltFamilies();
  SC.alternate_recipes_enabled = Object.values(fams).flat().map(a => a.key);
  renderAlts(); updAltBadge();
}
export function altsNone() { SC.alternate_recipes_enabled = []; renderAlts(); updAltBadge(); }

// ── Recipe lookup tab ─────────────────────────────────────
export function initRecipeLookup() {
  const inp = document.getElementById('rl-input');
  makeAC(inp, key => { inp.value = itemName(key); showRecipeLookup(key); });
  inp.addEventListener('input', () => {
    const raw = inp.value.trim();
    if (!raw) { document.getElementById('rl-results').innerHTML = ''; return; }
    const ql  = raw.toLowerCase();
    const found = ALL_ITEMS.find(k =>
      itemName(k).toLowerCase() === ql || k.toLowerCase() === ql.replace(/\s+/g, '_')
    );
    if (found) showRecipeLookup(found);
    else document.getElementById('rl-results').innerHTML =
      '<p style="font-size:11px;color:var(--t3)">Keep typing…</p>';
  });
}

function showRecipeLookup(item) {
  const el = document.getElementById('rl-results'); el.innerHTML = '';
  const produces = [], consumes = [];
  Object.entries(RECIPES).forEach(([key, r]) => {
    if (r.outputs[item])       produces.push({ key, r });
    else if (r.inputs[item])   consumes.push({ key, r });
  });

  if (!produces.length && !consumes.length) {
    el.innerHTML = `<p style="font-size:11px;color:var(--t3)">No recipes found for <b>${itemName(item)}</b>.</p>`;
    return;
  }

  function recipeCard(key, r, role) {
    const color    = mCol(r.machine);
    const cleanDisp = r.display.replace(/^Alternate:\s*/i, '').replace(/\s*\(Alt\)/, '');
    const rate     = role === 'prod' ? (r.outputs[item] || 0) : (r.inputs[item] || 0);
    const card     = document.createElement('div');
    card.className = 'rlcard ' + (role === 'prod' ? 'prod' : 'cons');

    let ioHTML = '';
    Object.entries(r.inputs ).forEach(([k, v]) => { ioHTML += `<div class="rlrow"><span>← ${itemName(k)}</span><span>${v}/min</span></div>`; });
    ioHTML += '<div style="border-top:1px solid var(--b);margin:3px 0"></div>';
    Object.entries(r.outputs).forEach(([k, v]) => { ioHTML += `<div class="rlrow"><span style="color:var(--ok)">→ ${itemName(k)}</span><span>${v}/min</span></div>`; });

    const roleLabel = role === 'prod'
      ? '<span style="color:var(--ok)">produces</span>'
      : '<span style="color:#3b82f6">consumes</span>';

    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:5px;margin-bottom:4px;flex-wrap:wrap">
        <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:${color}22;color:${color};border:1px solid ${color}44;font-family:var(--mono);font-weight:600">${MABBR[r.machine] || r.machine}</span>
        ${r.alternate ? '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:var(--acc-glow);color:var(--acc);border:1px solid var(--acc)">ALT</span>' : ''}
        <span class="rlrname">${cleanDisp}</span>
        <span style="margin-left:auto;font-size:10px">${roleLabel} ${Number(rate).toFixed(2)}/min</span>
      </div>
      ${ioHTML}
    `;
    el.appendChild(card);
  }

  if (produces.length) {
    const hd = document.createElement('div');
    hd.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--ok);margin-bottom:4px;margin-top:2px';
    hd.textContent = `Produced by (${produces.length})`;
    el.appendChild(hd);
    produces.forEach(({ key, r }) => recipeCard(key, r, 'prod'));
  }
  if (consumes.length) {
    const hd = document.createElement('div');
    hd.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#3b82f6;margin-bottom:4px;margin-top:6px';
    hd.textContent = `Used in (${consumes.length})`;
    el.appendChild(hd);
    consumes.forEach(({ key, r }) => recipeCard(key, r, 'cons'));
  }
}

// ── Topbar status badges ──────────────────────────────────
export function renderTopbar(openWarnFn) {
  const el = document.getElementById('tbst'); el.innerHTML = '';
  const badge = (txt, cls = '', style = '', onclick = null) => {
    const s = document.createElement('span'); s.className = 'tbb ' + cls;
    if (style) s.style.cssText = style;
    if (onclick) s.addEventListener('click', onclick);
    s.textContent = txt; el.appendChild(s);
  };
  if (SC.name) badge(SC.name);
  if (!RESULT) return;
  const st = RESULT.status || '';
  if (st.startsWith('Optimal')) {
    const objs = Object.entries(RESULT.objective_items || {}).filter(([, v]) => v > 0)
      .map(([k, v]) => `${v.toFixed(1)} ${itemName(k)}/min`).join(' · ');
    badge('✓ ' + (objs || 'Optimal'), 'ok');
  } else if (RESULT.status) badge('✗ ' + st, 'err');
  if (RESULT.total_power_mw  > 0) badge(`⚡ ${RESULT.total_power_mw.toFixed(0)} MW`,  '', 'color:var(--warn);border-color:var(--warn)');
  if (RESULT.total_machines  > 0) badge(`🏭 ${RESULT.total_machines} machines`,        '', 'color:var(--info);border-color:var(--info)');
  if (RESULT.shards_used     > 0) badge(`💎 ${RESULT.shards_used} shards`,             '', 'color:#3b82f6;border-color:#3b82f6');
  if (RESULT.sloops_used     > 0) badge(`🔮 ${RESULT.sloops_used} sloops`,             '', 'color:#a855f7;border-color:#a855f7');
  const wc  = (RESULT.conflict_hints?.length ?? 0) + (RESULT.warnings?.length ?? 0);
  const ec  = Object.keys(RESULT.error_sources  ?? {}).length + Object.keys(RESULT.error_sinks ?? {}).length;
  const sc2 = Object.keys(RESULT.surplus_intermediates ?? {}).length;
  const tot = wc + ec + sc2;
  if (tot > 0) {
    const col = ec > 0 ? 'var(--err)' : sc2 > 0 ? '#f59e0b' : 'var(--warn)';
    badge(`⚠ ${tot} issue${tot !== 1 ? 's' : ''}`, '', `color:${col};border-color:${col};cursor:pointer`, openWarnFn);
  }
}

// ── Warnings modal ────────────────────────────────────────
export function openWarn() {
  if (!RESULT) return;
  const items = [
    ...Object.entries(RESULT.error_sources       ?? {}).map(([k, v]) => ({ t: 'error',   txt: `Missing: ${itemName(k)} — needs ${Number(v).toFixed(1)}/min` })),
    ...Object.entries(RESULT.error_sinks         ?? {}).map(([k, v]) => ({ t: 'error',   txt: `Byproduct: ${itemName(k)} — surplus ${Number(v).toFixed(1)}/min` })),
    ...Object.entries(RESULT.surplus_intermediates ?? {}).map(([k, v]) => ({ t: 'surplus', txt: `Reusable surplus: ${itemName(k)} — +${Number(v).toFixed(1)}/min` })),
    ...(RESULT.conflict_hints ?? []).map(t => ({ t: 'warning', txt: t })),
    ...(RESULT.warnings       ?? []).map(t => ({ t: 'info',    txt: t })),
  ];
  const COL = { error: 'var(--err)', warning: 'var(--warn)', info: 'var(--t3)', surplus: '#f59e0b' };
  const BG  = { error: 'var(--err-dim)', warning: 'var(--warn-dim)', info: 'var(--p3)', surplus: 'rgba(245,158,11,.1)' };
  const ICO = { error: '✕', warning: '⚠', info: 'ℹ', surplus: '↗' };
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

// ── Results bar ───────────────────────────────────────────
export function renderResultsBar() {
  const rb = document.getElementById('rb');
  if (!RESULT?.status?.startsWith('Optimal')) { rb.style.display = 'none'; return; }
  rb.style.display = 'flex'; rb.innerHTML = '';
  const st  = (label, val, color = 'var(--acc)') =>
    `<div class="rbs"><div class="rbv" style="color:${color}">${val}</div><div class="rbl">${label}</div></div>`;
  const sep = '<div class="rbsep"></div>';
  const objs = Object.entries(RESULT.objective_items || {}).filter(([, v]) => v > 0);
  let h = st('Status', 'Optimal', 'var(--ok)') + sep;
  objs.forEach(([k, v]) => { h += st(itemName(k), `${v.toFixed(1)}/m`) + sep; });
  h += st('Machines', RESULT.total_machines) + sep;
  h += st('Power', `${RESULT.total_power_mw?.toFixed(0)} MW`, 'var(--warn)');
  if (RESULT.shards_used > 0) h += sep + st('Shards', RESULT.shards_used, '#3b82f6');
  if (RESULT.sloops_used > 0) h += sep + st('Sloops', RESULT.sloops_used, '#a855f7');
  rb.innerHTML = h;
}

// ── Build cost panel ──────────────────────────────────────
let bcOpen = false;
export function toggleBC() { bcOpen = !bcOpen; renderBuildCost(); }
export function renderBuildCost() {
  const panel  = document.getElementById('bc');
  const cost   = RESULT?.build_cost ?? {};
  const entries = Object.entries(cost);
  const shards = RESULT?.build_cost_shards ?? 0;
  const sloops = RESULT?.build_cost_sloops ?? 0;
  if (!entries.length && !shards && !sloops) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  document.getElementById('bcc').textContent = `${entries.length} items ${bcOpen ? '▲' : '▼'}`;
  const body = document.getElementById('bcb');
  body.style.display = bcOpen ? '' : 'none';
  if (!bcOpen) return;
  body.innerHTML = '';
  entries.forEach(([item, qty]) => {
    const r = document.createElement('div'); r.className = 'bcr';
    r.innerHTML = `<span>${itemName(item)}</span><span>×${qty}</span>`;
    body.appendChild(r);
  });
  if (shards) {
    const r = document.createElement('div'); r.className = 'bcr';
    r.innerHTML = `<span style="color:#3b82f6">💎 Power Shards</span><span style="color:#3b82f6">×${shards}</span>`;
    body.appendChild(r);
  }
  if (sloops) {
    const r = document.createElement('div'); r.className = 'bcr';
    r.innerHTML = `<span style="color:#a855f7">🔮 Somersloops</span><span style="color:#a855f7">×${sloops}</span>`;
    body.appendChild(r);
  }
}

// ── Saved scenarios tab ───────────────────────────────────
export function renderSaved(saved, onLoad, onDelete) {
  const el = document.getElementById('savedlist');
  if (!saved.length) { el.innerHTML = '<p style="font-size:12px;color:var(--t3)">No saved scenarios.</p>'; return; }
  el.innerHTML = '';
  saved.forEach(s => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:5px;padding:6px 8px;background:var(--p3);border-radius:var(--rsm);border:1px solid var(--b)';
    const res = (s.resources || []).slice(0, 3).join(', ');
    row.innerHTML = `
      <div style="flex:1">
        <div style="font-size:12px;color:var(--t)">${s.name}</div>
        <div style="font-size:10px;color:var(--t3);margin-top:1px">${res}</div>
      </div>
      <button class="bsm">Load</button>
      <button class="bsm dan">✕</button>
    `;
    row.querySelectorAll('button')[0].addEventListener('click', () => onLoad(s.key));
    row.querySelectorAll('button')[1].addEventListener('click', () => onDelete(s.key));
    el.appendChild(row);
  });
}
