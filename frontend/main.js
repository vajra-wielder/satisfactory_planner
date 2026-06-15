/**
 * main.js — application boot and DOM wiring.
 *
 * This is the single entry point loaded by index.html as:
 *   <script type="module" src="/frontend/main.js"></script>
 *
 * It imports everything it needs from the other modules and owns all
 * addEventListener calls and the startup Promise.all. Nothing else touches
 * the DOM directly at the top level.
 */

import {
  SC, RESULT,
  setResult, resetSC, setAllItems, setRecipes, buildItemDisplay,
  nextSolveSeq, solveSeq,
  PINS, setPins,
} from './state.js';

import {
  fetchAllItems, fetchRecipes, fetchItemDisplay,
  fetchScenarios, fetchScenario, saveScenario, deleteScenario, solveScenario,
} from './api.js';

import {
  toggleSec, initTabs, activateTab,
  addKv,
  fillUI, readUI,
  altsAll, altsNone,
} from './sidebar.js';

import {
  openWarn, closeWarn,
  renderResultsBar, renderBuildCost, toggleBC,
  renderSaved,
} from './ui.js';

import { initRecipeLookup } from './recipe-lookup.js';
import { openAnalysis, closeAnalysis } from './analysis.js';

import {
  isPinboardActive, enterPinboard, exitPinboard,
  initPinboardEvents, updatePinBadge, rebuild as rebuildPinboard,
  resize as resizePinboard, fitAll as fitPinboard, draw as drawPinboard,
} from './pinboard.js';

import {
  resize, initLayout, draw,
  fitAll, zoomBy, openSearch, initGraphEvents,
} from './graph.js';


// ── Pinboard toggle ───────────────────────────────────────────────────────────

let pinboardMode = false;

function togglePinboard() {
  pinboardMode = !pinboardMode;
  const btn = document.getElementById('btn-pinboard');
  if (pinboardMode) {
    btn.classList.add('pinboard-active');
    enterPinboard();
  } else {
    btn.classList.remove('pinboard-active');
    exitPinboard();
    // Restore graph
    const { initLayout, draw, resize } = graphModule;
    resize(); initLayout(); draw();
  }
}

// Store graph module ref for restoration
let graphModule = null;


// ── Sidebar open/close ────────────────────────────────────────────────────────

let sidebarOpen = true;

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  document.getElementById('app').classList.toggle('sb-collapsed', !sidebarOpen);
  setTimeout(() => { resize(); draw(); }, 250);
}

function expandToTab(tab) {
  if (!sidebarOpen) {
    sidebarOpen = true;
    document.getElementById('app').classList.remove('sb-collapsed');
    setTimeout(() => { resize(); draw(); }, 250);
  }
  activateTab(tab);
  if (tab === 'saved') loadSaved();
}


// ── Issues badge ─────────────────────────────────────────────────────────────

function updateIssuesBadge(result) {
  const wc  = (result?.conflict_hints?.length ?? 0)
            + (result?.warnings?.length ?? 0);
  const ec  = Object.keys(result?.error_sources ?? {}).length
            + Object.keys(result?.error_sinks   ?? {}).length;
  const sc  = Object.keys(result?.surplus_intermediates ?? {}).length;
  const tot = wc + ec + sc;
  const btn = document.getElementById('btn-issues');
  if (tot > 0) {
    const col = ec > 0 ? 'var(--err)' : sc > 0 ? '#f59e0b' : 'var(--warn)';
    btn.style.setProperty('--issue-col', col);
    document.getElementById('btn-issues-count').textContent = tot;
    btn.style.display = '';
  } else {
    btn.style.display = 'none';
  }
}


// ── Solve ─────────────────────────────────────────────────────────────────────

let solving = false;
let solveAbort = null;  // AbortController for the in-flight solve fetch

