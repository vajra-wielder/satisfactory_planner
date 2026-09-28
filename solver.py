"""
Satisfactory Factory Planner — exact solver

PLAN (see _plan):
  One mixed-integer model of the whole factory — integer machines per recipe,
  a somersloop level per recipe, power shards per recipe, hard budgets for
  sloops, shards and max_machines — solved in three lexicographic stages:
    1. Goal   maximise the weighted goals
    2. Lean   minimise machines + raw resources, each on its own scale
    3. Clean  fewest recipes and duplicate producers
  Each stage is solved to proven optimality (MIP gap 1e-9) with earlier
  stages locked, so the result is the best plan, not a greedy approximation.

SLOOP ACCOUNTING:
  sloops per machine l ∈ 0..slots, output × (1 + l/slots), power × (1 + l/slots)²,
  sloops used = l × machines.

POWER FORMULA:
  P = base_mw × clock^1.6 × (1 + sloops_per_machine / max_slots)^2, per machine.
  Power is reported, not optimised; max_power_mw is informational.

PRUNING:
  Recipe tree is computed once (forward grounding + backward demand).

SHADOW PRICES:
  compute_duals() uses the continuous LP (_build_lp / WarmLP) for resource
  shadow prices and saturation points.
"""

import math, yaml, json
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, replace as _dc_replace
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple
from ortools.linear_solver import pywraplp

ROOT          = Path(__file__).parent
RECIPES_PATH  = ROOT / "data" / "recipes_complete.yaml"
SCENARIOS_DIR = ROOT / "scenarios"

POWER_EXP   = 1.6
_NEW_ALT_PEN = 1e-3   # Min New Alts: goal-weight cost per machine on a not-yet-unlocked alt
SHARD_BOOST = 0.5
MAX_CLOCK   = 2.5

SLOOP_SLOTS_BY_MACHINE = {
    "Smelter":1, "Constructor":1,
    "Foundry":2, "Assembler":2, "Refinery":2, "Converter":2, "Packager":2,
    "Manufacturer":4, "Blender":4, "Particle_Accelerator":4, "Quantum_Encoder":4,
    "Miner":0, "Water_Extractor":0, "Oil_Extractor":0,
}


# ── Data classes ──────────────────────────────────────────────────────────────
@dataclass
class Recipe:
    key: str; display: str; machine: str; alternate: bool
    inputs: Dict[str,float]; outputs: Dict[str,float]
    base_power_mw: float = 10.0; sloop_slots: int = 0

@dataclass
class Scenario:
    name: str; description: str = ""
    alternate_recipes_enabled: List[str] = field(default_factory=list)
    enabled_machines: List[str] = field(default_factory=list)
    available_resources: Dict[str,float] = field(default_factory=dict)
    must_produce:  Dict[str,float] = field(default_factory=dict)
    min_produce:   Dict[str,float] = field(default_factory=dict)
    max_produce:   Dict[str,float] = field(default_factory=dict)
    objective:     Dict[str,float] = field(default_factory=dict)
    power_shards_available: int   = 0
    somersloops_available:  int   = 0
    max_power_mw:  Optional[float] = None
    max_machines:  Optional[int]   = None
    notes: str = ""
    # Permanent unlock tracking — populated by the server from unlocked_alts.yaml.
    # The solver treats these alts as always-available (no per-scenario enable needed)
    # and does NOT penalise them when minimize_new_alts is True.
    unlocked_alt_recipes: List[str] = field(default_factory=list)
    # When True, add a soft penalty for using alternate recipes that are NOT in
    # unlocked_alt_recipes. The planner will prefer base recipes and already-owned
    # alts, only reaching for new alts when they meaningfully improve the solution.
    minimize_new_alts: bool = False

@dataclass
class LayoutOption:
    machines: int; clock_pct: float; shards_needed: int
    power_mw: float; label: str

@dataclass
class FlowResult:
    recipe_key: str; display: str; machine: str
    machines_float: float
    machines_final: int
    clock_pct: float
    shards_used: int
    sloops_per_machine: float # effective sloops per machine (1 + spm/slots = output mult)
    sloops_used: int          # total sloops = sloops_per_machine * machines_final
    sloop_slots: int
    output_multiplier: float
    power_mw: float
    inputs:  Dict[str,float]
    outputs: Dict[str,float]
    layout_options: List[LayoutOption] = field(default_factory=list)
    has_shard: bool = False
    has_sloop: bool = False
    hi_machines: int = 0  # machines carrying shards
    layout: List[dict] = field(default_factory=list)  # [{count, clock_pct, shards, sloops}] groups

@dataclass
class SolveResult:
    status: str; objective_value: float
    flows: List[FlowResult]
    net_items: Dict[str,float]
    objective_items: Dict[str,float]
    source_nodes:  Dict[str,float]
    sink_nodes:    Dict[str,float]
    error_sources: Dict[str,float]
    error_sinks:   Dict[str,float]
    surplus_intermediates: Dict[str,float]
    total_power_mw: float; total_machines: float
    shards_used: int; sloops_used: int
    warnings: List[str]; conflict_hints: List[str]
    pruned_recipe_count: int
    cap_overshoot: Dict[str,float]
    shadow_prices: Dict[str,float] = field(default_factory=dict)
    saturation_points: Dict[str,object] = field(default_factory=dict)
    usable: Optional[Dict[str,"Recipe"]] = field(default=None, repr=False)


# ── Loaders ───────────────────────────────────────────────────────────────────
def _si(v, d=0):
    try: return int(v) if v is not None else d
    except: return d

def _sf(v, d=0.0):
    try: return float(v) if v is not None else d
    except: return d

def _load_raw_yaml(path=RECIPES_PATH) -> dict:
    """Parse the recipes YAML once; callers slice what they need."""
    with open(path) as f:
        return yaml.safe_load(f)

def _build_recipes(raw: dict) -> Dict[str, "Recipe"]:
    """Construct the Recipe dict from a parsed YAML blob. Used by both loaders."""
    meta = raw.get("machine_meta", {})
    out: Dict[str, Recipe] = {}
    for key, d in raw["recipes"].items():
        machine = d["machine"]
        m = meta.get(machine, {})
        out[key] = Recipe(
            key=key, display=d.get("display", key), machine=machine,
            alternate=d.get("alternate", False),
            inputs={k: float(v) for k, v in d.get("inputs", {}).items()},
            outputs={k: float(v) for k, v in d.get("outputs", {}).items()},
            base_power_mw=float(m.get("base_power_mw", 10.0)),
            sloop_slots=int(SLOOP_SLOTS_BY_MACHINE.get(machine, 0)),
        )
    return out

def load_recipes(path=RECIPES_PATH) -> Dict[str,Recipe]:
    return _build_recipes(_load_raw_yaml(path))

def load_machine_meta(path=RECIPES_PATH) -> Dict:
    return _load_raw_yaml(path).get("machine_meta", {})

def load_recipes_and_meta(path=RECIPES_PATH) -> Tuple[Dict[str,Recipe], Dict]:
    """Load both in one YAML parse — use this at startup instead of calling each separately."""
    raw = _load_raw_yaml(path)
    return _build_recipes(raw), raw.get("machine_meta", {})

def load_scenario(path) -> Scenario:
    with open(path) as f: raw = yaml.safe_load(f)
    return Scenario(
        name=raw.get("name", Path(path).stem),
        description=raw.get("description", "") or "",
        alternate_recipes_enabled=raw.get("alternate_recipes_enabled") or [],
        enabled_machines=raw.get("enabled_machines") or [],
        available_resources={k: float(v) for k,v in (raw.get("available_resources") or {}).items()},
        must_produce={k: float(v) for k,v in (raw.get("must_produce") or {}).items()},
        min_produce={k: float(v) for k,v in (raw.get("min_produce") or {}).items()},
        max_produce={k: float(v) for k,v in (raw.get("max_produce") or {}).items()},
        objective={k: float(v) for k,v in (raw.get("objective") or {}).items()},
        power_shards_available=_si(raw.get("power_shards_available"), 0),
        somersloops_available=_si(raw.get("somersloops_available"), 0),
        max_power_mw=_sf(raw.get("max_power_mw")) if raw.get("max_power_mw") else None,
        max_machines=_si(raw.get("max_machines")) if raw.get("max_machines") else None,
        notes=raw.get("notes", "") or "",
        minimize_new_alts=bool(raw.get("minimize_new_alts", False)),
    )

