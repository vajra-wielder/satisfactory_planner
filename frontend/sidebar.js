/**
 * sidebar.js — sidebar shell: tabs, section collapse, autocomplete, fillUI/readUI.
 *
 * Panels are in their own modules:
 *   kv-panel.js      — resource/objective/constraint KV editors
 *   machines-panel.js — machines tier chips + alternates tree
 *
 * fillUI  — SC → DOM  (call when loading a scenario or resetting)
 * readUI  — DOM → SC  (call before dispatching a solve or save)
 *
 * Both go through setScenario() for scalar fields so SC mutations
 * always have a single, traceable update path.
 */

import { SC, ALL_ITEMS, itemName, setScenario, PROGRESS } from './state.js';
import { loadAllKv, syncAllKv }                  from './kv-panel.js';
import { loadSupply, syncSupply }                from './supply-panel.js';
import { renderMachines, updMachBadge,
         renderAlts,     updAltBadge  }           from './machines-panel.js';

// ── Re-exports consumed by main.js ────────────────────────
// kv-panel
export { addKv }        from './kv-panel.js';
// machines-panel
export { altsAll, altsNone, setUnlockedSaver, setUnlockedAlts,
         renderMachines, updMachBadge, renderAlts, updAltBadge } from './machines-panel.js';

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
// AUTOCOMPLETE  (shared helper — used by kv-panel.js too)
// ══════════════════════════════════════════════════════════
// opts.commit: typed text that names an item commits when you leave the box
// (not only a pick from the list); text that names none stays, marked, for you
// to fix, and opts.onType(text) keeps it across a redraw.
export function makeAC(input, onPick, dropParent, source = null, opts = {}) {
  let drop = null, cursor = -1;
  let _lastQ = null, _lastSuggestions = null;

  function suggestions(q) {
    if (!source && q === _lastQ) return _lastSuggestions;
    _lastQ = q;
    const pool = source ? source() : ALL_ITEMS;
    if (!q) return (_lastSuggestions = pool.slice(0, source ? 30 : 10));
    const ql = q.toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
    const qd = q.toLowerCase();
    _lastSuggestions = pool
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

  // The item typed text names: its name or key exactly, in the list first, then any item
  function named(text) {
    const t = text.trim().toLowerCase();
    if (!t) return null;
    const is = k => itemName(k).toLowerCase() === t || k.toLowerCase() === t.replace(/\s+/g, '_');
    return (source ? source() : []).find(is) || ALL_ITEMS.find(is) || null;
  }
  const mark = () => {
    const bad = !!input.value.trim() && !named(input.value);
    input.classList.toggle('ac-bad', bad);
    input.title = bad ? 'Not an item — pick one from the list' : '';
  };
  if (opts.commit) {
    input.addEventListener('change', () => {
      opts.onType?.(input.value);
      const key = named(input.value);
      if (key && (itemName(key) !== input.value || opts.current?.() !== key)) {
        input.value = itemName(key);
        (opts.onCommit || onPick)(key);   // in place, so the click that left the box still lands
      }
      mark();
    });
    input.addEventListener('input', () => { opts.onType?.(input.value); input.classList.remove('ac-bad'); });
    mark();
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
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cursor = Math.min(cursor + 1, its.length - 1);
      its.forEach((el, i) => el.classList.toggle('active', i === cursor));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      its.forEach((el, i) => el.classList.toggle('active', i === cursor));
    }
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
// FILL / READ UI
//
// fillUI  — SC → DOM.  Single source of truth for populating
//           the form from the current scenario object.
//
// readUI  — DOM → SC.  Reads scalar inputs and calls syncAllKv
//           so every panel's KV state is flushed before a solve
//           or save.  All scalar writes go through setScenario()
//           so mutations are traceable and never silently partial.
// ══════════════════════════════════════════════════════════

export function fillUI({ skipMachines = false } = {}) {
  // Scalar fields — DOM ← SC
  document.getElementById('sc-name').value = SC.name        || '';
  document.getElementById('sc-desc').value = SC.description || '';
  document.getElementById('sc-sh').value   = SC.power_shards_available ?? '';
  document.getElementById('sc-sl').value   = SC.somersloops_available  ?? '';
  document.getElementById('sc-mp').value   = SC.max_power_mw           ?? '';
  document.getElementById('sc-nt').value   = SC.notes || '';

  // Min New Alts toggle
  const mnaBtn = document.getElementById('ssc-min-new-alts');
  if (mnaBtn) mnaBtn.classList.toggle('on', !!SC.minimize_new_alts);
  document.getElementById('ssc-machines-first')?.classList.toggle('on', !!SC.machines_first);
  document.querySelectorAll('#sl-mode button').forEach(b =>
    b.classList.toggle('on', b.dataset.mode === (SC.sloop_search || 'dive')));

  // KV panels
  loadAllKv();
  loadSupply();

  // Machines & alts — skipped at boot; rendered lazily on first tab open
  if (!skipMachines) {
    renderMachines(); updMachBadge();
    renderAlts();     updAltBadge();
  }
}

export function readUI() {
  // All scalar fields go through setScenario so updates are centralised.
  const mnaBtn = document.getElementById('ssc-min-new-alts');
  setScenario({
    name:                   document.getElementById('sc-name').value || 'New Factory',
    description:            document.getElementById('sc-desc').value || '',
    power_shards_available: _pn(document.getElementById('sc-sh').value),
    somersloops_available:  _pn(document.getElementById('sc-sl').value),
    max_power_mw:           _pn(document.getElementById('sc-mp').value),
    notes:                  document.getElementById('sc-nt').value || '',
    minimize_new_alts:      mnaBtn ? mnaBtn.classList.contains('on') : false,
    machines_first:         !!document.getElementById('ssc-machines-first')?.classList.contains('on'),
    sloop_search:           document.querySelector('#sl-mode button.on')?.dataset.mode || 'dive',
  });

  SC.enabled_machines = [...(PROGRESS.machines || [])];   // shared, for every factory

  // Flush all KV panels into SC (each panel writes its own SC field)
  syncAllKv();
  syncSupply();
}

// Treat empty / null as null, otherwise parse float
function _pn(v) {
  return (v === '' || v == null) ? null : parseFloat(v) || 0;
}