function handleSolve() {
  // Cancel any in-flight request before starting a new one
  if (solveAbort) {
    solveAbort.abort();
    solveAbort = null;
  }

  readUI();
  const payload = { ...SC };
  if (payload.power_shards_available == null) payload.power_shards_available = 0;
  if (payload.somersloops_available  == null) payload.somersloops_available  = 0;

  solving = true;
  solveAbort = new AbortController();
  const mySeq = nextSolveSeq();
  const myAbort = solveAbort;
  const btn = document.getElementById('bsolve');
  btn.disabled = true;
  btn.textContent = 'Solving…';

  // Animated progress dots so the UI feels alive during long solves
  const _dotFrames = ['Solving·', 'Solving··', 'Solving···', 'Solving…'];
  let _dotIdx = 0;
  const _dotTimer = setInterval(() => {
    if (btn.disabled) btn.textContent = _dotFrames[_dotIdx++ % _dotFrames.length];
  }, 400);

  solveScenario(payload, myAbort.signal)
    .then(result => {
      // Discard stale results if a newer solve was fired
      if (mySeq !== solveSeq) return;
      setResult(result);
      updateIssuesBadge(result);
      const hasIssues = result.conflict_hints?.length > 0
        || result.warnings?.length > 0
        || Object.keys(result.error_sources ?? {}).length > 0
        || Object.keys(result.error_sinks   ?? {}).length > 0;
      if (hasIssues) openWarn();
    })
    .catch(err => {
      if (err.name === 'AbortError') return;  // intentionally cancelled
      if (mySeq !== solveSeq) return;
      setResult({
        status: 'Error: ' + err.message, flows: [], net_items: {},
        objective_items: {}, build_cost: {}, source_nodes: {}, sink_nodes: {},
        error_sources: {}, error_sinks: {}, surplus_intermediates: {},
        warnings: [err.message], conflict_hints: [],
      });
      updateIssuesBadge(RESULT);
    })
    .finally(() => {
      clearInterval(_dotTimer);
      if (mySeq !== solveSeq) return;
      solving = false;
      solveAbort = null;
      btn.disabled = false;
      btn.textContent = '▶ Solve';
      renderResultsBar();
      renderBuildCost();
      initLayout();
    });
}


// ── Save ──────────────────────────────────────────────────────────────────────

function handleSave() {
  readUI();
  const key = SC.name.replace(/\s+/g, '_').toLowerCase();
  // Embed pins into the scenario payload
  const payload = { ...SC, pinboard: PINS };
  saveScenario(key, payload)
    .then(() => {
      const b = document.getElementById('bsave');
      b.textContent = 'Saved!';
      setTimeout(() => { b.textContent = '💾 Save'; }, 2200);
      loadSaved();
    })
    .catch(err => alert('Save failed: ' + err.message));
}


// ── Reset ─────────────────────────────────────────────────────────────────────

function handleReset() {
  resetSC();
  setResult(null);
  setPins(null);
  fillUI();
  renderResultsBar();
  renderBuildCost();
  updatePinBadge();
  document.getElementById('btn-issues').style.display = 'none';
  if (pinboardMode) { pinboardMode = false; exitPinboard(); document.getElementById('btn-pinboard').classList.remove('pinboard-active'); }
  initLayout();
}


// ── Load saved scenarios ──────────────────────────────────────────────────────

function loadSaved() {
  fetchScenarios()
    .then(saved => {
      renderSaved(
        saved,
        key => fetchScenario(key).then(data => {
          Object.assign(SC, data);
          if (data.pinboard) setPins(data.pinboard);
          else setPins(null);
          setResult(null);
          fillUI();
          updatePinBadge();
          if (pinboardMode) rebuildPinboard();
          else initLayout();
        }),
        key => deleteScenario(key).then(loadSaved),
      );
    })
    .catch(() => {
      const el = document.getElementById('savedlist');
      if (el) el.innerHTML = '<p style="font-size:12px;color:var(--t3)">Server not reachable.</p>';
    });
}


// ── DOM wiring ────────────────────────────────────────────────────────────────

// <script type="module"> is deferred by default, so the DOM is already ready
// when this runs — no DOMContentLoaded wrapper needed.

// Topbar
document.getElementById('sb-toggle')    .addEventListener('click', toggleSidebar);
document.getElementById('btn-analysis') .addEventListener('click', openAnalysis);
document.getElementById('btn-pinboard') .addEventListener('click', togglePinboard);
document.getElementById('btn-issues')   .addEventListener('click', openWarn);