def list_scenarios():
    SCENARIOS_DIR.mkdir(exist_ok=True)
    return [p.stem for p in SCENARIOS_DIR.glob("*.yaml")]

def get_all_items(recipes: Dict[str,Recipe]) -> List[str]:
    items: Set[str] = set()
    for r in recipes.values():
        items.update(r.inputs.keys()); items.update(r.outputs.keys())
    return sorted(items)


# ── Power helpers ─────────────────────────────────────────────────────────────
# Defined early so they are available to both WarmLP and the free functions below.

def _sloop_power_mult(r: Recipe, spm_val: int) -> float:
    """(1 + sloops_per_machine / max_slots)^2  — power scaling factor."""
    return (1.0 + spm_val / r.sloop_slots) ** 2 if r.sloop_slots > 0 else 1.0

def _output_mult(r: Recipe, spm_val: int) -> float:
    """1 + sloops_per_machine / max_slots  — throughput scaling factor."""
    return 1.0 + (spm_val / r.sloop_slots) if r.sloop_slots > 0 else 1.0


# ── Pruning — forward grounding + backward demand ─────────────────────────────
def prune_recipes(
    scenario: Scenario,
    all_recipes: Dict[str,Recipe],
) -> Tuple[Dict[str,Recipe], Dict[str,List[str]]]:
    """
    Phase 1: Forward topological grounding (eliminates cycles).
             Iterates only the un-fired candidates each pass — O(E) total.
    Phase 2: Backward demand from objectives through fireable recipes.
    Phase 3: Unsatisfiable detection with human-readable reasons.
    Pruned set is reused for all LP solves in the iterative loop.
    """
    available_raw = set(scenario.available_resources.keys())
    target_items  = (set(scenario.objective.keys()) | set(scenario.must_produce.keys())
                   | set(scenario.min_produce.keys()) | set(scenario.max_produce.keys()))

    enabled_machines_set = set(scenario.enabled_machines)
    alt_enabled_set      = set(scenario.alternate_recipes_enabled)
    unlocked_set         = set(scenario.unlocked_alt_recipes)

    def is_allowed(key: str, r: Recipe) -> bool:
        if enabled_machines_set and r.machine not in enabled_machines_set:
            return False
        if r.alternate and key not in alt_enabled_set and key not in unlocked_set:
            return False
        return True

    allowed = {k: r for k, r in all_recipes.items() if is_allowed(k, r)}

    # Phase 1: forward grounding — process only not-yet-fired candidates.
    # Build a reverse index: item → list of candidate recipe keys that need it.
    # When a new item is added to `grounded`, only those recipes are re-checked.
    # This is essentially a topological worklist algorithm: O(recipes + items).
    grounded: Set[str] = set(available_raw)
    fireable: Set[str] = set()

    # blocked[k] = set of inputs still missing for recipe k
    blocked: Dict[str, Set[str]] = {
        k: {inp for inp in r.inputs if inp not in grounded}
        for k, r in allowed.items()
    }
    # waiting_on[item] = list of recipe keys blocked by that item
    waiting_on: Dict[str, List[str]] = {}
    for k, missing in blocked.items():
        for inp in missing:
            waiting_on.setdefault(inp, []).append(k)

    # Seed: recipes with no missing inputs are immediately fireable
    worklist = [k for k, m in blocked.items() if not m]
    for k in worklist:
        fireable.add(k)

    while worklist:
        k = worklist.pop()
        for item in allowed[k].outputs:
            if item in grounded:
                continue
            grounded.add(item)
            for k2 in waiting_on.get(item, []):
                if k2 in fireable:
                    continue
                blocked[k2].discard(item)
                if not blocked[k2]:
                    fireable.add(k2)
                    worklist.append(k2)

    # Phase 2: backward demand through fireable recipes only
    allowed_producers: Dict[str, List[str]] = {}
    for key in fireable:
        for item in allowed[key].outputs:
            allowed_producers.setdefault(item, []).append(key)

    needed: Set[str] = set()
    visited: Set[str] = set(available_raw)
    queue = list(target_items)
    while queue:
        item = queue.pop()
        if item in visited:
            continue
        visited.add(item)
        for rkey in allowed_producers.get(item, []):
            needed.add(rkey)
            for inp in allowed[rkey].inputs:
                if inp not in visited:
                    queue.append(inp)

    usable = {k: allowed[k] for k in needed}

    # Phase 3: unsatisfiable detection.
    # Build all_prod only when at least one target item is not grounded — the
    # common case (every target reachable) pays zero cost for this phase.
    unsatisfiable: Dict[str, List[str]] = {}
    if target_items - grounded:
        all_prod: Dict[str, List[str]] = {}
        for key, r in all_recipes.items():
            for item in r.outputs:
                all_prod.setdefault(item, []).append(key)

        for item in target_items:
            if item in grounded:
                continue
            reasons: List[str] = []
            for rkey in all_prod.get(item, []):
                r = all_recipes[rkey]
                if enabled_machines_set and r.machine not in enabled_machines_set:
                    reasons.append(f"requires {r.machine} (not enabled)")
                elif r.alternate and rkey not in alt_enabled_set:
                    reasons.append(f"requires alternate '{r.display}' (not enabled)")
                else:
                    missing = [inp for inp in r.inputs if inp not in grounded]
                    if missing:
                        reasons.append(f"inputs unavailable: {', '.join(missing[:3])}")
            unsatisfiable[item] = list(dict.fromkeys(reasons)) or ["no recipe exists for this item"]

    return usable, unsatisfiable


