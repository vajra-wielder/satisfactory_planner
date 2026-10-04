/**
 * dock.js — the right panel: reviewing and improving the factory on screen,
 * next to its graph, without covering it. Four tabs, each a click (or
 * keys 1…4) from anywhere:
 *   Alternates  new ones worth unlocking, and the ones on in this factory
 *   Analysis    what limits the plan
 *   Build cost  the machines and materials to have ready
 *   Issues      what the last solve couldn't do, and fixes
 * Closed, it's a rail of those four with their badges. It stays open across
 * solves, so map ↔ alternates ↔ analysis is no more than a click each.
 */
const $ = id => document.getElementById(id);
const TABS = ['alts', 'analysis', 'build', 'issues'];
let TAB = 'alts';
const listeners = [];

/** onShow(tab): called whenever a tab is shown (to draw what it needs). */
export function onDockTab(fn) { listeners.push(fn); }
export const dockOpen = () => $('app').classList.contains('dk-open');
export const dockTab = () => (dockOpen() ? TAB : null);

export function openDock(tab = TAB) {
  TAB = tab;
  const wasOpen = dockOpen();
  $('app').classList.add('dk-open');
  TABS.forEach(t => { $('dk-' + t).style.display = t === tab ? '' : 'none'; });
  document.querySelectorAll('#dk-rail [data-dk]').forEach(b => b.classList.toggle('act', b.dataset.dk === tab));
  const pane = $('dk-' + tab);
  $('dk-title').textContent = pane.dataset.title;
  $('dk-sub').textContent = pane.dataset.sub || '';
  try { localStorage.setItem('dock', tab); } catch { /* private window */ }
  listeners.forEach(fn => fn(tab));
  if (!wasOpen) window.dispatchEvent(new Event('resize'));   // the graph gives up the room
}

export function closeDock() {
  if (!dockOpen()) return;
  $('app').classList.remove('dk-open');
  document.querySelectorAll('#dk-rail [data-dk]').forEach(b => b.classList.remove('act'));
  try { localStorage.setItem('dock', ''); } catch { /* private window */ }
  window.dispatchEvent(new Event('resize'));
}

/** A tab's rail button: open it, or close the panel if it's the one showing. */
export function toggleDock(tab) { dockTab() === tab ? closeDock() : openDock(tab); }

/** A count on a tab's rail button (empty hides it); kind: ok, warn, bad. */
export function setBadge(id, text, kind = '') {
  const el = $(id);
  if (!el) return;
  el.textContent = text ?? '';
  el.className = 'dk-badge' + (kind ? ' ' + kind : '');
}

export function initDock() {
  document.querySelectorAll('#dk-rail [data-dk]').forEach(b => b.addEventListener('click', () => toggleDock(b.dataset.dk)));
  $('dk-close').addEventListener('click', closeDock);
  // the wheel over the rail steps through the tabs
  let acc = 0, last = 0;
  $('dk-rail').addEventListener('wheel', e => {
    e.preventDefault();
    acc += e.deltaY;
    const now = performance.now();
    if (Math.abs(acc) < 40 || now - last < 180) return;
    last = now;
    const i = TABS.indexOf(dockTab() || TAB);
    openDock(TABS[(i + (acc > 0 ? 1 : -1) + TABS.length) % TABS.length]);
    acc = 0;
  }, { passive: false });
  let saved = null;
  try { saved = localStorage.getItem('dock'); } catch { /* private window */ }
  if (saved && TABS.includes(saved)) openDock(saved);   // as you left it
}
