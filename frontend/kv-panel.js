/**
 * kv-panel.js — key/value editor rows for resources, objectives, and constraints.
 * Extracted from sidebar.js.
 *
 * Owns:
 *   - KVS registry (one entry per named panel)
 *   - renderKv / addKv / syncKv / loadAllKv
 *
 * Callers:
 *   - sidebar.js calls loadAllKv() inside fillUI()
 *   - sidebar.js calls syncKv per panel inside readUI()
 *   - main.js calls addKv(name) on add-row button clicks
 */

import { SC, ALL_ITEMS, itemName } from './state.js';
import { makeAC } from './sidebar.js';

// ── Expression evaluator ──────────────────────────────────
// Safely evaluates a PEMDAS arithmetic expression string.
// Allows digits, spaces, and operators +-*/()%.
// Returns the numeric result, or null if invalid/unsafe.
function evalExpr(raw) {
  const s = raw.trim();
  if (!s) return null;
  // Whitelist: only digits, spaces, and arithmetic characters
  if (!/^[\d\s+\-*/().%]+$/.test(s)) return null;
  try {
    // Use Function instead of eval to avoid scope leakage
    // eslint-disable-next-line no-new-func
    const result = Function('"use strict"; return (' + s + ')')();
    if (typeof result !== 'number' || !isFinite(result)) return null;
    return result;
  } catch {
    return null;
  }
}

// ── Registry ──────────────────────────────────────────────
// Each panel maps to a SC field and maintains its own row list.
export const KVS = {
  res:  { field: 'available_resources', rows: [] },
  obj:  { field: 'objective',           rows: [] },
  must: { field: 'must_produce',        rows: [] },
  min:  { field: 'min_produce',         rows: [] },
  max:  { field: 'max_produce',         rows: [] },
};

// ── Sync ──────────────────────────────────────────────────
// Write the current row state for one panel back into SC.
// Called on every keystroke/change so SC is always up to date.
export function syncKv(name) {
  const st = KVS[name];
  SC[st.field] = {};
  st.rows.forEach(({ key, val }) => {
    if (!key) return;
    const evaled = evalExpr(String(val));
    SC[st.field][key] = evaled !== null ? evaled : (parseFloat(val) || 0);
  });
  if (name === 'res')
    SC.unlimited_resources = st.rows.filter(r => r.key && r.unlimited).map(r => r.key);
}

// Sync all panels at once — used by readUI() before a solve.
export function syncAllKv() {
  Object.keys(KVS).forEach(syncKv);
}

// ── Load ──────────────────────────────────────────────────
// Populate rows from the current SC field, then re-render.
function loadKvFromScenario(name) {
  const st = KVS[name];
  const unlimited = new Set(name === 'res' ? SC.unlimited_resources || [] : []);
  st.rows = Object.entries(SC[st.field] || {}).map(([key, val]) => ({
    key,
    val: String(val),
    unlimited: unlimited.has(key),
  }));
  renderKv(name);
}

// Load all panels — called by fillUI() when the active scenario changes.
export function loadAllKv() {
  Object.keys(KVS).forEach(loadKvFromScenario);
}

// ── Render ────────────────────────────────────────────────
export function renderKv(name, focusRowIndex = -1, focusTarget = 'key') {
  const st = KVS[name];
  const c  = document.getElementById('kv-' + name);
  c.innerHTML = '';

  const keyInputs = [];
  const valInputs = [];

  st.rows.forEach((row, i) => {
    const div  = document.createElement('div');
    div.className = name === 'res' ? 'kvr kvr-res' : 'kvr';
    const wrap = document.createElement('div'); wrap.className = 'acw';

    // ── Item key input ───────────────────────────────────
    const ki = document.createElement('input');
    ki.type        = 'text';
    ki.placeholder = 'Item…';
    ki.value       = row.key ? itemName(row.key) : '';
    ki.addEventListener('change', () => {
      const raw   = ki.value.trim().replace(/\s+/g, '_');
      const found = ALL_ITEMS.find(k =>
        k.toLowerCase() === raw.toLowerCase() ||
        itemName(k).toLowerCase() === ki.value.trim().toLowerCase()
      );
      row.key = found || raw;
      syncKv(name);
    });
    wrap.appendChild(ki);
    keyInputs.push(ki);

    // ── Rate value input ─────────────────────────────────
    // type="text" so expressions like (240*2+120)/30 can be entered.
    // evalExpr() resolves the expression on blur or Enter; while typing
    // the raw string is stored so the cursor isn't disturbed mid-edit.
    const vi = document.createElement('input');
    vi.type        = 'text';
    vi.inputMode   = 'decimal';
    vi.placeholder = '0';
    vi.style.fontFamily = 'var(--mono)';
    vi.style.fontSize   = '12px';
    vi.value = row.val || '';

    // Resolve expression and commit to row.val
    function commitVal() {
      const result = evalExpr(vi.value);
      if (result !== null) {
        // Round to a sensible precision (up to 6 significant digits)
        const rounded = parseFloat(result.toPrecision(6));
        vi.value  = String(rounded);
        row.val   = vi.value;
      } else if (vi.value.trim() === '') {
        row.val = '';
      }
      // If expression is invalid, leave the field as-is so the user can fix it
      syncKv(name);
    }

    vi.addEventListener('input',  () => { row.val = vi.value; syncKv(name); });
    vi.addEventListener('blur',   commitVal);
    valInputs.push(vi);

    // ── Remove button ────────────────────────────────────
    const rb = document.createElement('button');
    rb.className = 'bi';
    rb.innerHTML = '✕';
    rb.addEventListener('click', () => {
      st.rows.splice(i, 1);
      div.remove();
      syncKv(name);
    });

    div.appendChild(wrap);
    div.appendChild(vi);

    // ── Unlimited toggle (resources only) ────────────────
    // An unlimited resource has no cap and costs nothing, so an abundant one
    // like Water doesn't dilute the finite resources in the solver's score.
    if (name === 'res') {
      const ub = document.createElement('button');
      ub.className = 'bi binf';
      ub.innerHTML = '∞';
      const paint = () => {
        ub.classList.toggle('on', !!row.unlimited);
        ub.title = row.unlimited
          ? 'Unlimited — click to use the amount instead'
          : 'Treat as unlimited (no cap, free)';
        vi.disabled = !!row.unlimited;
        vi.value = row.unlimited ? '∞' : (row.val || '');
      };
      ub.addEventListener('click', () => { row.unlimited = !row.unlimited; paint(); syncKv(name); });
      paint();
      div.appendChild(ub);
    }
    div.appendChild(rb);
    c.appendChild(div);
  });

  // Wire autocomplete after all inputs exist
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

  // Enter on a value input evaluates the expression, then advances to next row (or appends one)
  valInputs.forEach((vi, i) => {
    vi.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      // Resolve expression first
      const result = evalExpr(vi.value);
      if (result !== null) {
        const rounded = parseFloat(result.toPrecision(6));
        vi.value = String(rounded);
        st.rows[i].val = vi.value;
      } else {
        st.rows[i].val = vi.value;
      }
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

  // Focus the requested row after render
  if (focusRowIndex >= 0 && focusRowIndex < st.rows.length) {
    requestAnimationFrame(() => {
      const el = focusTarget === 'val' ? valInputs[focusRowIndex] : keyInputs[focusRowIndex];
      if (el) { el.focus(); el.select(); }
    });
  }
}

// ── Add row ───────────────────────────────────────────────
export function addKv(name) {
  KVS[name].rows.push({ key: '', val: '' });
  renderKv(name, KVS[name].rows.length - 1, 'key');
}