# ── LP with sloop multipliers baked in ───────────────────────────────────────
def _build_lp(
    scenario: Scenario,
    usable: Dict[str,Recipe],
    spm: Dict[str,int],
) -> Tuple[object, list, list, dict, dict]:
    """
    Build the GLOP LP. Returns (solver, q_vars, rkeys, net_expr, res_constraints).
    Separated from solving so callers can extract duals after solving.

    Avoids duplicate cons/prod sums: resource items share their net expression
    with the res_constraint (computed once, used for both flow-balance and cap).
    Non-zero filtering mirrors WarmLP to keep both implementations symmetric.
    """
    rkeys = list(usable.keys())
    n     = len(rkeys)

    # Effective output rates with sloop multiplier baked in
    eff_out: Dict[str, Dict[str, float]] = {}
    for k in rkeys:
        r = usable[k]; s = spm.get(k, 0)
        mult = _output_mult(r, s)
        eff_out[k] = {item: rate * mult for item, rate in r.outputs.items()}

    # Collect all items that appear in the LP
    item_set: Set[str] = set(scenario.available_resources.keys())
    for k in rkeys:
        item_set.update(usable[k].inputs.keys())
        item_set.update(eff_out[k].keys())

    slvr = pywraplp.Solver.CreateSolver("GLOP")
    slvr.SuppressOutput()
    INF = slvr.infinity()
    q   = [slvr.NumVar(0, INF, f"q{i}") for i in range(n)]

    # Build net(item) expressions by accumulating only non-zero coefficients.
    # For each item, net_coeff[i] = eff_out[rkeys[i]][item] - inputs[rkeys[i]][item].
    # Storing as sparse {var_index: coeff} avoids O(n * items) zero multiplications.
    def sparse_net(item: str) -> Dict[int, float]:
        d: Dict[int, float] = {}
        for i, k in enumerate(rkeys):
            c = eff_out[k].get(item, 0.0) - usable[k].inputs.get(item, 0.0)
            if c:
                d[i] = c
        return d

    net_sparse = {item: sparse_net(item) for item in item_set}

    # Non-resource flow-balance constraints: net(item) >= 0 for all items.
    # This permits unavoidable byproducts (e.g. Heavy Oil Residue alongside Rubber)
    # to be surplus without making the LP infeasible.
    net_expr: Dict[str, object] = {}
    for item in item_set:
        sp = net_sparse[item]
        expr = slvr.Sum([q[i] * c for i, c in sp.items()])
        net_expr[item] = expr  # used by must/min/max produce below

        if item not in scenario.available_resources:
            ct = slvr.Constraint(0.0, INF, f"flow_{item}")
            for i, c in sp.items():
                ct.SetCoefficient(q[i], c)

    # Resource capacity constraints: cons - prod <= supply
    # Equivalent to: -net(item) <= supply - supply_const  →  -net_q <= supply
    # We express as sum(input_i - eff_out_i) * q[i] <= supply.
    # Kept separately so duals can be read after solving.
    res_constraints: Dict[str, object] = {}
    for item, supply in scenario.available_resources.items():
        ct = slvr.Constraint(-INF, supply, f"res_{item}")
        sp = net_sparse[item]
        for i, c in sp.items():
            ct.SetCoefficient(q[i], -c)   # cons - prod = -(eff_out - inputs)
        res_constraints[item] = ct

    # Goal constraints
    for item, qty in scenario.must_produce.items():
        if item not in net_expr:
            continue
        ct = slvr.Constraint(qty, qty, f"must_{item}")
        sp = net_sparse[item]
        supply = scenario.available_resources.get(item, 0.0)
        # net(item) == qty  →  sum(net_coeff * q) == qty - supply
        for i, c in sp.items():
            ct.SetCoefficient(q[i], c)
        ct.SetBounds(qty - supply, qty - supply)

    for item, qty in scenario.min_produce.items():
        if item not in net_expr:
            continue
        supply = scenario.available_resources.get(item, 0.0)
        ct = slvr.Constraint(qty - supply, INF, f"min_{item}")
        for i, c in net_sparse[item].items():
            ct.SetCoefficient(q[i], c)

    for item, qty in scenario.max_produce.items():
        if item not in net_expr:
            continue
        supply = scenario.available_resources.get(item, 0.0)
        ct = slvr.Constraint(-INF, qty - supply, f"max_{item}")
        for i, c in net_sparse[item].items():
            ct.SetCoefficient(q[i], c)

    if scenario.max_machines is not None:
        ct = slvr.Constraint(-INF, float(scenario.max_machines), "max_machines")
        for qi in q:
            ct.SetCoefficient(qi, 1.0)

    # Objective: maximise sum(weight * net(item)) over objective items.
    # Ties (same goal output, different machines/resources) are broken afterwards
    # by _plan, not by epsilon terms here.
    obj = slvr.Objective()
    obj.SetMaximization()
    for item, w in scenario.objective.items():
        if item not in net_sparse:
            continue
        for i, c in net_sparse[item].items():
            obj.SetCoefficient(q[i], obj.GetCoefficient(q[i]) + w * c)
        # supply * w is a constant and does not affect q — omitted intentionally

    # Min New Alts penalty: when the modifier is on, subtract a moderate penalty
    # for each unit of throughput on alt recipes the user hasn't unlocked yet.
    # Penalty is large enough to prefer base/unlocked paths when they exist, but
    # small enough that a genuinely needed new alt can still win.
    # Scaled at 1e-3 × machines — far below typical objective weights (≥1), so
    # it never overrules the actual production goal.
    if scenario.minimize_new_alts:
        unlocked_set_lp = set(scenario.unlocked_alt_recipes)
        # pre-fetch recipe metadata to check .alternate without re-importing
        for i, k in enumerate(rkeys):
            r = usable[k]
            if r.alternate and k not in unlocked_set_lp:
                obj.SetCoefficient(q[i], obj.GetCoefficient(q[i]) - _NEW_ALT_PEN)

    return slvr, q, rkeys, net_expr, res_constraints


# ── Warm-start LP wrapper ─────────────────────────────────────────────────────
class WarmLP:
    """
    A GLOP model of the continuous LP with sloop multipliers baked in, kept
    around so the saturation search can move one resource bound at a time and
    re-solve from the previous basis.
    """

    def __init__(self, scenario: Scenario, usable: Dict[str, Recipe],
                 spm: Dict[str, int]):
        self.scenario = scenario
        self.usable   = usable
        self.spm      = dict(spm)   # own copy — patched in place

        rkeys = list(usable.keys())
        self.rkeys = rkeys
        n = len(rkeys)
        self.ridx: Dict[str, int] = {k: i for i, k in enumerate(rkeys)}

        # Current effective output rates (including sloop multiplier)
        self.eff_out: Dict[str, Dict[str, float]] = {}
        for k in rkeys:
            r = usable[k]
            self.eff_out[k] = {item: rate * _output_mult(r, spm.get(k, 0))
                                for item, rate in r.outputs.items()}

        item_set: Set[str] = set(scenario.available_resources.keys())
        for k in rkeys:
            item_set.update(usable[k].inputs.keys())
            item_set.update(self.eff_out[k].keys())
        self.items = list(item_set)

        slvr = pywraplp.Solver.CreateSolver("GLOP")
        slvr.SuppressOutput()
        self.slvr = slvr
        INF = slvr.infinity()
        q = [slvr.NumVar(0, INF, f"q{i}") for i in range(n)]
        self.q = q

        # Pre-compute sparse net coefficients for every (recipe, item) pair.
        # net_coeff[k][item] = eff_out rate - input rate  (non-zero only)
        net_coeff: Dict[str, Dict[str, float]] = {}
        for k in rkeys:
            r  = usable[k]
            nc: Dict[str, float] = {}
            for item, rate in self.eff_out[k].items():
                c = rate - r.inputs.get(item, 0.0)
                if c:
                    nc[item] = c
            for item, rate in r.inputs.items():
                if item not in nc:
                    c = -rate   # pure consumer; eff_out is 0
                    if c:
                        nc[item] = c
            net_coeff[k] = nc

        # Pass 1: flow constraints (non-resource items): net(item) >= 0.
        # All items — including unavoidable byproducts — are allowed to be surplus.
        self.flow_ct: Dict[str, object] = {}
        for item in self.items:
            if item in scenario.available_resources:
                continue
            ct = slvr.Constraint(0.0, INF, f"flow_{item}")
            for i, k in enumerate(rkeys):
                c = net_coeff[k].get(item, 0.0)
                if c:
                    ct.SetCoefficient(q[i], c)
            self.flow_ct[item] = ct

        self.res_ct: Dict[str, object] = {}
        for item, supply in scenario.available_resources.items():
            ct = slvr.Constraint(-INF, supply, f"res_{item}")
            for i, k in enumerate(rkeys):
                # res_ct expresses cons - prod <= supply,
                # i.e. -(eff_out - inputs) = inputs - eff_out per recipe
                c = net_coeff[k].get(item, 0.0)
                if c:
                    ct.SetCoefficient(q[i], -c)
            self.res_ct[item] = ct

        # must/min/max produce — accept items present in either constraint dict
        # (mirrors the `if item in net_expr` guard in _build_lp exactly).
        def _add_produce_ct(item: str, lo: float, hi: float, name: str) -> Optional[object]:
            if item not in self.flow_ct and item not in self.res_ct:
                return None
            supply = scenario.available_resources.get(item, 0.0)
            ct = slvr.Constraint(
                lo - supply if lo > -INF else -INF,
                hi - supply if hi <  INF else  INF,
                name,
            )
            for i, k in enumerate(rkeys):
                c = net_coeff[k].get(item, 0.0)
                if c:
                    ct.SetCoefficient(q[i], c)
            return ct

        self.must_ct: Dict[str, object] = {}
        for item, qty in scenario.must_produce.items():
            ct = _add_produce_ct(item, qty, qty, f"must_{item}")
            if ct:
                self.must_ct[item] = ct

        self.min_ct: Dict[str, object] = {}
        for item, qty in scenario.min_produce.items():
            ct = _add_produce_ct(item, qty, INF, f"min_{item}")
            if ct:
                self.min_ct[item] = ct

        self.max_ct: Dict[str, object] = {}
        for item, qty in scenario.max_produce.items():
            ct = _add_produce_ct(item, -INF, qty, f"max_{item}")
            if ct:
                self.max_ct[item] = ct

        if scenario.max_machines is not None:
            ct = slvr.Constraint(-INF, float(scenario.max_machines), "max_machines")
            for qi in q:
                ct.SetCoefficient(qi, 1.0)

        # Objective — mirrors _build_lp: accept items in either constraint dict.
        # Supply is a constant and is omitted intentionally (see _build_lp note).
        obj = slvr.Objective()
        obj.SetMaximization()
        self._obj_weights: Dict[str, float] = {}
        for item, w in scenario.objective.items():
            if item not in self.flow_ct and item not in self.res_ct:
                continue
            self._obj_weights[item] = w
            for i, k in enumerate(rkeys):
                c = net_coeff[k].get(item, 0.0)
                if c:
                    obj.SetCoefficient(q[i], obj.GetCoefficient(q[i]) + w * c)

        # Min New Alts penalty — same as _build_lp.
        if scenario.minimize_new_alts:
            unlocked = set(scenario.unlocked_alt_recipes)
            for i, k in enumerate(rkeys):
                if usable[k].alternate and k not in unlocked:
                    obj.SetCoefficient(q[i], obj.GetCoefficient(q[i]) - _NEW_ALT_PEN)

    def solve(self) -> Tuple[str, float, Dict[str, float]]:
        status = self.slvr.Solve()
        ok = status in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE)
        if not ok:
            return "Infeasible", 0.0, {}
        q_vals = {self.rkeys[i]: max(0.0, self.q[i].solution_value())
                  for i in range(len(self.rkeys))}
        return "Optimal", self.slvr.Objective().Value(), q_vals

