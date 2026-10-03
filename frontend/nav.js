/**
 * nav.js — getting around: the systems in a ring (the planner, then each
 * Blackboard tab), a Go-to-anything palette, and the shortcuts sheet.
 *
 *   Ctrl+K or /        go to anything: a system, a factory, an action, who makes an item
 *   Alt+← / Alt+→      the previous / next system (also Ctrl+PgUp / PgDn,
 *                      or the mouse wheel over the top bar or the Blackboard's tabs)
 *   Alt+1 … Alt+9      a system by number
 *   Alt+↑ / Alt+↓      the previous / next saved factory
 *   ?                  every shortcut
 *   Esc                closes what's on top
 */

import { ALL_ITEMS, itemName } from './state.js';
import { fetchScenarios } from './api.js';
import { BB_TABS, blackboardOpen, blackboardTab, goBlackboard, closeBlackboard } from './blackboard.js';

const $ = id => document.getElementById(id);
const SYSTEMS = [['planner', 'Planner'], ...BB_TABS];
let API = null;

// ── The ring of systems ─────────────────────────────────────────────────────

const current = () => (blackboardOpen() ? 1 + BB_TABS.findIndex(([t]) => t === blackboardTab()) : 0);

export function goSystem(i) {
  i = ((i % SYSTEMS.length) + SYSTEMS.length) % SYSTEMS.length;
  if (i === 0) { if (blackboardOpen()) closeBlackboard(); }
  else goBlackboard(SYSTEMS[i][0]);
  showRing(i);
}

// A strip of every system with where you are, for a moment
let ringTimer = null;
function showRing(i) {
  let el = $('nav-ring');
  if (!el) { el = document.createElement('div'); el.id = 'nav-ring'; document.body.appendChild(el); }
  el.innerHTML = SYSTEMS.map(([, label], k) => `<span class="${k === i ? 'on' : ''}"><kbd>${k + 1}</kbd>${label}</span>`).join('');
  el.classList.add('show');
  clearTimeout(ringTimer);
  ringTimer = setTimeout(() => el.classList.remove('show'), 1300);
}

function toast(text) {
  let el = $('nav-ring');
  if (!el) { el = document.createElement('div'); el.id = 'nav-ring'; document.body.appendChild(el); }
  el.innerHTML = `<span class="on">${text}</span>`;
  el.classList.add('show');
  clearTimeout(ringTimer);
  ringTimer = setTimeout(() => el.classList.remove('show'), 1300);
}

// The wheel over a strip of tabs moves along it, one step per notch
function wheelSteps(el, step, skip = null) {
  let acc = 0, last = 0;
  el.addEventListener('wheel', e => {
    if (skip && e.target.closest(skip)) return;   // a list in there scrolls as usual
    e.preventDefault();
    acc += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    const now = performance.now();
    if (Math.abs(acc) < 40 || now - last < 180) return;
    last = now;
    step(acc > 0 ? 1 : -1);
    acc = 0;
  }, { passive: false });
}

// ── Saved factories, one after another ──────────────────────────────────────

function stepFactory(d) {
  fetchScenarios().then(list => {
    if (!list.length) { toast('No saved factories yet'); return; }
    const at = list.findIndex(f => f.key === API.currentFactory());
    const k = at < 0 ? (d > 0 ? 0 : list.length - 1) : (at + d + list.length) % list.length;
    if (blackboardOpen()) closeBlackboard();
    API.openFactory(list[k].key);
    toast(`${list[k].name}  <small>${k + 1} of ${list.length}</small>`);
  });
}

// ── Go to anything ──────────────────────────────────────────────────────────

let PAL = { items: [], sel: 0, factories: [] };

function entries(q) {
  const out = [];
  SYSTEMS.forEach(([t, label], i) => out.push({ group: 'Go to', label, keys: `Alt+${i + 1}`, run: () => goSystem(i) }));
  PAL.factories.forEach(f => out.push({ group: 'Factory', label: f.name, keys: f.key === API.currentFactory() ? 'open' : '',
                                        run: () => { if (blackboardOpen()) closeBlackboard(); API.openFactory(f.key); } }));
  API.actions.forEach(a => out.push({ group: 'Do', label: a.label, keys: a.keys || '', run: a.run }));
  if (q.length >= 2)
    ALL_ITEMS.forEach(it => out.push({ group: 'Who makes', label: itemName(it), keys: '', run: () => { goBlackboard('find', it); showRing(1 + BB_TABS.findIndex(([t]) => t === 'find')); } }));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return out.filter(e => e.group !== 'Who makes');
  const hay = e => `${e.label} ${e.group}`.toLowerCase();
  return out.filter(e => words.every(w => hay(e).includes(w)))
    .map(e => ({ e, s: (e.label.toLowerCase().startsWith(words[0]) ? 0 : 1) + (e.group === 'Who makes' ? 2 : 0) }))
    .sort((a, b) => a.s - b.s).map(x => x.e).slice(0, 60);
}

