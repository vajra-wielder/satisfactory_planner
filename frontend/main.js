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
  SC, RESULT, RECIPES,
  setResult, resetSC, setAllItems, setRecipes, buildItemDisplay,
  nextSolveSeq, solveSeq,
  PINS, setPins,
} from './state.js';

import {
  fetchBoot,
  fetchScenarios, fetchScenario, saveScenario, deleteScenario, solveScenario,
} from './api.js';

import {
  toggleSec, initTabs, activateTab,
  addKv,
  fillUI, readUI,
  altsAll, altsNone,
  setUnlockedSaver, setUnlockedAlts,
  renderMachines, updMachBadge, renderAlts, updAltBadge,
} from './sidebar.js';

// Panels are imported here only so their modules are loaded eagerly;
// all interaction goes through sidebar.js re-exports above.

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
  toggleHubs, toggleMinor,
} from './graph.js';


// ── Solve styles ──────────────────────────────────────────────────────────────
// Transient modifiers applied to the solve payload only — never mutate SC.

const SOLVE_STYLES = new Set();  // active style ids

function initSolveStyles() {
  document.querySelectorAll('.ssc').forEach(btn => {
    if (btn.id === 'ssc-min-new-alts') return;  // wired separately below
    btn.addEventListener('click', () => {
      const s = btn.dataset.style;
      if (SOLVE_STYLES.has(s)) SOLVE_STYLES.delete(s);
      else SOLVE_STYLES.add(s);
      btn.classList.toggle('on', SOLVE_STYLES.has(s));
    });
  });

  const mnaBtn = document.getElementById('ssc-min-new-alts');
  if (mnaBtn) {
    mnaBtn.addEventListener('click', () => {
      SC.minimize_new_alts = !SC.minimize_new_alts;
      mnaBtn.classList.toggle('on', SC.minimize_new_alts);
    });
  }
}

// ── Shared byproduct item sets ────────────────────────────────────────────────
// Returns { intermediates, consumedByEnabled } filtered to only recipes that
// are enabled in this payload — mirrors the pruner's is_allowed logic exactly.
//
// IMPORTANT: we do a forward-reachability pass first (same logic as solver's
// Phase 1 pruning) so that `intermediates` only contains items reachable from
// the actual available resources.  Without this, items like Silica or Battery
// appear in `intermediates` just because some enabled recipe produces them —
// even though those recipes are completely unreachable in this scenario — and
// hard-capping them at 0 either does nothing useful or triggers spurious errors.
function _byproductSets(p) {
  const enabledMachines = new Set(p.enabled_machines || []);
  const enabledAlts     = new Set(p.alternate_recipes_enabled || []);

  // Filter to allowed recipes only (same is_allowed as solver)
  const allowedRecipes = {};
  Object.entries(RECIPES).forEach(([key, r]) => {
    if (enabledMachines.size > 0 && !enabledMachines.has(r.machine)) return;
    if (r.alternate && !enabledAlts.has(key)) return;
    allowedRecipes[key] = r;
  });

  // Forward reachability: which items can be produced starting from resources?
  const resources = new Set(Object.keys(p.available_resources || {}));
  const grounded  = new Set(resources);

  // blocked[key] = set of inputs not yet grounded
  const blocked    = {};
  const waitingOn  = {};   // item -> [recipe keys]
  Object.entries(allowedRecipes).forEach(([key, r]) => {
    const missing = Object.keys(r.inputs).filter(inp => !grounded.has(inp));
    blocked[key] = new Set(missing);
    missing.forEach(inp => {
      if (!waitingOn[inp]) waitingOn[inp] = [];
      waitingOn[inp].push(key);
    });
  });

  const reachableRecipes = new Set();
  const worklist = Object.keys(blocked).filter(k => blocked[k].size === 0);
  worklist.forEach(k => reachableRecipes.add(k));

  let head = 0;
  while (head < worklist.length) {
    const k = worklist[head++];
    Object.keys(allowedRecipes[k].outputs).forEach(item => {
      if (grounded.has(item)) return;
      grounded.add(item);
      (waitingOn[item] || []).forEach(k2 => {
        if (reachableRecipes.has(k2)) return;
        blocked[k2].delete(item);
        if (blocked[k2].size === 0) {
          reachableRecipes.add(k2);
          worklist.push(k2);
        }
      });
    });
  }

  // Now collect produced/consumed sets from *reachable* recipes only
  const consumedByEnabled = new Set();
  const producedByEnabled = new Set();
  reachableRecipes.forEach(key => {
    const r = allowedRecipes[key];
    Object.keys(r.inputs ).forEach(k => consumedByEnabled.add(k));
    Object.keys(r.outputs).forEach(k => producedByEnabled.add(k));
  });

  const goals = new Set([
    ...Object.keys(p.objective     || {}),
    ...Object.keys(p.must_produce  || {}),
    ...Object.keys(p.min_produce   || {}),
    ...Object.keys(p.max_produce   || {}),
  ]);

  // Intermediates = items reachable from resources that are neither goals nor
  // raw resources themselves.  These are the only items worth capping.
  const intermediates = [...producedByEnabled].filter(
    item => !goals.has(item) && !resources.has(item)
  );

  return { intermediates, consumedByEnabled };
}