# ── Saturation binary search ──────────────────────────────────────────────────
def _sat_search(
    item: str,
    scenario: Scenario,
    usable: Dict[str, Recipe],
    spm: Dict[str, int],
) -> Optional[float]:
    """
    Binary search for the supply level of `item` where its shadow price drops to
    zero (adding more stops helping the objective).

    Fast path: if the item's resource constraint doesn't appear in the LP (the
    item is never consumed by any recipe), the shadow price is always 0 — return
    None immediately rather than running 28 LP solves to learn nothing.

    Uses one WarmLP for all iterations; only the constraint upper-bound changes.
    Returns the saturation supply level rounded to 1 decimal place.
    """
    lo = scenario.available_resources[item]

    # Build a private WarmLP with a mutable resource dict so we can adjust SetUb.
    res2 = dict(scenario.available_resources)
    sc2  = _dc_replace(scenario, available_resources=res2, description="", notes="")
    warm = WarmLP(sc2, usable, spm)
    res_ct = warm.res_ct.get(item)

    # Fast path: item is not consumed by any recipe in the LP → always slack
    if res_ct is None:
        return None

    # Adaptive upper-bound search: double hi until the dual at hi drops to zero.
    # This avoids the pathological case where lo == 0, which made the old
    # fixed bound (max(0*20+5000, 0+50000) = 50000) require 28 iterations to
    # narrow all the way down to a true saturation point of, say, 300.
    hi = max(lo * 2.0, lo + 100.0)
    for _ in range(20):
        res_ct.SetUb(hi)
        st = warm.slvr.Solve()
        if st not in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE):
            break
        try:
            d = res_ct.dual_value()
        except Exception:
            d = 0.0
        if d < 0.001:
            break
        hi *= 2.0

    for _ in range(28):        # ≤28 iterations; converges to 0.5-unit precision
        if hi - lo < 0.5:
            break
        mid = (lo + hi) / 2.0
        res_ct.SetUb(mid)
        status = warm.slvr.Solve()
        ok = status in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE)
        if not ok:
            hi = mid
            continue
        try:
            dual_mid = res_ct.dual_value()
        except Exception:
            dual_mid = 0.0
        if dual_mid < 0.001:
            hi = mid
        else:
            lo = mid
    return round(hi, 1)


# ── LP with duals ─────────────────────────────────────────────────────────────
def _solve_lp_with_duals(
    scenario: Scenario,
    usable: Dict[str,Recipe],
    spm: Dict[str,int],
) -> Tuple[str, float, Dict[str,float], Dict[str,float], Dict[str,Optional[float]]]:
    """
    Solve LP and extract shadow prices + saturation points for resource constraints.

    Shadow price of resource R = marginal improvement in objective per additional
    unit/min of R at the current supply level.  This is the LP dual value.

    GLOP dual_value() for a <= constraint in a maximisation problem returns a
    NON-NEGATIVE value when the constraint is binding.  Zero means resource has slack.

    Saturation point: supply level at which shadow price drops to zero.
    Found by binary search per binding resource (parallelised).

    Returns (status, objective, q_vals, shadow_prices, saturation_points).
    saturation_points[item] = None  → resource already has slack (not worth searching).
    """
    if not usable:
        return "No recipes", 0.0, {}, {}, {}
    slvr, q, rkeys, _, res_constraints = _build_lp(scenario, usable, spm)
    status = slvr.Solve()
    ok = status in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE)
    if not ok:
        return "Infeasible", 0.0, {}, {}, {}

    q_vals = {rkeys[i]: max(0.0, q[i].solution_value()) for i in range(len(rkeys))}

    # Extract shadow prices (raw dual_value() — no negation required for GLOP max)
    shadow: Dict[str, float] = {}
    for item, ct in res_constraints.items():
        try:
            shadow[item] = round(ct.dual_value(), 6)
        except Exception:
            shadow[item] = 0.0

    # Saturation points: only search binding resources; others are immediately None
    binding_items = [item for item, sp in shadow.items() if sp >= 0.001]
    saturation: Dict[str, Optional[float]] = {
        item: None for item in shadow if shadow[item] < 0.001
    }

    if binding_items:
        with ThreadPoolExecutor(max_workers=min(len(binding_items), 8)) as ex:
            futs = {
                ex.submit(_sat_search, item, scenario, usable, spm): item
                for item in binding_items
            }
            for fut in as_completed(futs):
                item = futs[fut]
                try:
                    saturation[item] = fut.result()
                except Exception:
                    saturation[item] = None

    return "Optimal", slvr.Objective().Value(), q_vals, shadow, saturation