function renderPal() {
  const q = $('nav-pal-q').value.trim();
  PAL.items = entries(q);
  PAL.sel = Math.min(PAL.sel, Math.max(0, PAL.items.length - 1));
  let group = '';
  $('nav-pal-list').innerHTML = PAL.items.length ? PAL.items.map((e, i) => {
    const head = e.group !== group ? `<div class="np-g">${(group = e.group)}</div>` : '';
    return `${head}<div class="np-i ${i === PAL.sel ? 'on' : ''}" data-i="${i}"><span>${e.label}</span>${e.keys ? `<kbd>${e.keys}</kbd>` : ''}</div>`;
  }).join('') : '<div class="np-none">Nothing matches.</div>';
  $('nav-pal-list').querySelector('.np-i.on')?.scrollIntoView({ block: 'nearest' });
}

export function openPalette() {
  let m = $('nav-pal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'nav-pal';
    m.innerHTML = `<div class="np-box"><input id="nav-pal-q" type="text" autocomplete="off"
        placeholder="Go to a system, a factory, an action — or who makes an item"/><div id="nav-pal-list"></div>
      <div class="np-foot"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> go · <kbd>Esc</kbd> close · <kbd>?</kbd> every shortcut</div></div>`;
    document.body.appendChild(m);
    m.addEventListener('mousedown', e => { if (e.target === m) closePalette(); });
    $('nav-pal-q').addEventListener('input', () => { PAL.sel = 0; renderPal(); });
    $('nav-pal-q').addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        PAL.sel = Math.max(0, Math.min(PAL.items.length - 1, PAL.sel + (e.key === 'ArrowDown' ? 1 : -1)));
        renderPal();
      } else if (e.key === 'Enter') { e.preventDefault(); runSel(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
    });
    $('nav-pal-list').addEventListener('click', e => {
      const i = e.target.closest('[data-i]')?.dataset.i;
      if (i != null) { PAL.sel = +i; runSel(); }
    });
  }
  m.classList.add('show');
  $('nav-pal-q').value = '';
  PAL.sel = 0;
  renderPal();
  $('nav-pal-q').focus();
  PAL.loading = fetchScenarios().then(list => { PAL.factories = list; if (m.classList.contains('show')) renderPal(); })
    .catch(() => {}).finally(() => { PAL.loading = null; });
}
function closePalette() { $('nav-pal')?.classList.remove('show'); }
function runSel() {
  // Enter before the factory list has come: wait for it, so a factory typed fast is found
  if (PAL.loading) { PAL.loading.then(() => { renderPal(); runSel(); }); return; }
  const e = PAL.items[PAL.sel];
  if (!e) return;
  closePalette();
  e.run();
}

// ── Every shortcut ──────────────────────────────────────────────────────────

// Each row: its keys (a combo per entry; ~text is said, not a key) and what it does
const HELP = [
  ['Anywhere', [[['Ctrl+K', '~or', '/'], 'Go to anything'],
    [['Alt+←', 'Alt+→'], 'Previous / next system — or the wheel over the top bar or the Blackboard\'s tabs'],
    [['Alt+1', '~…', 'Alt+9'], 'A system: 1 Planner, 2–9 the Blackboard\'s tabs'], [['Alt+↑', 'Alt+↓'], 'Previous / next saved factory'],
    [['Ctrl+P', '~or', 'Ctrl+B'], 'Blackboard'], [['Ctrl+I'], 'Analysis'], [['Ctrl+Q'], 'Recipe lookup'], [['?'], 'This sheet'],
    [['Esc'], 'Close what\'s on top']]],
  ['Planner', [[['Ctrl+R'], 'Solve'], [['Ctrl+S'], 'Save'], [['Ctrl+1', 'Ctrl+2', 'Ctrl+3'], 'Build · Machines & Alts · Saved'],
    [['Ctrl+M'], 'Pick nodes on the map'], [['Ctrl+F'], 'Search the graph'], [['[', '~or', ']'], 'Hide / show the sidebar'],
    [['~the wheel over Build · Machines · Saved'], 'The next tab']]],
  ['Maps', [[['+', '−'], 'Zoom'], [['0'], 'The whole map'], [['←', '↑', '→', '↓'], 'Pan'], [['~double-click'], 'Zoom in there (with Shift: out)'],
    [['G'], 'Geothermal (the Blackboard\'s map)'], [['Shift', '~+ drag'], 'Pick a box of nodes (picking nodes)'],
    [['Enter'], 'Use these nodes (picking nodes)']]],
];
const keysHTML = ks => ks.map(k => (k.startsWith('~') ? `<span class="nh-say">${k.slice(1)}</span>` : `<kbd>${k}</kbd>`)).join(' ');

