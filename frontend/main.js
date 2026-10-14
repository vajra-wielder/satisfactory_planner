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
  SC, RESULT, RECIPES, PROGRESS, keyOf,
  setResult, resetSC, setAllItems, setRecipes, buildItemDisplay, setExtractors,
  nextSolveSeq, solveSeq, itemName,
} from './state.js';
const fmtN = v => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : +v.toFixed(2)).toLocaleString();

import {
  fetchBoot,
  fetchScenarios, fetchScenario, saveScenario, deleteScenario, solveScenario,
} from './api.js';

import {
  toggleSec,
  addKv,
  fillUI, readUI,
  setUnlockedSaver, setUnlockedAlts,
  renderMachines, updMachBadge,
} from './sidebar.js';

// Panels are imported here only so their modules are loaded eagerly;
// all interaction goes through sidebar.js re-exports above.

import { startChain, watchChain, onChain, chainHTML } from './chain.js';
import { uploadSave, changesHTML, wireChanges } from './save-import.js';
import { addNode, addFrom, addLeftovers, addStorage, pickOnMap, spreadShards, minerOf,
         refreshOutputs, applyCut, onResult, setStorage, shortfalls } from './supply-panel.js';

import {
  openWarn, closeWarn,
  renderResultsBar, renderBuildCost, toggleBC, setBuildSelf,
  renderSaved, renderIssues,
} from './ui.js';

import { initTree, renderTree, showTree, treeShown, openSearch as openFind } from './goal-tree.js';
import { openUnlockedModal } from './machines-panel.js';
import { KVS, renderKv, syncKv } from './kv-panel.js';
import { openAnalysis, closeAnalysis, showAnalysis } from './analysis.js';
import { initDock, onDockTab, openDock, toggleDock, dockTab, setBadge } from './dock.js';

import { initBlackboard, openBlackboard, closeBlackboard, goBlackboard } from './blackboard.js';
import { initNav, openPalette, openHelp } from './nav.js';
import { refreshNewAlts } from './new-alts.js';

import {
  resize, initLayout, draw,
  fitAll, zoomBy, openSearch, initGraphEvents,
  toggleHubs, toggleMinor, COLOR_MODES, colorBy, setColorBy, setMoving, moving,
} from './graph.js';


// ── Solve styles ──────────────────────────────────────────────────────────────
// Transient modifiers applied to the solve payload only — never mutate SC.

const SOLVE_STYLES = new Set();  // active style ids

// Restore modifier toggles (e.g. from a cached solve)
function setSolveStyles(styles) {
  SOLVE_STYLES.clear();
  (styles || []).forEach(s => SOLVE_STYLES.add(s));
  document.querySelectorAll('.ssc[data-style]').forEach(btn =>
    btn.classList.toggle('on', SOLVE_STYLES.has(btn.dataset.style)));
}