# ── Exact planner (mixed-integer) ─────────────────────────────────────────────
# One mixed-integer model of the whole factory, solved in three lexicographic
# stages. Each stage keeps the previous stages' optimum locked in place:
#
#   1. Goal  — maximise the weighted goal items.
#   2. Lean  — minimise a balanced cost of machines and raw resources.
#   3. Clean — minimise recipes and duplicate producers of one product, letting
#              the stage-2 cost rise by at most _COST_SLACK.
#   4. Tidy  — with everything above locked, the fewest somersloops (so none
#              sits in a machine where it changes nothing). Shards are always
#              the fewest the chosen machine counts need.
#
# Columns, per recipe k and (when somersloops are available) per sloop level l:
#   q[k,l]  machine-equivalents at 100% clock (continuous) — the throughput
#   n[k,l]  physical machines (integer)
#   s[k,l]  power shards (integer, ≤ 3 per machine);  q ≤ n + 0.5·s
#   y[k]    recipe k is used at all (binary; stage 3 only)
# A recipe may run machines at several sloop levels at once (e.g. one
# Manufacturer with 4 sloops and two with none) — each machine is filled
# individually in-game, and mixing is never worse than one level per recipe.
# Budgets: Σ l·n ≤ somersloops, Σ s ≤ shards, Σ n ≤ max_machines.
#
# Stage 2 can't add "1 per machine + 1 per resource unit": resource rates run
# from single digits to thousands (Water) and would drown out machines. Each
# term is measured against its own scale instead —
#   machines  → Σ n / (machine-equivalents in the stage-1 solution)
#   resources → mean over resources of (net use / supply)
# — so "a whole factory's worth of machines" and "all of every resource" each
# count as 1; the weights say how those two compare. Power is not optimised.
_W_MACHINES    = 1.0
_W_RESOURCES   = 1.0
_GOAL_TOL      = 1e-7    # relative slack on the locked goal
_COST_SLACK    = 0.01    # stage 3 may raise stage 2's cost by ≤1%
_PARALLEL_PEN  = 0.5     # a 2nd producer of one product costs half a recipe extra
_STAGE_TIME_S  = (20, 20, 15)   # per stage; on timeout the best plan so far is kept
_Q_EPS         = 1e-6    # throughput below this is treated as "not running"
_MIP_BACKENDS  = ("SCIP", "CBC")
_USE_HINTS     = True    # warm-start each stage from the previous stage's plan
_MIP_GAP       = 1e-9    # prove optimality, not "within 0.01%"
# These models are small but SCIP's defaults restart the root node repeatedly
# and run long cut loops on them; both settings cut solve time ~3× with
# identical results.
_SCIP_PARAMS   = "presolving/maxrestarts = 0\nseparating/maxroundsroot = 5\n"


@dataclass
class _Part:
    level:  int     # sloops in each of these machines
    q:      float   # machine-equivalents at 100% clock
    n:      int     # physical machines
    shards: int


@dataclass
class _Plan:
    parts:  Dict[str, List[_Part]]   # recipe → machine groups by sloop level
    goal:   float              # weighted goal value (supply constant omitted)
    proven: bool               # goal and lean stages proven optimal
    clean_proven: bool = True  # recipe cleanup proven optimal

    def machines(self) -> int:
        return sum(p.n for ps in self.parts.values() for p in ps)


# Column keys: ("q"|"n"|"s", recipe, level). Expressions are {key: coeff} dicts
# so the same lock can be applied to the integer model and its continuous twin.
Key = Tuple[str, str, int]


class _Model:
    """
    The factory model in one OR-Tools solver. integer=True → SCIP (or CBC)
    with integer machines, shards and sloops; integer=False → the GLOP
    relaxation, used to derive bounds and for LP-only stages.
    """
    BIG = 1e5   # big-M before bounds are known; replaced by tighten()

    def __init__(self, scenario: Scenario, usable: Dict[str, Recipe], integer: bool):
        s = None
        if integer:
            for backend in _MIP_BACKENDS:
                s = pywraplp.Solver.CreateSolver(backend)
                if s is not None:
                    break
        self.integer = s is not None
        if s is None:
            s = pywraplp.Solver.CreateSolver("GLOP")
        s.SuppressOutput()
        self.s, self.inf = s, s.infinity()
        INF = self.inf
        ivar = s.IntVar if self.integer else s.NumVar

        S, SH = scenario.somersloops_available, scenario.power_shards_available
        # Without an integer solver, sloops can't be placed per machine.
        use_sloops = S > 0 and (self.integer or not integer)

        self.var: Dict[Key, object] = {}
        self.levels: Dict[str, List[int]] = {}
        self.links: Dict[str, List[object]] = {}   # recipe → constraints "n ≤ M·binary"
        self.y: Dict[str, object] = {}
        self.net: Dict[str, Dict[Key, float]] = {}
        for k, r in usable.items():
            levels = [l for l in range(r.sloop_slots + 1) if l <= S] \
                     if use_sloops and r.sloop_slots > 0 else [0]
            self.levels[k] = levels
            if self.integer:
                self.y[k] = s.BoolVar("")
            links = []
            for l in levels:
                q = self.var[("q", k, l)] = s.NumVar(0, INF, "")
                n = self.var[("n", k, l)] = ivar(0, INF, "")
                cap = s.Constraint(-INF, 0.0)              # q ≤ n + 0.5·s
                cap.SetCoefficient(q, 1.0); cap.SetCoefficient(n, -1.0)
                if SH > 0:
                    sh = self.var[("s", k, l)] = ivar(0, INF, "")
                    cap.SetCoefficient(sh, -SHARD_BOOST)
                    c3 = s.Constraint(-INF, 0.0)           # s ≤ 3·n
                    c3.SetCoefficient(sh, 1.0); c3.SetCoefficient(n, -3.0)
                if self.integer:                           # n ≤ M·y
                    c = s.Constraint(-INF, 0.0)
                    c.SetCoefficient(n, 1.0); c.SetCoefficient(self.y[k], -self.BIG)
                    links.append((c, self.y[k], "n"))
                mult = _output_mult(r, l)
                for it in set(r.inputs) | set(r.outputs):
                    c = r.outputs.get(it, 0.0) * mult - r.inputs.get(it, 0.0)
                    if c:
                        self.net.setdefault(it, {})[("q", k, l)] = c
            self.links[k] = links

        res = scenario.available_resources
        for it, sp in self.net.items():
            if it in res:
                self.ct(-INF, res[it], {v: -c for v, c in sp.items()})
            else:
                self.ct(0.0, INF, sp)
        for it, qty in scenario.must_produce.items():
            if it in self.net:
                self.ct(qty - res.get(it, 0.0), qty - res.get(it, 0.0), self.net[it])
        for it, qty in scenario.min_produce.items():
            if it in self.net:
                self.ct(qty - res.get(it, 0.0), INF, self.net[it])
        for it, qty in scenario.max_produce.items():
            if it in self.net:
                self.ct(-INF, qty - res.get(it, 0.0), self.net[it])

        self.machines = {key: 1.0 for key in self.var if key[0] == "n"}
        self.sloops = {key: float(key[2]) for key in self.machines if key[2]}
        if use_sloops:
            self.ct(-INF, float(S), self.sloops)
        if SH > 0:
            self.ct(-INF, float(SH), {key: 1.0 for key in self.var if key[0] == "s"})
        if scenario.max_machines is not None:
            self.ct(-INF, float(scenario.max_machines), self.machines)

        self.goal: Dict[Key, float] = {}
        for it, w in scenario.objective.items():
            for key, c in self.net.get(it, {}).items():
                self.goal[key] = self.goal.get(key, 0.0) + w * c
        self.new_alt: Dict[Key, float] = {}
        if scenario.minimize_new_alts:
            unlocked = set(scenario.unlocked_alt_recipes)
            self.new_alt = {key: 1.0 for key in self.var if key[0] == "q"
                            and usable[key[1]].alternate and key[1] not in unlocked}
        self._hint: Optional[Tuple[list, list]] = None

    # ── helpers ──
    def ct(self, lo: float, hi: float, coeffs: Dict[Key, float]):
        c = self.s.Constraint(lo, hi)
        for key, a in coeffs.items():
            v = self.var.get(key)
            if v is not None and a:
                c.SetCoefficient(v, a)
        return c

    def value(self, coeffs: Dict[Key, float]) -> float:
        return sum(a * self.var[key].solution_value()
                   for key, a in coeffs.items() if key in self.var)

    def bound_recipe(self, k: str, ub: Optional[float]) -> None:
        """Tighten recipe k's columns to at most ub machine-equivalents."""
        if ub is None:
            return
        m_n = max(0, math.ceil(ub - 1e-9))
        for l in self.levels[k]:
            self.var[("q", k, l)].SetUb(max(ub, 0.0))
            self.var[("n", k, l)].SetUb(m_n)
            if ("s", k, l) in self.var:
                self.var[("s", k, l)].SetUb(3 * m_n)
        for c, bv, kind in self.links.get(k, []):
            c.SetCoefficient(bv, -float(m_n) if kind == "n" else -max(ub, 0.0))

    def run(self, coeffs: Dict[Key, float], maximize: bool, time_s: float) -> Optional[bool]:
        """Solve with this objective. None = failed, else True if proven optimal."""
        obj = self.s.Objective()
        obj.Clear()
        for key, a in coeffs.items():
            v = self.var.get(key)
            if v is not None:
                obj.SetCoefficient(v, obj.GetCoefficient(v) + a)
        obj.SetMaximization() if maximize else obj.SetMinimization()
        self.s.SetTimeLimit(int(time_s * 1000))
        if self.integer:
            if self._hint and _USE_HINTS:
                self.s.SetHint(*self._hint)
            if _SCIP_PARAMS and self.s.SolverVersion().startswith("SCIP"):
                self.s.SetSolverSpecificParametersAsString(_SCIP_PARAMS)
            p = pywraplp.MPSolverParameters()
            p.SetDoubleParam(p.RELATIVE_MIP_GAP, _MIP_GAP)
            st = self.s.Solve(p)
        else:
            st = self.s.Solve()
        if st not in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE):
            return None
        if self.integer:   # warm start for the next stage (read before any new constraint)
            vs = [v for v in self.s.variables()]
            self._hint = (vs, [v.solution_value() for v in vs])
        return st == pywraplp.Solver.OPTIMAL

    def snapshot(self, proven: bool) -> _Plan:
        parts: Dict[str, List[_Part]] = {}
        for (kind, k, l), v in self.var.items():
            if kind != "q":
                continue
            x = v.solution_value()
            if x < _Q_EPS:
                continue
            n = max(1, int(round(self.var[("n", k, l)].solution_value()))) \
                if self.integer else math.ceil(x - 1e-9)
            parts.setdefault(k, []).append(_Part(l, x, n, _min_shards(x, n) or 0))
        for ps in parts.values():
            ps.sort(key=lambda p: -p.level)
        return _Plan(parts, self.value(self.goal), proven)