export function openHelp() {
  let m = $('nav-help');
  if (!m) {
    m = document.createElement('div');
    m.id = 'nav-help';
    m.innerHTML = `<div class="nh-box"><div class="nh-top"><b>Shortcuts</b><button class="bsm" id="nav-help-x">Close</button></div>
      ${HELP.map(([g, rows]) => `<div class="nh-g">${g}</div><table>${rows.map(([k, d]) =>
        `<tr><td>${keysHTML(k)}</td><td>${d}</td></tr>`).join('')}</table>`).join('')}</div>`;
    document.body.appendChild(m);
    m.addEventListener('mousedown', e => { if (e.target === m) m.classList.remove('show'); });
    $('nav-help-x').addEventListener('click', () => m.classList.remove('show'));
  }
  m.classList.add('show');
}

// ── Keys ────────────────────────────────────────────────────────────────────

// What's on top, closed by Esc — first match wins
function closeTop() {
  const shown = id => $(id)?.classList.contains('show');
  if (shown('nav-pal')) { closePalette(); return true; }
  if (shown('nav-help')) { $('nav-help').classList.remove('show'); return true; }
  if (shown('map-modal')) { $('mp-cancel').click(); return true; }
  if (shown('log-modal')) { $('log-modal').classList.remove('show'); return true; }
  if (shown('analysis-modal')) { API.closeAnalysis(); return true; }
  if (shown('wo')) { API.closeWarn(); return true; }
  if (blackboardOpen()) { closeBlackboard(); return true; }
  return false;
}

/** api: { currentFactory(), openFactory(key), closeAnalysis(), closeWarn(),
 *  actions: [{ label, keys, run }] } */
export function initNav(api) {
  API = api;
  window.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (typing && !document.activeElement.closest('#nav-pal')) return;   // inputs keep their own Esc
      if (closeTop()) e.preventDefault();
      return;
    }
    if ((mod && (e.key === 'k' || e.key === 'K')) || (!typing && !mod && !e.altKey && e.key === '/')) {
      e.preventDefault(); openPalette(); return;
    }
    if (!typing && !mod && !e.altKey && e.key === '?') { e.preventDefault(); openHelp(); return; }
    if (e.altKey && !mod) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); goSystem(current() + (e.key === 'ArrowRight' ? 1 : -1)); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); stepFactory(e.key === 'ArrowDown' ? 1 : -1); return; }
      const n = /^Digit([1-9])$/.exec(e.code);
      if (n && +n[1] <= SYSTEMS.length) { e.preventDefault(); goSystem(+n[1] - 1); return; }
    }
    if (mod && !e.altKey && (e.key === 'PageDown' || e.key === 'PageUp')) {
      e.preventDefault(); goSystem(current() + (e.key === 'PageDown' ? 1 : -1)); return;
    }
    // Picking nodes: Enter uses them
    if (e.key === 'Enter' && !typing && $('map-modal')?.classList.contains('show')) { e.preventDefault(); $('mp-apply').click(); }
  }, true);
  // The wheel over the top bar or the Blackboard's tabs moves between systems,
  // over the sidebar's tabs between those
  wheelSteps(document.querySelector('header'), d => goSystem(current() + d), '#tb-rl-panel');
  wheelSteps($('bb-tabs'), d => goSystem(current() + d));
  const sideTabs = [...document.querySelectorAll('.tabbar .tabbt')];
  wheelSteps(document.querySelector('.tabbar'), d => {
    const at = sideTabs.findIndex(b => b.classList.contains('act'));
    sideTabs[(at + d + sideTabs.length) % sideTabs.length].click();
  });
}