function initSolveStyles() {
  document.querySelectorAll('.ssc').forEach(btn => {
    if (btn.id === 'ssc-min-new-alts' || btn.id === 'ssc-machines-first') return;  // wired separately below
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

  const mfBtn = document.getElementById('ssc-machines-first');
  if (mfBtn) {
    mfBtn.addEventListener('click', () => {
      SC.machines_first = !SC.machines_first;
      mfBtn.classList.toggle('on', SC.machines_first);
    });
  }

  document.querySelectorAll('#sl-mode button').forEach(btn =>
    btn.addEventListener('click', () => {
      SC.sloop_search = btn.dataset.mode;
      document.querySelectorAll('#sl-mode button').forEach(b =>
        b.classList.toggle('on', b.dataset.mode === SC.sloop_search));
    }));
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

// ── Lazy machines/alts render ─────────────────────────────────────────────────
// The Unlocks window — skipped at boot and only drawn when it's first opened,
// or marked dirty by a scenario load/reset.

let _machinesDirty = true;

function renderMachinesIfNeeded() {
  if (!_machinesDirty) return;
  _machinesDirty = false;
  renderMachines(); updMachBadge();
}


// ── Sidebar open/close ────────────────────────────────────────────────────────

let sidebarOpen = true;

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  document.getElementById('app').classList.toggle('sb-collapsed', !sidebarOpen);
  setTimeout(() => { resize(); draw(); }, 250);
}

function showPlan() { if (!sidebarOpen) toggleSidebar(); }

// Far off, for what's rarely changed or for leaving this factory:
// your factories (a drawer) and the unlocks every factory shares (a window)
function openFar(id) {
  document.querySelectorAll('.far.show').forEach(f => f.classList.remove('show'));
  document.getElementById(id).classList.add('show');
}
function closeFar() { document.querySelectorAll('.far.show').forEach(f => f.classList.remove('show')); }
function openFactories() { openFar('fac-drawer'); loadSaved(); }
function openUnlocks() { openFar('unlocks-modal'); renderMachinesIfNeeded(); }
document.querySelectorAll('.far').forEach(f => {
  f.addEventListener('mousedown', e => { if (e.target === f) closeFar(); });
  f.querySelector('[data-far-close]').addEventListener('click', closeFar);
});
document.getElementById('fac-new').addEventListener('click', () => { if (mayLeave('Start a new one')) { closeFar(); handleReset(); } });
document.getElementById('btn-hd-manage').addEventListener('click', openUnlockedModal);


// ── Issues badge ─────────────────────────────────────────────────────────────

function updateIssuesBadge(result) {
  const wc  = (result?.conflict_hints?.length ?? 0)
            + (result?.warnings?.length ?? 0);
  const ec  = Object.keys(result?.error_sources ?? {}).length
            + Object.keys(result?.error_sinks   ?? {}).length;
  const sc  = Object.keys(result?.surplus_intermediates ?? {}).length;
  const tot = wc + ec + sc;
  setBadge('btn-issues-count', tot > 0 ? String(tot) : '', ec > 0 ? 'bad' : wc > 0 ? 'warn' : '');
  renderIssues();
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
  // The server caches results per scenario; it keys them on the settings
  // before modifiers (so a reopened scenario finds its last plan) plus the
  // modifiers themselves.
  const cacheInfo = { solve_styles: [...SOLVE_STYLES], base_scenario: basePayload };
  const payload = { ...applyStylesFirstPass(basePayload, { hardByproducts: true }), ...cacheInfo };

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
      const softPayload = { ...applyStylesFirstPass(basePayload, { hardByproducts: false }), ...cacheInfo };
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
      onResult(); paintImpact();
      if (result.flows?.length) showTree(false);     // solved: the plan
      updateIssuesBadge(result);
      refreshNewAlts(altsChanged);
      // fell short: the Issues tab says why; otherwise the badges do, and an
      // open Analysis redraws for the new plan
      const shortOf = !result.status?.startsWith('Optimal') || result.conflict_hints?.length > 0
        || Object.keys(result.error_sources ?? {}).length > 0;
      if (shortOf) openWarn();
      else if (dockTab() === 'analysis') showAnalysis();
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

// The saved factory open now (to tell a rename from a new factory)
let LOADED_KEY = null, LOADED_NAME = null;

function handleSave(chain = false) {
  readUI();
  SC.miner = minerOf();          // saved with the miners it's built with
  const key = keyOf(SC.name);
  // Saved under a new name: rename it (its links follow), or keep both
  const body = { ...SC };
  if (LOADED_KEY && LOADED_KEY !== key &&
      confirm(`Rename "${LOADED_NAME}" to "${SC.name}"?\n\nOK renames it — other factories' imports from it, its Blackboard place and its plan follow.\nCancel saves a copy and keeps "${LOADED_NAME}".`))
    body._renamed_from = LOADED_KEY;
  saveScenario(key, body)
    .then(res => {
      LOADED_KEY = key; LOADED_NAME = SC.name; setBuildSelf(key, SC.name);
      baseline();
      if (res?.cut?.length || res?.moved?.length) applyCut(res);   // over what the sources have left; out of their storage
      const b = document.getElementById('bsave');
      b.textContent = 'Saved!';
      setTimeout(() => { b.textContent = '💾 Save'; }, 2200);
      loadSaved();
      GRID_FOR = undefined;
      refreshOutputs().then(paintImpact);
      if (chain === true) document.dispatchEvent(new CustomEvent('resolve-chain', { detail: { keys: [key] } }));   // not a click event
    })
    .catch(err => alert('Save failed: ' + err.message));
}


// ── Reset ─────────────────────────────────────────────────────────────────────

function handleReset() {
  resetSC();
  LOADED_KEY = LOADED_NAME = null; setBuildSelf(null);
  setResult(null);
  _machinesDirty = true;
  fillUI({ skipMachines: true });
  renderResultsBar();
  renderBuildCost();
  setBadge('btn-issues-count', '');
  renderIssues();
  refreshNewAlts(altsChanged);
  TOUCHED = false;
  forget();
  updateSummaries();
  showTree(true);
  initLayout();
}


// ── Load saved scenarios ──────────────────────────────────────────────────────

// Load a saved scenario (and its cached plan, when it matches) into the solver
function openScenario(key) {
  return fetchScenario(key).then(data => {
    const { _last_solve: last, pinboard: _oldPinboard, ...scenario } = data;
    LOADED_KEY = key; LOADED_NAME = scenario.name; setBuildSelf(key, scenario.name);
    scenario.enabled_machines = [...(PROGRESS.machines || [])];   // shared
    Object.assign(SC, scenario);
    if (!scenario.unlimited_resources) SC.unlimited_resources = [];   // older saves
    SC.resource_nodes = scenario.resource_nodes ?? null;              // null: rates from before nodes
    SC.from_factories = scenario.from_factories || [];
    SC.to_storage = scenario.to_storage || [];
    if (scenario.machines_first == null) SC.machines_first = false;
    if (!scenario.miner) SC.miner = null;              // not saved with one yet: the tier unlocked
    SC.recipe_picks = { ...(scenario.recipe_picks || {}) };   // recipes picked on the goal tree
    if (!scenario.sloop_search) SC.sloop_search = 'dive';
    // Cached plan from the last solve of exactly these settings
    setResult(last ? last.result : null);
    onResult();
    refreshNewAlts(altsChanged);
    setSolveStyles(last ? last.styles : []);
    _machinesDirty = true;
    fillUI({ skipMachines: true });
    TOUCHED = false;
    forget();
    updateSummaries();
    showTree(!RESULT?.flows?.length);       // no plan yet: what its resources can become
    updateIssuesBadge(RESULT);
    renderResultsBar();
    renderBuildCost();
    initLayout();
  });
}

function loadSaved() {
  fetchScenarios()
    .then(saved => {
      renderSaved(saved, key => { if (mayLeave('Open another')) { closeFar(); openScenario(key); } }, key => {
        const f = saved.find(x => x.key === key);
        if (confirm(`Delete "${f?.name || key}"? Its plan goes too; imports other factories take from it stop. A backup (Back up now) can bring it back.`))
          deleteScenario(key).then(loadSaved);
      }, (key, v) =>
        fetch(`/api/history/${key}/${v}/restore`, { method: 'POST' }).then(() => {
          loadSaved(); refreshOutputs();
          if (key === LOADED_KEY) openScenario(key);
        }));
      document.getElementById('sv-chain')?.addEventListener('click', () => startChain());
      watchChain();
    })
    .catch(() => {
      const el = document.getElementById('savedlist');
      if (el) el.innerHTML = '<p style="font-size:12px;color:var(--t3)">Server not reachable.</p>';
    });
}


// Re-solving in order: progress in Your factories and the sidebar; when it
// ends, the lists refresh and the open factory shows its new plan
let _chainWasRunning = false;
onChain(st => {
  const html = chainHTML(st);
  ['sv-chain-box', 'chain-side'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = html; });
  if (_chainWasRunning && !st.running) {
    loadSaved(); refreshOutputs();
    if (LOADED_KEY && st.steps.some(x => x.key === LOADED_KEY)) openScenario(LOADED_KEY);
  }
  _chainWasRunning = st.running;
});
document.addEventListener('resolve-chain', e => startChain(e.detail?.keys || null));

// What each folded section holds, in its header: fold the long ones, still see what's there
function updateSummaries() {
  readUI();                         // what the boxes hold now
  const n = (o) => Object.keys(o || {}).length;
  const nodes = (SC.resource_nodes || []).filter(r => r.resource);
  const ex = nodes.reduce((a, r) => a + (r.nodes?.length || (r.extractor === 'fixed' ? 0 : parseInt(r.count ?? 1, 10) || 0)), 0);
  const imp = (SC.from_factories || []).length;
  const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
  set('tb-fac-name', SC.name || 'New Factory');            // the factory on screen, in the top bar
  if (!TOUCHED) SNAP = snap();
  remember();
  paintDirty();
  paintImpact();
  renderTree();
  set('sum-res', [`${new Set(nodes.map(r => r.resource)).size} resources`, ex ? `${ex} extractors` : '', imp ? `${imp} imports` : ''].filter(Boolean).join(' · '));
  set('sum-goals', [n(SC.objective) && `${n(SC.objective)} max`, n(SC.must_produce) && `${n(SC.must_produce)} exact`,
    n(SC.min_produce) && `${n(SC.min_produce)} at least`, n(SC.max_produce) && `${n(SC.max_produce)} at most`,
    (SC.to_storage || []).length && `${SC.to_storage.length} stored`].filter(Boolean).join(' · ') || 'none yet');
  set('sum-oc', [SC.power_shards_available ? `${SC.power_shards_available} shards` : '', SC.somersloops_available ? `${SC.somersloops_available} sloops` : '',
    SC.max_power_mw ? `cap ${SC.max_power_mw} MW` : '', SC.machines_first ? 'min machines' : '', SC.minimize_new_alts ? 'min new alts' : ''].filter(Boolean).join(' · '));
}
let _sumT = null;
const soonSummaries = () => { clearTimeout(_sumT); _sumT = setTimeout(updateSummaries, 150); };
// Anything you do to this factory — the left panel, the map picker, the
// alternates on the right — but not the shared windows or the Blackboard
['input', 'change', 'click'].forEach(t => document.addEventListener(t, e => {
  if (!e.isTrusted || e.target.closest?.('#fac-drawer, #unlocks-modal, #bb-modal, header, #nav-pal, #nav-help')) return;
  if (t !== 'click' || e.target.closest('#map-modal, #dock button, #sidebar button, #gt-pop button')) TOUCHED = true;
  soonSummaries();
}, true));

// A better miner unlocked: an open saved factory keeps the miners it was built with
document.addEventListener('miner-changing', e => { if (LOADED_KEY && !SC.miner) SC.miner = e.detail; });

// the goal tree sets goals, storage and supply: the left panel and summaries follow
['goals-changed', 'supply-changed'].forEach(ev => document.addEventListener(ev, () => { TOUCHED = true; soonSummaries(); }));

// A factory's storage changed from elsewhere (the Blackboard): already saved there;
// the open one follows (still unsaved only if it was before), and what's free follows everywhere
document.addEventListener('factory-edited', e => {
  const { key, item, storage } = e.detail;
  if (key === LOADED_KEY) {
    readUI();
    const was = isDirty();
    setStorage(item, storage);
    if (!was) baseline();
  }
  refreshOutputs();
});

// ── Unsaved changes ──────────────────────────────────────
// What's on screen against what was opened or last saved: a dot on the name
// in the top bar and on Save, and a question before opening another factory.
// Until you change something, whatever the panels settle on is the baseline.
let SNAP = null, TOUCHED = false;
const snap = () => JSON.stringify(SC, (k, v) => (k === 'enabled_machines' || k.startsWith('_')) ? undefined
  : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v);
const isDirty = () => TOUCHED && SNAP !== null && snap() !== SNAP;
function paintDirty() {
  const d = isDirty();
  document.getElementById('btn-factories').classList.toggle('dirty', d);
  document.getElementById('bsave').classList.toggle('dirty', d);
  document.getElementById('bsave').title = d ? 'Unsaved changes  (Ctrl+S)' : 'Save  (Ctrl+S)';
}
function baseline() { TOUCHED = false; SNAP = snap(); paintDirty(); }

// ── Before saving: who it leaves short ───────────────────
// The plan on screen against what other factories take from this one: if
// saving it leaves some short, say so by Save — and save and re-solve them in one
// The grid as saved (fetched again after each save); this plan's own power in place of its saved one
let GRID = null, GRID_FOR = undefined;
function gridAfter() {
  if (GRID_FOR !== LOADED_KEY) {
    GRID_FOR = LOADED_KEY; GRID = null;
    fetch('/api/grid-status').then(r => r.json()).then(g => { GRID = g; paintImpact(); }).catch(() => {});
  }
  if (!GRID || !RESULT?.flows?.length || !(GRID.made > 0)) return null;     // no grid planned yet: nothing to say
  const used = RESULT.flows.reduce((a, f) => a + Math.max(0, f.power_mw || 0), 0) + (RESULT.extractor_power_mw || 0);
  const made = RESULT.flows.reduce((a, f) => a + (f.outputs?.Power || 0), 0) + (RESULT.geothermal_mw || 0);
  const delta = made - used - (GRID.net?.[LOADED_KEY] ?? 0);
  return { spare: GRID.spare + delta, low: GRID.spare_low + delta, delta };
}
function paintImpact() {
  const el = document.getElementById('save-impact');
  if (!el) return;
  const sh = LOADED_KEY ? shortfalls() : [];
  const g = gridAfter();
  const grid = g && g.delta < -0.5 && g.low < 0 ? (g.spare < 0
    ? `The grid goes ${fmtN(Math.round(-g.spare))} MW short with this plan.`
    : `The grid goes ${fmtN(Math.round(-g.low))} MW short when the geysers are low.`) : '';
  el.style.display = sh.length || grid ? '' : 'none';
  if (!sh.length && !grid) return;
  const who = [...new Set(sh.flatMap(s => s.takers))];
  el.innerHTML = (sh.length ? `<div class="n-warn">Saving leaves ${who.join(', ')} short: ${sh.map(s => `${fmtN(s.short)} ${itemName(s.item)}`).join(', ')}/min</div>
    <button class="bsm act" id="save-resolve" title="Save, then re-solve this and every factory that takes from it, in order">💾 Save and re-solve ${who.length === 1 ? who[0] : `the ${who.length}`}</button>` : '')
    + (grid ? `<div class="n-warn" title="All your saved factories' power, with this plan in place of its saved one (the Blackboard's Power tab)">⚡ ${grid}</div>` : '');
  document.getElementById('save-resolve')?.addEventListener('click', () => handleSave(true));
}

// ── Undo ─────────────────────────────────────────────────
// Every settled change to this factory (a pause in typing, a click, a pick on
// the map or the tree) is a step: Ctrl+Z goes back one, Ctrl+Shift+Z (or
// Ctrl+Y) forward. Opening another factory starts afresh. Solving isn't undone.
let UNDO = [], REDO = [], UNDO_KEY = null, RESTORING = false;
function remember() {
  const k = snap();
  if (RESTORING && UNDO.length) { UNDO[UNDO.length - 1].k = k; return; }   // the panels settling what was put back
  if (UNDO.length && UNDO[UNDO.length - 1].k === k) return;
  if (UNDO_KEY !== LOADED_KEY) { UNDO = []; UNDO_KEY = LOADED_KEY; }
  UNDO.push({ k, sc: JSON.parse(JSON.stringify(SC)) });
  if (UNDO.length > 200) UNDO.shift();
  REDO = [];
}
function forget() { UNDO = []; REDO = []; UNDO_KEY = LOADED_KEY; }
function restore(st) {
  const machines = SC.enabled_machines;
  Object.keys(SC).forEach(k => { if (!(k in st.sc)) delete SC[k]; });
  Object.assign(SC, JSON.parse(JSON.stringify(st.sc)), { enabled_machines: machines });
  RESTORING = true;
  try {
    fillUI({ skipMachines: true });
    TOUCHED = true;
    updateSummaries();
  } finally { RESTORING = false; }
}
function undo(back = true) {
  readUI();
  remember();                      // what's on screen, if it hadn't settled yet
  if (back) {
    if (UNDO.length < 2) return flash('Nothing to undo');
    REDO.push(UNDO.pop());
    restore(UNDO[UNDO.length - 1]);
  } else {
    if (!REDO.length) return flash('Nothing to redo');
    const st = REDO.pop();
    UNDO.push(st);
    restore(st);
  }
}
function flash(t) {
  const el = document.getElementById('undo-note') || Object.assign(document.createElement('div'), { id: 'undo-note' });
  el.textContent = t; document.body.appendChild(el);
  el.classList.add('on'); clearTimeout(flash.t); flash.t = setTimeout(() => el.classList.remove('on'), 1200);
}
/** Before something replaces what's on screen: fine if nothing's unsaved, else ask. */
function mayLeave(what) {
  readUI();
  return !isDirty() || confirm(`"${SC.name || 'This factory'}" has changes you haven't saved.\n\n${what} anyway? They'll be lost.`);
}
window.addEventListener('beforeunload', e => { readUI(); if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

// The alternates this factory uses changed (ticked under New alternates): the
// Unlocks and the Alternates tab redraw when next shown
function altsChanged() {
  _machinesDirty = true;
  if (dockTab() === 'alts') renderMachinesIfNeeded();
}

// A fix from the issues list: change the factory, then solve again
document.addEventListener('apply-fix', e => {
  const f = e.detail;
  if (f.kind === 'goal') {
    const name = ['must', 'min'].find(n => KVS[n].rows.some(r => r.key === f.item));
    if (!name) return;
    KVS[name].rows.forEach(r => { if (r.key === f.item) r.val = String(f.rate); });
    renderKv(name); syncKv(name);
  } else if (f.kind === 'alts') {
    SC.alternate_recipes_enabled = [...new Set([...(SC.alternate_recipes_enabled || []), ...f.keys])];
    _machinesDirty = true;
    renderMachinesIfNeeded();
  }
  handleSolve();
});

// Reading a save in Unlocks: what it mines, and its unlocks against the planner's
function showSave(d) {
  const info = document.getElementById('save-info'), box = document.getElementById('save-unl');
  if (!info || !d?.file) return;
  info.textContent = `${d.file}: ${d.nodes.length} nodes mined`;
  box.innerHTML = changesHTML(d);
  wireChanges(box, () => fetch('/api/save-nodes').then(r => r.json()).then(showSave));
}
document.getElementById('save-in').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  document.getElementById('save-info').textContent = 'Reading the save…';
  uploadSave(f).then(showSave).catch(err => { document.getElementById('save-info').textContent = `Couldn't read it: ${err.message}`; });
});
fetch('/api/save-nodes').then(r => r.json()).then(showSave).catch(() => {});
document.addEventListener('resolve-chain-watch', () => watchChain());

// ── DOM wiring ────────────────────────────────────────────────────────────────

// <script type="module"> is deferred by default, so the DOM is already ready
// when this runs — no DOMContentLoaded wrapper needed.

// Topbar
document.getElementById('sb-toggle')    .addEventListener('click', toggleSidebar);
document.getElementById('btn-blackboard').addEventListener('click', openBlackboard);
document.getElementById('btn-factories').addEventListener('click', openFactories);
document.getElementById('btn-unlocks')  .addEventListener('click', openUnlocks);
document.getElementById('btn-goto')     .addEventListener('click', openPalette);
document.getElementById('btn-keys')     .addEventListener('click', openHelp);

// Rail

// Section toggles
['res', 'goals', 'oc', 'nt'].forEach(id =>
  document.getElementById('tog-' + id).addEventListener('click', () => toggleSec(id)));

// KV add-row buttons
// Enter in a single box: keep it and go on to the next (the last one just keeps it)
[['sc-name', 'sc-desc'], ['sc-desc'], ['sc-sh', 'sc-sl'], ['sc-sl', 'sc-mp'], ['sc-mp']].forEach(([id, next]) =>
  document.getElementById(id)?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const n = next && document.getElementById(next);
    if (n) { n.focus(); n.select(); } else e.target.blur();
  }));