def _plan(scenario: Scenario, usable: Dict[str, Recipe],
          warnings: List[str]) -> Optional[_Plan]:
    """Run the three stages. Returns None when the scenario is infeasible."""
    mip = _Model(scenario, usable, integer=True)
    lp  = _Model(scenario, usable, integer=False)    # relaxation: bounds + LP-only stages
    if not mip.integer:
        warnings.append("No integer solver available — machine counts are rounded, "
                        "somersloops and shards are not optimised.")

    def lock(lo: float, hi: float, expr_of) -> None:
        mip.ct(lo, hi, expr_of(mip))
        lp.ct(lo, hi, expr_of(lp))

    def tighten() -> None:
        """Per-recipe max throughput under the current locks → tight big-Ms.
        Recipes that can't run at all under the locks are switched off."""
        for k, levels in lp.levels.items():
            cols = {("q", k, l): 1.0 for l in levels}
            if lp.run(cols, True, 5) is not None:
                mip.bound_recipe(k, lp.value(cols) * (1 + 1e-7) + 1e-6)

    tighten()
    proven = True
    best: Optional[_Plan] = None

    # ── Stage 1: goal ──
    if mip.goal or mip.new_alt:
        def stage1(m):
            obj = dict(m.goal)
            for key, a in m.new_alt.items():
                obj[key] = obj.get(key, 0.0) - _NEW_ALT_PEN * a
            return obj
        # Integers only matter for the goal when sloops or a machine cap are in play
        integer_goal = mip.integer and (scenario.somersloops_available > 0
                                        or scenario.max_machines is not None)
        m1 = mip if integer_goal or not mip.integer else lp
        ok = m1.run(stage1(m1), True, _STAGE_TIME_S[0])
        if ok is None:
            return None
        proven &= ok
        g, a = m1.value(m1.goal), m1.value(m1.new_alt)
        if m1 is mip:
            best = mip.snapshot(proven)
        m0 = max(sum(v.solution_value() for key, v in m1.var.items() if key[0] == "q"), 1.0)
        if mip.goal:
            lock(g - max(1e-6, abs(g) * _GOAL_TOL), mip.inf, lambda m: m.goal)
        if mip.new_alt:
            lock(-mip.inf, a + 1e-6, lambda m: m.new_alt)
        tighten()
    else:
        # No goal to scale from: size the factory by its fewest machine-equivalents
        qs = {key: 1.0 for key in lp.var if key[0] == "q"}
        if lp.run(qs, False, _STAGE_TIME_S[0]) is None:
            return None
        m0 = max(lp.value(qs), 1.0)

    # ── Stage 2: lean ──
    supplied = [it for it, v in scenario.available_resources.items() if v > 0]
    def cost_of(m) -> Dict[Key, float]:
        cost = {key: _W_MACHINES / m0 for key in m.machines}
        for it in supplied:
            w = _W_RESOURCES / len(supplied) / scenario.available_resources[it]
            for key, c in m.net.get(it, {}).items():
                cost[key] = cost.get(key, 0.0) - c * w     # −net = consumption
        return cost
    cost = cost_of(mip)
    ok = mip.run(cost, False, _STAGE_TIME_S[1])
    if ok is None:
        return best
    proven &= ok
    best = mip.snapshot(proven)
    c2 = mip.value(cost)
    lock(-mip.inf, c2 + abs(c2) * _COST_SLACK + 1e-9, cost_of)
    if not mip.integer:
        return best
    tighten()

    # ── Stage 3: clean ──
    # 3a: fewest recipes + duplicate producers (a half-integer score, quick to
    # prove); 3b: with that locked, the lowest stage-2 cost among such plans.
    obj: Dict[Key, float] = {}
    for k, yv in mip.y.items():
        obj[("y", k, 0)] = 1.0
        mip.var[("y", k, 0)] = yv
    by_main: Dict[str, List[str]] = {}
    for k, r in usable.items():
        if r.outputs:
            by_main.setdefault(next(iter(r.outputs)), []).append(k)
    for i, ks in enumerate(by_main.values()):
        if len(ks) > 1:
            extra = mip.var[("x", f"dup{i}", 0)] = mip.s.NumVar(0, mip.inf, "")
            c = mip.s.Constraint(-1.0, mip.inf)    # extra ≥ (#producers used) − 1
            c.SetCoefficient(extra, 1.0)
            for k in ks:
                c.SetCoefficient(mip.y[k], -1.0)
            obj[("x", f"dup{i}", 0)] = _PARALLEL_PEN
    ok = mip.run(obj, False, _STAGE_TIME_S[2])
    if ok is None:
        return best
    best = mip.snapshot(proven)
    best.clean_proven = ok
    mip.ct(-mip.inf, mip.value(obj) + 1e-6, obj)
    ok_b = mip.run(cost, False, _STAGE_TIME_S[2])
    if ok_b is None:
        return best
    best = mip.snapshot(proven)
    best.clean_proven = ok and ok_b

    # ── Stage 4: tidy ──
    if mip.sloops and scenario.somersloops_available > 0:
        c3 = mip.value(cost)
        mip.ct(-mip.inf, c3 + abs(c3) * 1e-9 + 1e-9, cost)
        if mip.run(mip.sloops, False, _STAGE_TIME_S[2]) is not None:
            tidy = mip.snapshot(proven)
            tidy.clean_proven = best.clean_proven
            best = tidy
    return best