// Rail
document.getElementById('rail-build')   .addEventListener('click', () => expandToTab('build'));
document.getElementById('rail-machalt') .addEventListener('click', () => expandToTab('machalt'));
document.getElementById('rail-saved')   .addEventListener('click', () => expandToTab('saved'));
document.getElementById('rail-solve')   .addEventListener('click', handleSolve);

// Section toggles
['res', 'goals', 'oc', 'nt'].forEach(id =>
  document.getElementById('tog-' + id).addEventListener('click', () => toggleSec(id)));

// KV add-row buttons
document.getElementById('add-res') .addEventListener('click', () => addKv('res'));
document.getElementById('add-obj') .addEventListener('click', () => addKv('obj'));
document.getElementById('add-must').addEventListener('click', () => addKv('must'));
document.getElementById('add-min') .addEventListener('click', () => addKv('min'));
document.getElementById('add-max') .addEventListener('click', () => addKv('max'));

// Alternates
document.getElementById('btn-alts-all') .addEventListener('click', altsAll);
document.getElementById('btn-alts-none').addEventListener('click', altsNone);

// Solve / Save / Reset
document.getElementById('bsolve').addEventListener('click', handleSolve);
document.getElementById('bsave') .addEventListener('click', handleSave);
document.getElementById('breset').addEventListener('click', handleReset);

// Build cost
document.getElementById('bc-toggle').addEventListener('click', toggleBC);

// Graph controls
document.getElementById('btn-zoom-in') .addEventListener('click', () => zoomBy(1.2));
document.getElementById('btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
document.getElementById('btn-fit')     .addEventListener('click', fitAll);
document.getElementById('btn-search')  .addEventListener('click', openSearch);

// Modals
document.getElementById('wo')                .addEventListener('click', closeWarn);
document.getElementById('wm')                .addEventListener('click', e => e.stopPropagation());
document.getElementById('btn-close-warn')    .addEventListener('click', closeWarn);
document.getElementById('analysis-modal')    .addEventListener('click', closeAnalysis);
document.getElementById('analysis-box')      .addEventListener('click', e => e.stopPropagation());
document.getElementById('btn-close-analysis').addEventListener('click', closeAnalysis);

// Keyboard shortcuts
window.addEventListener('keydown', e => {
  const tag     = document.activeElement?.tagName;
  const inInput = tag === 'INPUT' || tag === 'TEXTAREA';
  const mod     = e.ctrlKey || e.metaKey;

  if ((e.key === '[' || e.key === ']') && !mod && !inInput) {
    toggleSidebar();
    return;
  }
  if (!mod) return;

  switch (e.key.toLowerCase()) {
    case 'r': e.preventDefault(); handleSolve(); break;
    case 's': e.preventDefault(); handleSave();  break;
    case 'p': e.preventDefault(); togglePinboard(); break;
    case 'q': {
      e.preventDefault();
      const inp = document.getElementById('tb-rl-input');
      if (inp) { inp.focus(); inp.select(); }
      break;
    }
    case 'a':
      if (!inInput) { e.preventDefault(); expandToTab('machalt'); }
      break;
    case 'f':
      e.preventDefault();
      openSearch();
      break;
  }
});


// ── Boot — fetch game data then initialise ────────────────────────────────────

const ge = document.getElementById('ge');
ge.querySelector('p').textContent = 'Loading game data...';

Promise.all([fetchAllItems(), fetchRecipes(), fetchItemDisplay()])
  .then(([items, recipes, display]) => {
    setAllItems(items);
    setRecipes(recipes);
    buildItemDisplay(display);
    ge.querySelector('p').textContent = 'Configure your factory and hit Solve';

    initTabs(tab => { if (tab === 'saved') loadSaved(); });
    initRecipeLookup();
    initGraphEvents();
    initPinboardEvents();
    graphModule = { initLayout, draw, resize };
    updatePinBadge();
    fillUI();
    resize();
    draw();
  })
  .catch(err => {
    ge.querySelector('p').textContent =
      'Boot error: ' + err.message + ' — is server.py running?';
    console.error(err);
  });