document.getElementById('sh-spread')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('btn-spread').click(); }
});
document.getElementById('add-res') .addEventListener('click', addNode);
document.getElementById('add-from').addEventListener('click', addFrom);
document.getElementById('add-leftovers').addEventListener('click', addLeftovers);
document.getElementById('add-sto').addEventListener('click', addStorage);
document.getElementById('btn-map-pick').addEventListener('click', () => pickOnMap());
document.getElementById('btn-spread').addEventListener('click', () => {
  const n = parseInt(document.getElementById('sh-spread').value, 10) || 0;
  SC.extractor_shards = n;
  spreadShards(n);
});
document.getElementById('add-obj') .addEventListener('click', () => addKv('obj'));
document.getElementById('add-must').addEventListener('click', () => addKv('must'));
document.getElementById('add-min') .addEventListener('click', () => addKv('min'));
document.getElementById('add-max') .addEventListener('click', () => addKv('max'));

// Alternates

// Solve / Save / Reset
document.getElementById('bsolve').addEventListener('click', handleSolve);
document.getElementById('bsave') .addEventListener('click', handleSave);
document.getElementById('breset').addEventListener('click', () => { if (mayLeave('Start a new one')) handleReset(); });


// Graph controls
document.getElementById('btn-zoom-in') .addEventListener('click', () => zoomBy(1.2));
document.getElementById('btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
document.getElementById('btn-fit')     .addEventListener('click', fitAll);
document.getElementById('btn-search')  .addEventListener('click', openSearch);
document.getElementById('btn-hubs')    .addEventListener('click', e => e.currentTarget.classList.toggle('on', toggleHubs()));
document.getElementById('btn-minor')   .addEventListener('click', e => e.currentTarget.classList.toggle('on', toggleMinor()));
// What the machines are coloured by, and its key; belts moving or still (both remembered)
function paintColorBy() {
  const m = colorBy(), name = COLOR_MODES.find(([k]) => k === m)?.[1];
  const scale = { power: ['least', 'most power'], space: ['least', 'most room'], clock: ['under', '100%', 'over'] }[m];
  document.getElementById('btn-colorby').classList.toggle('on', m !== 'machine');
  document.getElementById('g-legend').innerHTML = m === 'machine' ? '' : `<span>${name}</span>${m === 'alt'
    ? '<i style="background:#a855f7"></i>alternate <i style="background:#475569"></i>standard'
    : `<b class="g-heat ${m}"></b><span class="n-hint">${scale.join(' → ')}</span>`}`;
}
function cycleColorBy() {
  const i = COLOR_MODES.findIndex(([k]) => k === colorBy());
  setColorBy(COLOR_MODES[(i + 1) % COLOR_MODES.length][0]);
  try { localStorage.setItem('colorBy', colorBy()); } catch { /* private window */ }
  paintColorBy();
}
try { const c = localStorage.getItem('colorBy'); if (COLOR_MODES.some(([k]) => k === c)) setColorBy(c); } catch { /* private window */ }
try { if (localStorage.getItem('moving') === '0') setMoving(false); } catch { /* private window */ }
document.getElementById('btn-moving').classList.toggle('on', moving());
paintColorBy();
document.getElementById('btn-colorby').addEventListener('click', cycleColorBy);
document.getElementById('btn-moving').addEventListener('click', e => {
  setMoving(!moving()); e.currentTarget.classList.toggle('on', moving());
  try { localStorage.setItem('moving', moving() ? '1' : '0'); } catch { /* private window */ }
});

// The right panel: each tab draws what it shows when it's shown
initDock();
onDockTab(tab => {
  if (tab === 'alts') { renderMachinesIfNeeded(); refreshNewAlts(altsChanged); }
  if (tab === 'analysis') showAnalysis();
  if (tab === 'build') renderBuildCost(true);
  if (tab === 'issues') renderIssues();
});

// Keyboard shortcuts
window.addEventListener('keydown', e => {
  const tag     = document.activeElement?.tagName;
  const inInput = tag === 'INPUT' || tag === 'TEXTAREA';
  const mod     = e.ctrlKey || e.metaKey;

  // [ the left panel (what goes in), ] the right one (review and improve)
  if (e.key === '[' && !mod && !inInput) { toggleSidebar(); return; }
  if (e.key === ']' && !mod && !inInput) { toggleDock(dockTab() || 'analysis'); return; }
  // 1…4 the right panel's tabs, on the planner with nothing over it
  // (Ctrl+1…4 belong to the browser's tabs)
  const tab = !mod && !e.altKey && !inInput && ['analysis', 'alts', 'build', 'issues'][+e.key - 1];
  const clear = !document.querySelector('.show:is(.far, [id$="-modal"], #nav-help, #nav-pal)');
  if (tab && clear) { toggleDock(tab); return; }
  if ((e.key === 't' || e.key === 'T') && !mod && !e.altKey && !inInput && clear) { showTree(!treeShown()); return; }
  if ((e.key === 'c' || e.key === 'C') && !mod && !e.altKey && !inInput && clear && !treeShown()) { cycleColorBy(); return; }
  if (!mod) return;
  // Undo / redo this factory's edits (the notes box keeps its own)
  const z = e.key.toLowerCase();
  if ((z === 'z' || z === 'y') && tag !== 'TEXTAREA' && !e.altKey) {
    e.preventDefault();
    document.activeElement?.blur?.();
    undo(z === 'z' && !e.shiftKey);
    return;
  }

  switch (e.key.toLowerCase()) {
    case 'r': e.preventDefault(); handleSolve(); break;
    case 's': e.preventDefault(); handleSave();  break;
    case 'p': case 'b': e.preventDefault(); openBlackboard(); break;
    case 'i': e.preventDefault(); openAnalysis(); break;
    case 'm': e.preventDefault(); pickOnMap(); break;
    case 'o': e.preventDefault(); openFactories(); break;
    case 'u': e.preventDefault(); openUnlocks(); break;
    case 'q': e.preventDefault(); openFind(); break;
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
    setExtractors(boot);
    setAllItems(items);
    setRecipes(recipes);
    buildItemDisplay(display);
    setUnlockedAlts(unlocked_alts || []);
    ge.querySelector('p').textContent = 'Configure your factory and hit Solve';

    initTree();
    initNav({
      currentFactory: () => LOADED_KEY,
      openFactory: key => mayLeave('Open another') && openScenario(key),
      closeAnalysis, closeWarn, closeFar,
      actions: [
        { label: 'Solve', keys: 'Ctrl+R', run: handleSolve },
        { label: 'Save', keys: 'Ctrl+S', run: handleSave },
        { label: 'New factory (reset the planner)', run: () => document.getElementById('breset').click() },
        { label: 'Pick nodes on the map', keys: 'Ctrl+M', run: () => pickOnMap() },
        { label: 'Analysis', keys: '1', run: () => openDock('analysis') },
        { label: 'Alternates for this factory', keys: '2', run: () => openDock('alts') },
        { label: 'Build cost', keys: '3', run: () => openDock('build') },
        { label: 'Issues', keys: '4', run: () => openDock('issues') },
        { label: 'Find a part: its recipes, uses and goals', keys: 'Ctrl+Q', run: () => openFind() },
        { label: 'Goal tree: what your resources can become', keys: 'T', run: () => showTree(true) },
        { label: 'Your factories', keys: 'Ctrl+O', run: openFactories },
        { label: 'Unlocks for every factory (machines, miner, hard drives, a save)', keys: 'Ctrl+U', run: openUnlocks },
        { label: 'Re-solve out of date', run: () => startChain() },
        { label: 'Back up now', run: () => { openFactories(); setTimeout(() => document.getElementById('bk-make')?.click(), 400); } },
        { label: 'Plan the network', run: () => { goBlackboard('factories'); setTimeout(() => document.getElementById('bb-plan')?.click(), 600); } },
        { label: 'Hide / show the left panel (what goes in)', keys: '[', run: toggleSidebar },
        { label: 'Hide / show the right panel (review and improve)', keys: ']', run: () => toggleDock(dockTab() || 'analysis') },
        { label: 'Every shortcut', keys: '?', run: openHelp },
      ],
    });
    initSolveStyles();
    initGraphEvents();
    // Clicking a factory on the Blackboard opens it here
    initBlackboard({ onOpenFactory: key => { if (mayLeave('Open another')) { closeBlackboard(); openScenario(key); } } });
    fillUI({ skipMachines: true });   // skip machines/alts — rendered lazily on first tab open
    updateSummaries();
    renderBuildCost(); renderIssues();
    showTree(!RESULT?.flows?.length);
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