# ── Machine layouts ───────────────────────────────────────────────────────────
def _layout_groups(q: float, n: int, shards: int) -> List[Tuple[int, float, int]]:
    """
    Physical layout for n machines delivering q machine-equivalents with the
    given shards: [(count, clock_fraction, shards_each)], at most three groups —
    fully-sharded machines at 250%, one partly-sharded machine, and the rest.
    Machines without shards run at 100% unless no shards are used at all, in
    which case all n share the load evenly.
    """
    if n <= 0:
        return []
    if shards <= 0:
        return [(n, q / n, 0)]
    full, part = divmod(shards, 3)
    groups = []
    if full:
        groups.append([full, MAX_CLOCK, 3])
    if part:
        groups.append([1, 1.0 + SHARD_BOOST * part, part])
    rest = n - full - (1 if part else 0)
    if rest:
        groups.append([rest, 1.0, 0])
    # Shed the spare capacity (< 0.5 machine when shards are minimal) from one
    # overclocked machine, splitting it off into its own group if needed.
    excess = sum(c * clk for c, clk, _ in groups) - q
    if excess > 1e-9:
        i = (1 if full else 0) if part else 0      # the partly-sharded machine, else a full one
        if groups[i][0] > 1:
            groups[i][0] -= 1
            groups.insert(i + 1, [1, groups[i][1], groups[i][2]])
            i += 1
        groups[i][1] = max(groups[i][1] - excess, 0.01)
        # anything still left (only when shards weren't minimal) comes off the rest
        left = sum(c * clk for c, clk, _ in groups) - q
        if left > 1e-9 and rest:
            groups[-1][1] = max(1.0 - left / rest, 0.01)
    return [(c, clk, s) for c, clk, s in groups if c > 0]


def _layout_label(groups: List[Tuple[int, float, int]]) -> str:
    parts = []
    for c, clk, s in groups:
        t = f"{c} × {clk * 100:.1f}%"
        if s:
            t += f" ({s} shard{'s' if s > 1 else ''})"
        parts.append(t)
    return " + ".join(parts)


def _layout_power(r: Recipe, level: int, groups: List[Tuple[int, float, int]]) -> float:
    return r.base_power_mw * _sloop_power_mult(r, level) * \
        sum(c * clk ** POWER_EXP for c, clk, _ in groups)


def _min_shards(q: float, n: int) -> Optional[int]:
    """Fewest shards letting n machines deliver q, or None if impossible."""
    if q > n * MAX_CLOCK + 1e-9:
        return None
    return max(0, math.ceil(2.0 * (q - n) - 1e-6)) if q > n + 1e-9 else 0


def _layout_options(r: Recipe, qv: float, level: int, chosen_n: int) -> List[LayoutOption]:
    """
    Integer layouts for this recipe: every machine count from ceil(q) (no
    shards) down to the fewest machines 250% clocks allow, with the fewest
    shards each needs. Always includes the chosen layout.
    """
    hi = math.ceil(qv - 1e-9)
    lo = max(1, math.ceil(qv / MAX_CLOCK - 1e-9))
    counts = list(range(hi, lo - 1, -1))
    if len(counts) > 4:
        counts = counts[:3] + [lo]
    if chosen_n not in counts:
        counts.append(chosen_n)
    opts = []
    for n in sorted(set(counts), reverse=True):
        sh = _min_shards(qv, n)
        if sh is None:
            continue
        g = _layout_groups(qv, n, sh)
        opts.append(LayoutOption(n, round(max(c[1] for c in g) * 100, 1), sh,
                                 round(_layout_power(r, level, g), 2), _layout_label(g)))
    return opts


# ── Main solve ────────────────────────────────────────────────────────────────
def solve(scenario: Scenario, all_recipes: Dict[str,Recipe],
          machine_meta: Optional[Dict] = None) -> SolveResult:
    warnings:       List[str] = []
    conflict_hints: List[str] = []
    cap_overshoot:  Dict[str,float] = {}

    # Prune once — reused for all LP solves in this call
    usable, unsatisfiable = prune_recipes(scenario, all_recipes)
    pruned_count = len(usable)

    if not usable and not unsatisfiable:
        conflict_hints.append("No recipes reachable from your resources and objectives.")
        return SolveResult("No recipes", 0, [], {}, {}, {}, {}, {}, {}, {},
                           0, 0, 0, 0, warnings, conflict_hints, 0, {})

    shadow_prices:     Dict[str,float]  = {}   # computed lazily via compute_duals()
    saturation_points: Dict[str,object] = {}

    plan = _plan(scenario, usable, warnings) if usable else None
    if plan is None and usable and scenario.max_machines is not None:
        # The cap is below what the constraints need: show the fewest-machine
        # factory that meets them instead.
        plan = _plan(_dc_replace(scenario, max_machines=None, objective={},
                                 minimize_new_alts=False), usable, warnings)
        if plan is not None:
            warnings.append(
                f"max_machines cap ({scenario.max_machines}) is below the "
                f"minimum required ({plan.machines()}); showing minimum machine layout."
            )
    status  = "Optimal" if plan is not None else "Infeasible"
    obj_val = plan.goal if plan is not None else 0.0
    if plan is not None and not plan.proven:
        warnings.append("Solver time limit reached — this is the best plan found, "
                        "but it is not proven optimal.")
    elif plan is not None and not plan.clean_proven:
        warnings.append("Recipe cleanup hit its time limit — output and machine counts "
                        "are optimal, but a plan with fewer recipes may exist.")

    # Build flows — single pass over active recipes
    meta = machine_meta if machine_meta is not None else load_machine_meta()
    flows:             List[FlowResult] = []
    total_power        = 0.0
    total_machines_int = 0
    total_shards       = 0
    total_sloops       = 0

    for k, r in usable.items():
        parts = plan.parts.get(k, []) if plan is not None else []
        if not parts:
            continue
        qv   = sum(p.q for p in parts)
        n_k  = sum(p.n for p in parts)
        sh_k = sum(p.shards for p in parts)
        sl_k = sum(p.level * p.n for p in parts)
        # Effective output multiplier over all machines (throughput-weighted)
        mult = sum(p.q * _output_mult(r, p.level) for p in parts) / qv
        layout, pw = [], 0.0
        for p in parts:
            groups = _layout_groups(p.q, p.n, p.shards)
            pw += _layout_power(r, p.level, groups)
            layout += [{"count": c, "clock_pct": round(clk * 100, 4), "shards": s,
                        "sloops": p.level} for c, clk, s in groups]

        total_power        += pw
        total_machines_int += n_k
        total_shards       += sh_k
        total_sloops       += sl_k

        flows.append(FlowResult(
            recipe_key=k, display=r.display, machine=r.machine,
            machines_float=round(qv, 4),
            machines_final=n_k,
            clock_pct=round(max(g["clock_pct"] for g in layout), 1),
            shards_used=sh_k,
            # effective sloops per machine-equivalent: 1 + spm/slots == mult
            sloops_per_machine=round((mult - 1.0) * r.sloop_slots, 4) if r.sloop_slots else 0,
            sloops_used=sl_k,
            sloop_slots=r.sloop_slots,
            output_multiplier=round(mult, 4),
            power_mw=round(pw, 2),
            inputs={item: round(r.inputs[item] * qv, 4) for item in r.inputs},
            outputs={item: round(r.outputs[item] * qv * mult, 4) for item in r.outputs},
            # Integer layout alternatives only make sense for a single sloop group
            layout_options=(_layout_options(r, qv, parts[0].level, n_k)
                            if len(parts) == 1 else []),
            has_shard=sh_k > 0,
            has_sloop=sl_k > 0,
            hi_machines=sum(g["count"] for g in layout if g["shards"]),
            layout=layout,
        ))

    # Cap overshoot warnings
    if scenario.max_machines is not None and total_machines_int > scenario.max_machines:
        cap_overshoot["machines_over"] = total_machines_int - scenario.max_machines
    if scenario.max_power_mw is not None and total_power > scenario.max_power_mw + 0.5:
        cap_overshoot["power_over"] = round(total_power - scenario.max_power_mw, 1)

    # Net items — single pass accumulates produced, consumed, and supply together.
    # Also tracks source_nodes (resources that are consumed by some recipe).
    item_supply:   Dict[str, float] = dict(scenario.available_resources)
    item_produced: Dict[str, float] = {}
    item_consumed: Dict[str, float] = {}
    for f in flows:
        for item, qty in f.outputs.items():
            item_produced[item] = item_produced.get(item, 0.0) + qty
        for item, qty in f.inputs.items():
            item_consumed[item] = item_consumed.get(item, 0.0) + qty

    all_system = set(item_supply.keys()) | set(item_produced.keys())
    net_items: Dict[str,float] = {}
    source_nodes: Dict[str,float] = {}

    for item in all_system:
        supply   = item_supply.get(item, 0.0)
        produced = item_produced.get(item, 0.0)
        consumed = item_consumed.get(item, 0.0)
        net = supply + produced - consumed
        if abs(net) > 1e-4:
            net_items[item] = round(net, 4)
        if supply > 0 and consumed > 1e-5:
            source_nodes[item] = supply

    # Sink nodes: goal items with positive net
    sink_items = (set(scenario.objective.keys()) | set(scenario.must_produce.keys())
                | set(scenario.min_produce.keys()) | set(scenario.max_produce.keys()))
    sink_nodes: Dict[str,float] = {
        item: round(net_items[item], 4)
        for item in sink_items
        if net_items.get(item, 0.0) > 1e-5
    }

    # Classify unexpected surpluses
    wanted = sink_items | set(scenario.available_resources.keys())
    has_consumer: Set[str] = set()
    for r in usable.values():
        has_consumer.update(r.inputs.keys())

    error_sinks:           Dict[str,float] = {}
    surplus_intermediates: Dict[str,float] = {}
    for item, net in net_items.items():
        if net > 1e-4 and item not in wanted:
            if item in has_consumer:
                surplus_intermediates[item] = net
            else:
                error_sinks[item] = net

    # Error sources: items that could not be produced at all
    error_sources: Dict[str,float] = {}
    for item, reasons in unsatisfiable.items():
        qty = (scenario.must_produce.get(item)
               or scenario.objective.get(item)
               or scenario.min_produce.get(item, 1.0))
        error_sources[item] = float(qty)
        conflict_hints.append(f"'{item}' cannot be produced: {'; '.join(reasons)}")

    if status == "Optimal":
        for item, qty in scenario.must_produce.items():
            if item in net_items and item not in error_sources:
                actual = net_items.get(item, 0.0)
                if actual < qty - max(0.05, qty * 0.01):
                    conflict_hints.append(
                        f"'{item}': needed {qty:.1f}/min, achieved {actual:.2f}/min"
                    )

    flows.sort(key=lambda f: (f.machine, f.display))

    final_status = (
        "Optimal" if status == "Optimal" and not error_sources
        else "Optimal (with errors)" if status == "Optimal"
        else "Infeasible"
    )

    result = SolveResult(
        status=final_status, objective_value=round(obj_val, 4),
        flows=flows, net_items=net_items,
        objective_items={item: round(net_items.get(item, 0), 4) for item in scenario.objective},
        source_nodes=source_nodes, sink_nodes=sink_nodes,
        error_sources=error_sources, error_sinks=error_sinks,
        surplus_intermediates=surplus_intermediates,
        total_power_mw=round(total_power, 2),
        total_machines=total_machines_int,
        shards_used=total_shards, sloops_used=total_sloops,
        warnings=warnings, conflict_hints=conflict_hints,
        pruned_recipe_count=pruned_count, cap_overshoot=cap_overshoot,
        shadow_prices=shadow_prices,
        saturation_points=saturation_points,
        usable=usable,
    )
    return result