// Hard mode: cap recyclable intermediates at max_produce = 0.
// Only items that have a reachable consumer get capped — if there's no enabled
// recipe that can absorb an item, capping it at 0 would make the LP infeasible
// whenever a recipe is forced to produce it as a co-product (e.g. Heavy Oil
// Residue alongside Rubber).  The fallback in handleSolve covers the edge case
// where even a reachable consumer can't absorb the full surplus.
function _applyHardCaps(p) {
  const { intermediates, consumedByEnabled } = _byproductSets(p);
  intermediates.forEach(item => {
    if (!consumedByEnabled.has(item)) return;   // no reachable consumer — skip
    const existing = p.max_produce[item];
    if (existing === undefined || existing > 0) {
      p.max_produce[item] = 0;
    }
  });
  return p;
}

// Soft mode: add a small negative objective weight on surplus intermediates.
// Never causes infeasibility — just biases the solver away from waste.
function _applySoftPenalty(p) {
  const { intermediates } = _byproductSets(p);
  intermediates.forEach(item => {
    if (!(item in (p.objective || {}))) {
      p.objective = p.objective || {};
      p.objective[item] = (p.objective[item] || 0) - 0.001;
    }
  });
  return p;
}

function applyStylesFirstPass(payload, { hardByproducts = true } = {}) {
  const p = JSON.parse(JSON.stringify(payload));  // deep copy — never mutate SC

  if (SOLVE_STYLES.has('no-byproducts')) {
    // no-byproducts: attempt hard caps first. If the solve comes back infeasible,
    // handleSolve retries with hardByproducts=false (soft penalty fallback).
    if (hardByproducts) {
      _applyHardCaps(p);
    } else {
      _applySoftPenalty(p);
    }
  }

  return p;
}

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

// ── Lazy machines/alts render ─────────────────────────────────────────────────
// renderMachines + renderAlts touch 107 alt chips — skipped at boot and only
// run when the Machines & Alts tab is first opened, or marked dirty by a
// scenario load/reset.

let _machinesDirty = true;

function renderMachinesIfNeeded() {
  if (!_machinesDirty) return;
  _machinesDirty = false;
  renderMachines(); updMachBadge();
  renderAlts();     updAltBadge();
}


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
  const basePayload = { ...SC };
  if (basePayload.power_shards_available == null) basePayload.power_shards_available = 0;
  if (basePayload.somersloops_available  == null) basePayload.somersloops_available  = 0;

  // Apply first-pass style transforms (no-byproducts tries hard caps first)
  const payload = applyStylesFirstPass(basePayload, { hardByproducts: true });

  solving = true;
  solveAbort = new AbortController();
  const mySeq = nextSolveSeq();
  const myAbort = solveAbort;
  const btn = document.getElementById('bsolve');
  btn.disabled = true;
  btn.textContent = 'Solving…';

  // Animated progress dots
  const _dotFrames = ['Solving·', 'Solving··', 'Solving···', 'Solving…'];
  let _dotIdx = 0;
  const _dotTimer = setInterval(() => {
    if (btn.disabled) btn.textContent = _dotFrames[_dotIdx++ % _dotFrames.length];
  }, 400);

  // Phase 1 solve — with fallback for no-byproducts hard cap infeasibility.
  // If hard caps make the LP infeasible (e.g. a byproduct is unavoidable at
  // the required scale), we retry transparently with the soft penalty instead.
  const _runPhase1 = async () => {
    let result = await solveScenario(payload, myAbort.signal);

    if (
      SOLVE_STYLES.has('no-byproducts') &&
      !result?.status?.startsWith('Optimal')
    ) {
      btn.textContent = 'Relaxing…';
      const softPayload = applyStylesFirstPass(basePayload, { hardByproducts: false });
      result = await solveScenario(softPayload, myAbort.signal);
      if (result?.status?.startsWith('Optimal')) {
        result.warnings = result.warnings || [];
        result.warnings.unshift(
          'No Byproducts: hard caps caused infeasibility — fell back to soft penalty. ' +
          'Some byproducts may remain; consider adding consumers or relaxing constraints.'
        );
      }
    }

    return result;
  };

  _runPhase1()
    .then(result => {
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
      if (err.name === 'AbortError') return;
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
  _machinesDirty = true;
  fillUI({ skipMachines: true });
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
          _machinesDirty = true;
          fillUI({ skipMachines: true });
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
document.getElementById('btn-hubs')    .addEventListener('click', e => e.currentTarget.classList.toggle('on', toggleHubs()));
document.getElementById('btn-minor')   .addEventListener('click', e => e.currentTarget.classList.toggle('on', toggleMinor()));

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

Promise.all([fetchBoot()])
  .then(([boot]) => {
    const { items, recipes, item_display: display, unlocked_alts } = boot;
    setAllItems(items);
    setRecipes(recipes);
    buildItemDisplay(display);
    setUnlockedAlts(unlocked_alts || []);
    ge.querySelector('p').textContent = 'Configure your factory and hit Solve';

    initTabs(tab => {
      if (tab === 'saved') loadSaved();
      if (tab === 'machalt') renderMachinesIfNeeded();
    });
    initRecipeLookup();
    initSolveStyles();
    initGraphEvents();
    initPinboardEvents();
    graphModule = { initLayout, draw, resize };
    updatePinBadge();
    fillUI({ skipMachines: true });   // skip machines/alts — rendered lazily on first tab open
    resize();
    draw();

    setUnlockedSaver(keys =>
      fetch('/api/unlocked-alts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unlocked: keys }),
      }).then(r => {
        if (!r.ok) throw new Error('Save failed: ' + r.status);
        return r.json();
      })
    );
  })
  .catch(err => {
    ge.querySelector('p').textContent =
      'Boot error: ' + err.message + ' — is server.py running?';
    console.error(err);
  });