# ── Public helpers ────────────────────────────────────────────────────────────
def compute_duals(
    scenario: Scenario,
    all_recipes: Dict[str,Recipe],
    spm: Optional[Dict[str,int]] = None,
    usable: Optional[Dict[str,Recipe]] = None,
) -> Tuple[Dict[str,float], Dict[str,object]]:
    """
    Compute shadow prices and saturation points.
    Called lazily (only when the Analysis modal is opened).

    spm:    sloops-per-machine from the last solve, or {} for no sloops.
    usable: pre-pruned recipe set from the last solve — pass result.usable to skip re-pruning.
    """
    if usable is None:
        usable, _ = prune_recipes(scenario, all_recipes)
    if not usable:
        return {}, {}
    _, _, _, shadow, saturation = _solve_lp_with_duals(scenario, usable, spm or {})
    return shadow, saturation


def compute_build_cost(result: SolveResult, machine_meta: Dict) -> Dict[str,int]:
    """Single-pass accumulation of build materials across all flows."""
    total: Dict[str,int] = {}
    for f in result.flows:
        bc = machine_meta.get(f.machine, {}).get("build_cost", {})
        if not bc:
            continue
        n = f.machines_final
        for item, qty in bc.items():
            total[item] = total.get(item, 0) + qty * n
    return dict(sorted(total.items()))


def result_to_dict(result: SolveResult, scenario: Scenario, machine_meta: Dict) -> dict:
    def lo(o: Optional[LayoutOption]) -> Optional[dict]:
        if o is None:
            return None
        return {"machines": o.machines, "clock_pct": o.clock_pct,
                "shards_needed": o.shards_needed, "power_mw": o.power_mw, "label": o.label}
    return {
        "scenario_name":         scenario.name,
        "status":                result.status,
        "objective_value":       result.objective_value,
        "total_power_mw":        result.total_power_mw,
        "total_machines":        result.total_machines,
        "shards_used":           result.shards_used,
        "sloops_used":           result.sloops_used,
        "warnings":              result.warnings,
        "conflict_hints":        result.conflict_hints,
        "error_sources":         result.error_sources,
        "error_sinks":           result.error_sinks,
        "surplus_intermediates": result.surplus_intermediates,
        "cap_overshoot":         result.cap_overshoot,
        "pruned_recipe_count":   result.pruned_recipe_count,
        "objective_items":       result.objective_items,
        "net_items":             result.net_items,
        "source_nodes":          result.source_nodes,
        "sink_nodes":            result.sink_nodes,
        "build_cost":            compute_build_cost(result, machine_meta),
        "build_cost_shards":     result.shards_used,
        "build_cost_sloops":     result.sloops_used,
        "shadow_prices":         result.shadow_prices,
        "saturation_points":     result.saturation_points,
        "flows": [{
            "recipe_key":         f.recipe_key,
            "display":            f.display,
            "machine":            f.machine,
            "machines_float":     f.machines_float,
            "machines_final":     f.machines_final,
            "clock_pct":          f.clock_pct,
            "shards_used":        f.shards_used,
            "sloops_per_machine": f.sloops_per_machine,
            "sloops_used":        f.sloops_used,
            "sloop_slots":        f.sloop_slots,
            "output_multiplier":  f.output_multiplier,
            "power_mw":           f.power_mw,
            "inputs":             f.inputs,
            "outputs":            f.outputs,
            "layout_options":     [lo(o) for o in f.layout_options],
            "has_shard":          f.has_shard,
            "has_sloop":          f.has_sloop,
            "hi_machines":        f.hi_machines,
            "layout":             f.layout,
        } for f in result.flows],
    }


if __name__ == "__main__":
    import sys
    recipes, meta = load_recipes_and_meta()
    name = sys.argv[1] if len(sys.argv) > 1 else "iron_hub"
    path = SCENARIOS_DIR / f"{name}.yaml"
    if not path.exists():
        print(f"Not found. Available: {list_scenarios()}"); sys.exit(1)
    s = load_scenario(path)
    result = solve(s, recipes, machine_meta=meta)
    print(json.dumps(result_to_dict(result, s, meta), indent=2))
