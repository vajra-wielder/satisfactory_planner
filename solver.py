"""
Satisfactory Factory Planner v3 — Iterative Sloop/Shard Solver

SLOOP ACCOUNTING (critical):
  sloop_assignment[k] = sloops_per_machine for recipe k (integer 0..max_slots)
  LP output multiplier = 1 + sloops_per_machine / max_slots
  Budget cost per iteration = ceil(q[k]) * sloops_per_machine_added
  This ensures LP multipliers and physical sloop cost are consistent.

ITERATIVE SLOOP ALLOCATION:
  Starting from base LP (no sloops), greedily add one slot level to one recipe
  per iteration. Each addition re-solves the full LP so the network rebalances
  naturally — no surplus intermediates, no manual re-routing needed.
  Accept if: objective improves AND total power stays within cap.

POWER FORMULA (sloops per physical machine):
  P = base_mw × clock^1.6 × n_machines × (1 + sloops_per_machine / max_slots)^2

PRUNING:
  Recipe tree is computed once (forward grounding + backward demand) and
  reused for every LP re-solve in the iterative loop. O(1) prune cost.
"""

import math, yaml, json, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, replace as _dc_replace
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple
from ortools.linear_solver import pywraplp

ROOT          = Path(__file__).parent
RECIPES_PATH  = ROOT / "data" / "recipes_complete.yaml"
SCENARIOS_DIR = ROOT / "scenarios"

POWER_EXP   = 1.6
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
    sloops_per_machine: int   # sloops on each physical machine (0..max_slots)
    sloops_used: int          # total sloops = sloops_per_machine * machines_final
    sloop_slots: int
    output_multiplier: float
    power_mw: float
    inputs:  Dict[str,float]
    outputs: Dict[str,float]
    layout_options: List[LayoutOption] = field(default_factory=list)
    has_shard: bool = False
    has_sloop: bool = False
    hi_machines: int = 0  # machines running at clock_pct; rest run at 100% (mixed layout)

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

    def is_allowed(key: str, r: Recipe) -> bool:
        if enabled_machines_set and r.machine not in enabled_machines_set:
            return False
        if r.alternate and key not in alt_enabled_set:
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
    # Gratuitous resource use is suppressed via the epsilon penalty below instead.
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
    # Plus a tiny epsilon penalty on resource consumption to break ties in favour
    # of using fewer resources when it doesn't affect the real objective.
    #
    # The penalty is applied as -ε × consumption per recipe per resource.
    # ε must satisfy: ε × max_total_consumption << min_nonzero_objective_weight.
    # With objective weights typically >= 1 and total consumption << 1e6,
    # ε = 1e-7 is safe — it never changes which solution is optimal, only
    # which tie is broken (e.g. 200 idle Limestone stays idle instead of
    # being routed through Concrete with no benefit to the real objective).
    _EPS = 1e-7
    obj = slvr.Objective()
    obj.SetMaximization()
    for item, w in scenario.objective.items():
        if item not in net_sparse:
            continue
        for i, c in net_sparse[item].items():
            obj.SetCoefficient(q[i], obj.GetCoefficient(q[i]) + w * c)
        # supply * w is a constant and does not affect q — omitted intentionally

    # Epsilon penalty: subtract ε × (consumption - production) for each resource.
    # consumption - production = -(net_coeff) = the res_ct coefficient per recipe.
    # This rewards recipes that consume less of each raw resource.
    for item in scenario.available_resources:
        sp = net_sparse.get(item, {})
        for i, c in sp.items():
            # c = eff_out - inputs  →  resource consumption contribution = -c
            obj.SetCoefficient(q[i], obj.GetCoefficient(q[i]) + _EPS * c)

    return slvr, q, rkeys, net_expr, res_constraints


def _solve_lp(
    scenario: Scenario,
    usable: Dict[str,Recipe],
    spm: Dict[str,int],
) -> Tuple[str, float, Dict[str,float]]:
    """Standard solve — returns (status, objective, q_values)."""
    if not usable:
        return "No recipes", 0.0, {}
    slvr, q, rkeys, _, _ = _build_lp(scenario, usable, spm)
    status = slvr.Solve()
    ok = status in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE)
    if not ok:
        return "Infeasible", 0.0, {}
    q_vals = {rkeys[i]: max(0.0, q[i].solution_value()) for i in range(len(rkeys))}
    return "Optimal", slvr.Objective().Value(), q_vals


def _solve_lp_min_machines(
    scenario: Scenario,
    usable: Dict[str,Recipe],
    spm: Dict[str,int],
) -> Tuple[str, float, Dict[str,float]]:
    """
    Solve with objective replaced by minimise sum(q).
    All production/resource/must/min/max constraints are preserved via _build_lp;
    only the objective is swapped.  max_machines is intentionally stripped so the
    solver finds the unconstrained minimum — the caller uses the result to learn
    what the true floor is, not to enforce the cap.

    Returns (status, objective, q_values) where objective = sum(q) at optimum.
    """
    if not usable:
        return "No recipes", 0.0, {}
    sc_uncapped = _dc_replace(scenario, max_machines=None)
    slvr, q, rkeys, _, _ = _build_lp(sc_uncapped, usable, spm)

    # Replace objective: minimise sum(q)
    obj = slvr.Objective()
    obj.Clear()
    obj.SetMinimization()
    for qi in q:
        obj.SetCoefficient(qi, 1.0)

    status = slvr.Solve()
    ok = status in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE)
    if not ok:
        return "Infeasible", 0.0, {}
    q_vals = {rkeys[i]: max(0.0, q[i].solution_value()) for i in range(len(rkeys))}
    return "Optimal", slvr.Objective().Value(), q_vals


# ── Warm-start LP wrapper ─────────────────────────────────────────────────────
class WarmLP:
    """
    Wraps a GLOP solver instance and exposes patch_spm() to update output
    multipliers for a single recipe without rebuilding the entire LP.

    When sloops_per_machine changes for recipe k:
      new_mult = 1 + new_spm / r.sloop_slots   (or 1.0 if no slots)
      For every output item of k, the coefficient of q[k] changes in:
        - each non-resource net constraint   (coeff = new_out - input)
        - each resource capacity constraint  (coeff = input  - new_out)
        - the objective expression           (coeff = obj_weight * new_out)
      All other variables and constraints are untouched.
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
        self._net_coeff = net_coeff   # kept for patch_spm

        # Pass 1: flow constraints (non-resource items): net(item) >= 0.
        # All items — including unavoidable byproducts — are allowed to be surplus.
        # Gratuitous resource use is suppressed by the epsilon penalty on the objective.
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

        # Epsilon penalty on resource consumption — same logic as _build_lp.
        # Rewards the solver for leaving slack resources idle rather than routing
        # them through unneeded recipes when it makes no difference to the objective.
        # ε is small enough to never alter which solution is truly optimal.
        _EPS = 1e-7
        for item in scenario.available_resources:
            for i, k in enumerate(rkeys):
                c = net_coeff[k].get(item, 0.0)
                if c:
                    # c = eff_out - inputs; resource penalty = +ε * c (reward not consuming)
                    obj.SetCoefficient(q[i], obj.GetCoefficient(q[i]) + _EPS * c)

    def solve(self) -> Tuple[str, float, Dict[str, float]]:
        status = self.slvr.Solve()
        ok = status in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE)
        if not ok:
            return "Infeasible", 0.0, {}
        q_vals = {self.rkeys[i]: max(0.0, self.q[i].solution_value())
                  for i in range(len(self.rkeys))}
        return "Optimal", self.slvr.Objective().Value(), q_vals

    def patch_spm(self, k: str, new_spm_val: int) -> None:
        """
        Update LP coefficients for recipe k to reflect new_spm_val sloops/machine.
        Only touches rows/columns affected by k's output change.
        O(outputs(k)) — independent of LP size.
        """
        r    = self.usable[k]
        i    = self.ridx[k]
        qi   = self.q[i]

        old_mult = _output_mult(r, self.spm.get(k, 0))
        new_mult = _output_mult(r, new_spm_val)

        if old_mult == new_mult:
            return   # no-op if sloop_slots == 0

        obj = self.slvr.Objective()

        for item, base_rate in r.outputs.items():
            delta = base_rate * (new_mult - old_mult)

            # flow constraint: net(item) >= 0  →  +delta on output term
            if item in self.flow_ct:
                ct = self.flow_ct[item]
                ct.SetCoefficient(qi, ct.GetCoefficient(qi) + delta)

            # resource capacity: cons - prod <= supply  →  -delta on output term
            if item in self.res_ct:
                ct = self.res_ct[item]
                ct.SetCoefficient(qi, ct.GetCoefficient(qi) - delta)

            # must/min/max produce express net(item)  →  +delta
            for ct_dict in (self.must_ct, self.min_ct, self.max_ct):
                if item in ct_dict:
                    ct = ct_dict[item]
                    ct.SetCoefficient(qi, ct.GetCoefficient(qi) + delta)

            # objective
            if item in self._obj_weights:
                w = self._obj_weights[item]
                obj.SetCoefficient(qi, obj.GetCoefficient(qi) + w * delta)

            # epsilon penalty on resource consumption: reward = +ε × net_coeff.
            # When eff_out changes, net_coeff for this (recipe, item) pair changes
            # too, so the epsilon term must be refreshed here.
            if item in self.scenario.available_resources:
                _EPS = 1e-7
                old_nc = self._net_coeff[k].get(item, 0.0)
                new_nc = old_nc + delta   # eff_out increased by delta; inputs unchanged
                obj.SetCoefficient(qi, obj.GetCoefficient(qi) + _EPS * (new_nc - old_nc))

        # Update tracking state
        self.spm[k] = new_spm_val
        self.eff_out[k] = {item: rate * new_mult for item, rate in r.outputs.items()}
        # Rebuild net_coeff for k so _add_produce_ct and future patches stay accurate
        nc: Dict[str, float] = {}
        for item, rate in self.eff_out[k].items():
            c = rate - r.inputs.get(item, 0.0)
            if c:
                nc[item] = c
        for item, rate in r.inputs.items():
            if item not in nc and rate:
                nc[item] = -rate
        self._net_coeff[k] = nc


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


# ── Power computation ─────────────────────────────────────────────────────────
def _total_power(
    usable: Dict[str,Recipe],
    q_vals: Dict[str,float],
    spm: Dict[str,int],
    clock_fracs: Dict[str,float],   # clock fraction per recipe (1.0 if absent)
) -> float:
    """P = sum over active recipes of: base_mw × clock^1.6 × n_machines × sloop_power_mult"""
    total = 0.0
    for k, r in usable.items():
        qv = q_vals.get(k, 0.0)
        if qv < 1e-5:
            continue
        clk = clock_fracs.get(k, 1.0)
        n   = max(1, math.ceil(qv / clk))
        total += r.base_power_mw * (clk ** POWER_EXP) * n * _sloop_power_mult(r, spm.get(k, 0))
    return total


# ── Iterative sloop allocation ────────────────────────────────────────────────
def _trial_sloop(
    k: str,
    get_warm,
    best_q: Dict[str,float],
    best_obj: float,
    budget: int,
) -> Optional[Tuple[str, float, float, Dict[str,float], int]]:
    """
    Worker: evaluate adding one sloop slot to recipe k.
    Calls get_warm() to obtain this thread's WarmLP (thread-safe: each thread
    owns its own WarmLP instance, never shared across threads).
    Patches the single recipe coefficient, solves, then un-patches so the
    WarmLP can be reused for the next candidate in the same thread.
    Returns (k, gain, obj_val, q_vals, cost) if viable, else None.
    """
    warm = get_warm()
    r   = warm.usable[k]
    cur = warm.spm.get(k, 0)
    if cur >= r.sloop_slots:
        return None

    n_machines = max(1, math.ceil(best_q.get(k, 0.0)))
    cost = n_machines
    if cost > budget:
        return None

    # Patch → solve → un-patch (keeps the WarmLP state clean for other workers)
    warm.patch_spm(k, cur + 1)
    status, obj_val, q_vals = warm.solve()
    warm.patch_spm(k, cur)

    if status != "Optimal":
        return None

    # Power-cap check with trial spm
    trial_spm = dict(warm.spm)
    trial_spm[k] = cur + 1
    if warm.scenario.max_power_mw is not None:
        pw = _total_power(warm.usable, q_vals, trial_spm, {})
        if pw > warm.scenario.max_power_mw:
            return None

    gain = obj_val - best_obj
    return (k, gain, obj_val, q_vals, cost)


def _iterate_sloops(
    scenario: Scenario,
    usable: Dict[str,Recipe],
    base_q: Dict[str,float],
    base_obj: float,
) -> Tuple[Dict[str,int], Dict[str,float], float]:
    """
    Greedy iterative sloop assignment.

    spm[k] = sloops per machine (0..max_slots). Starts at 0 for every recipe.
    Each round: all eligible candidates evaluated in parallel; the winner
    (highest objective gain that also satisfies the power cap) is committed.

    Thread model: a single long-lived ThreadPoolExecutor is reused across all
    rounds to avoid repeated thread-lifecycle overhead. Each thread owns one
    WarmLP (created lazily via threading.local). The spm sync at the start of
    _get_warm() keeps thread-local LPs aligned with the committed spm after
    each round.

    Budget cost = ceil(q[k]) sloops (one physical sloop per machine).
    """
    if scenario.somersloops_available == 0:
        return {}, base_q, base_obj

    spm: Dict[str,int]   = {k: 0 for k in usable}
    best_q   = dict(base_q)
    budget   = scenario.somersloops_available
    candidates = [k for k, r in usable.items() if r.sloop_slots > 0]

    # Thread-local WarmLP pool — concurrent patch/solve/un-patch never conflict.
    _tl = threading.local()

    def _get_warm() -> WarmLP:
        """Return (or lazily create) this thread's WarmLP, synced to current spm."""
        warm = getattr(_tl, "warm", None)
        if warm is None:
            _tl.warm = WarmLP(scenario, usable, spm)
        else:
            for k2, v2 in spm.items():
                if warm.spm.get(k2, 0) != v2:
                    warm.patch_spm(k2, v2)
        return _tl.warm

    # Seed best_obj from a WarmLP solve so all gain comparisons use the same
    # objective scale (WarmLP omits the supply constant that _solve_lp includes).
    _seed = WarmLP(scenario, usable, spm)
    _, best_obj, _ = _seed.solve()

    n_workers = min(len(candidates), 8)
    with ThreadPoolExecutor(max_workers=n_workers) as ex:
        while budget > 0:
            eligible = [
                k for k in candidates
                if spm[k] < usable[k].sloop_slots
                and best_q.get(k, 0.0) > 1e-3
                and max(1, math.ceil(best_q.get(k, 0.0))) <= budget
            ]
            if not eligible:
                break

            futs = {ex.submit(_trial_sloop, k, _get_warm, best_q, best_obj, budget): k
                    for k in eligible}
            results = [fut.result() for fut in as_completed(futs)
                       if fut.result() is not None]

            if not results:
                break

            # Sort winners by gain descending, then greedily commit all whose
            # resource footprints don't overlap with already-committed recipes
            # in this round.  Recipes with disjoint resource footprints can be
            # committed together without re-solving because their LP effects are
            # independent — this can halve the number of outer rounds.
            results.sort(key=lambda r: r[1], reverse=True)

            committed_items: Set[str] = set()
            committed_any = False
            for cand_k, gain, obj_val, new_q, cost in results:
                if gain <= 0:
                    break
                # A recipe conflicts if any of its inputs or outputs were
                # touched by a recipe already committed this round.
                footprint = (set(usable[cand_k].inputs.keys())
                             | set(usable[cand_k].outputs.keys()))
                if footprint & committed_items:
                    continue  # skip — would need a re-solve to be safe
                if cost > budget:
                    continue
                spm[cand_k] += 1
                budget      -= cost
                committed_items |= footprint
                committed_any = True
                # Use the q_vals and obj from the best winner only; the others
                # are single-recipe trials so best_q/best_obj are re-synced at
                # the top of _get_warm() each round regardless.
                best_q   = new_q
                best_obj = obj_val

            if not committed_any:
                break

    return spm, best_q, best_obj


# ── Shard allocation ──────────────────────────────────────────────────────────
def _best_mixed_layout(
    r: Recipe,
    qv: float,
    spm_val: int,
    shards_budget: int,
    max_power_mw: Optional[float],
) -> Tuple[int, float, int, float]:
    """
    Find the minimum-shard layout for throughput qv that keeps total machines
    at ceil(qv).  Uses a mixed layout: `hi` machines run overclocked at
    clk_hi, the rest run at 100%.

    For q = 3.11 with no power constraint this yields:
      1 machine × 111%  (1 shard)  +  2 machines × 100%  (0 shards) → 1 shard total
    rather than the all-or-nothing Option B:
      3 machines × 103.7% (3 shards total).

    When no_power_constraint (max_power_mw is None), prefers fewest shards.
    When power-constrained, falls back to all-or-nothing Option B so the full
    machine-save is realised (fewer machines = less power).

    Returns (machines_total, clock_pct_of_overclocked, shards_total, power_mw).
    The caller interprets clock_pct as the speed of the `hi` machines; the
    remaining machines run at 100%.  When hi == 0 the layout is pure 100%.
    """
    sloop_pw = _sloop_power_mult(r, spm_val)
    ceil_n   = math.ceil(qv)
    floor_n  = max(1, math.floor(qv))

    # Baseline: all ceil_n machines at fractional clock (no shards needed)
    clk_a  = qv / ceil_n
    pw_a   = r.base_power_mw * (clk_a ** POWER_EXP) * ceil_n * sloop_pw

    # No fractional part → nothing to do
    if floor_n == ceil_n:
        return ceil_n, clk_a * 100.0, 0, pw_a

    frac = qv - floor_n  # machines worth of extra throughput needed (0 < frac < 1)

    # --- Power-unconstrained path: mixed layout (minimum shards) ---
    # We keep ceil_n machines total.  One subset of `hi` machines runs at clk_hi
    # so that  hi * clk_hi + (ceil_n - hi) * 1.0 == qv
    #   →  hi = frac / (clk_hi - 1)
    # We scan hi = 1, 2, … floor_n to find the smallest hi whose clk_hi is
    # reachable (≤ MAX_CLOCK) and whose shard cost fits the budget.
    if max_power_mw is None:
        best: Optional[Tuple[int, float, int, float]] = None
        for hi in range(1, floor_n + 1):
            # hi overclocked machines must cover `frac` extra throughput each
            clk_hi = 1.0 + frac / hi
            if clk_hi > MAX_CLOCK:
                continue
            shards_pm  = min(3, max(0, math.ceil((clk_hi - 1.0) / SHARD_BOOST)))
            shards_tot = shards_pm * hi
            if shards_tot > shards_budget:
                continue
            # Power: hi machines at clk_hi + (ceil_n - hi) at 1.0
            pw = (r.base_power_mw * sloop_pw * (
                hi * (clk_hi ** POWER_EXP) + (ceil_n - hi) * 1.0
            ))
            if best is None or shards_tot < best[2]:
                best = (ceil_n, clk_hi * 100.0, shards_tot, pw)
            if shards_tot == 0:
                break  # can't do better

        if best is not None:
            return best

    # --- Power-constrained path (or mixed layout failed): all-or-nothing Option B ---
    # Reduce total machines to floor_n so power drops; accept higher shard cost.
    clk_b      = qv / floor_n
    if clk_b <= MAX_CLOCK:
        shards_pm  = min(3, max(0, math.ceil((clk_b - 1.0) / SHARD_BOOST)))
        shards_tot = shards_pm * floor_n
        pw_b = r.base_power_mw * (clk_b ** POWER_EXP) * floor_n * sloop_pw
        if shards_tot <= shards_budget and (max_power_mw is None or pw_b <= max_power_mw):
            return floor_n, clk_b * 100.0, shards_tot, pw_b

    # Fall back to no-shard baseline
    return ceil_n, clk_a * 100.0, 0, pw_a


def _allocate_shards(
    usable: Dict[str,Recipe],
    q_vals: Dict[str,float],
    spm: Dict[str,int],
    shards_available: int,
    max_power_mw: Optional[float],
) -> Dict[str, dict]:
    """
    Greedy shard allocation using mixed layouts.

    For each recipe, the best layout is the one that uses the fewest shards
    while keeping machines at ceil(q) when there is no power cap.  Under a
    power cap the all-or-nothing floor(q) layout is preferred because fewer
    machines = less power.

    Recipes are sorted by shard cost of their best layout ascending so the
    budget is spent on the cheapest machine-equivalent savings first.

    Returns {key: {machines, clock_pct, shards, power_mw, hi_machines}}.
    `hi_machines` is the count of machines running at clock_pct; the rest run
    at 100%.  When hi_machines == machines all run at clock_pct (uniform).
    """
    result: Dict[str, dict] = {}
    shards_left = shards_available

    def _best_cost(k: str) -> int:
        """Shard cost of the best mixed layout for sorting."""
        qv = q_vals[k]
        if math.ceil(qv) == max(1, math.floor(qv)):
            return 0
        _, _, cost, _ = _best_mixed_layout(
            usable[k], qv, spm.get(k, 0), shards_left, max_power_mw
        )
        return cost

    sorted_keys = sorted(
        (k for k in usable if q_vals.get(k, 0.0) >= 1e-5),
        key=_best_cost,
    )

    for k in sorted_keys:
        r  = usable[k]
        qv = q_vals[k]
        sloop_pw = _sloop_power_mult(r, spm.get(k, 0))

        ceil_n  = math.ceil(qv)
        floor_n = max(1, math.floor(qv))

        # Baseline Option A (no shards)
        clk_a = qv / ceil_n
        pw_a  = r.base_power_mw * (clk_a ** POWER_EXP) * ceil_n * sloop_pw
        chosen = {"machines": ceil_n, "clock_pct": clk_a * 100,
                  "shards": 0, "power_mw": pw_a, "hi_machines": 0}

        if floor_n < ceil_n and shards_left > 0:
            n, clk_pct, shards_tot, pw = _best_mixed_layout(
                r, qv, spm.get(k, 0), shards_left, max_power_mw
            )
            if shards_tot > 0 and shards_tot <= shards_left:
                # hi_machines = how many run at clk_pct; rest at 100%
                frac   = qv - floor_n
                clk_hi = clk_pct / 100.0
                hi     = round(frac / (clk_hi - 1.0)) if clk_hi > 1.0 + 1e-9 else n
                chosen = {"machines": n, "clock_pct": clk_pct,
                          "shards": shards_tot, "power_mw": pw,
                          "hi_machines": hi}

        result[k] = chosen
        shards_left = max(0, shards_left - chosen["shards"])

    return result


# ── Layout options ────────────────────────────────────────────────────────────
def _layout_options(r: Recipe, qv: float, s: int) -> List[LayoutOption]:
    """
    Return the 1–3 practical clock layouts for this recipe at throughput qv.

    Option A  — ceil machines, all underclocked (no shards).
    Option B  — mixed layout: minimum shards, ceil machines total (power-unconstrained).
    Option C  — all-or-nothing: floor machines, all overclocked (fewer machines,
                more shards, less power).  Shown only when it differs from Option B.
    """
    sloop_pw = _sloop_power_mult(r, s)
    ceil_n   = math.ceil(qv)
    floor_n  = max(1, math.floor(qv))

    clk_a = qv / ceil_n
    pw_a  = r.base_power_mw * (clk_a ** POWER_EXP) * ceil_n * sloop_pw
    opts  = [LayoutOption(ceil_n, round(clk_a * 100, 1), 0, round(pw_a, 2),
                          f"{ceil_n} × {clk_a*100:.1f}%")]

    if floor_n < ceil_n:
        # Option B: mixed layout (minimum shards, ceil_n machines)
        frac = qv - floor_n
        for hi in range(1, floor_n + 1):
            clk_hi = 1.0 + frac / hi
            if clk_hi > MAX_CLOCK:
                continue
            shards_pm  = min(3, max(0, math.ceil((clk_hi - 1.0) / SHARD_BOOST)))
            shards_tot = shards_pm * hi
            pw_b = r.base_power_mw * sloop_pw * (
                hi * (clk_hi ** POWER_EXP) + (ceil_n - hi) * 1.0
            )
            rest = ceil_n - hi
            if rest > 0:
                label = (f"{hi} × {clk_hi*100:.1f}%  ({shards_pm} shard/machine)"
                         f" + {rest} × 100%")
            else:
                label = f"{hi} × {clk_hi*100:.1f}%  ({shards_pm} shard/machine)"
            opts.append(LayoutOption(ceil_n, round(clk_hi * 100, 1),
                                     shards_tot, round(pw_b, 2), label))
            break  # take smallest-hi (fewest shards)

        # Option C: all-or-nothing floor_n machines (only if different from Option B)
        clk_c = qv / floor_n
        if clk_c <= MAX_CLOCK:
            shards_pm_c = min(3, max(0, math.ceil((clk_c - 1.0) / SHARD_BOOST)))
            pw_c = r.base_power_mw * (clk_c ** POWER_EXP) * floor_n * sloop_pw
            shards_c = shards_pm_c * floor_n
            # Only add if it actually differs from Option B already appended
            if not any(abs(o.shards_needed - shards_c) < 1e-9
                       and o.machines == floor_n for o in opts):
                opts.append(LayoutOption(
                    floor_n, round(clk_c * 100, 1), shards_c, round(pw_c, 2),
                    f"{floor_n} × {clk_c*100:.1f}%  ({shards_pm_c} shard/machine) — fewer machines",
                ))
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

    # Stage 1: base LP (no sloops); duals computed lazily via compute_duals()
    #
    # max_machines fix: the LP constraint bounds the *fractional* sum of q values,
    # but the final machine count uses ceil(q) per recipe.  A solution with
    # sum(q) <= max_machines can still produce sum(ceil(q)) > max_machines after
    # rounding.  We tighten the effective LP bound iteratively until the ceiled
    # total fits within the cap.
    #
    # If the cap is set below the true minimum, tightening makes the LP infeasible
    # before the ceiled total ever fits.  In that case we fall back to
    # _solve_lp_min_machines, which minimises sum(q) directly — giving the
    # factory layout with the fewest possible machines regardless of the cap.
    if usable:
        lp_machine_bound = scenario.max_machines  # None means unconstrained
        fell_back = False
        for _mm_attempt in range(10):             # at most 10 tightening steps
            sc_lp = (_dc_replace(scenario, max_machines=lp_machine_bound)
                     if lp_machine_bound is not None else scenario)
            status, base_obj, base_q = _solve_lp(sc_lp, usable, {})
            if scenario.max_machines is None:
                break                             # no cap — single solve, done
            if status != "Optimal":
                # LP became infeasible: cap is below the true minimum.
                # Find the minimum-machine solution instead.
                status, base_obj, base_q = _solve_lp_min_machines(scenario, usable, {})
                fell_back = True
                break
            ceiled_total = sum(math.ceil(v) for v in base_q.values() if v >= 1e-5)
            if ceiled_total <= scenario.max_machines:
                break
            # Tighten: reduce bound by the overshoot so the next LP leaves
            # enough headroom for ceiling rounding.
            overshoot = ceiled_total - scenario.max_machines
            lp_machine_bound -= overshoot
            if lp_machine_bound < 1:
                # Bound hit zero — cap is definitely below the true minimum.
                status, base_obj, base_q = _solve_lp_min_machines(scenario, usable, {})
                fell_back = True
                break
        if fell_back and scenario.max_machines is not None:
            actual = sum(math.ceil(v) for v in base_q.values() if v >= 1e-5)
            warnings.append(
                f"max_machines cap ({scenario.max_machines}) is below the "
                f"minimum required ({actual}); showing minimum machine layout."
            )
    else:
        status, base_obj, base_q = "Infeasible", 0.0, {}

    shadow_prices:     Dict[str,float]  = {}
    saturation_points: Dict[str,object] = {}

    # Stage 2: iterative sloop assignment (re-solves LP each step, same pruned set)
    if status == "Optimal" and scenario.somersloops_available > 0:
        spm, q_vals, obj_val = _iterate_sloops(scenario, usable, base_q, base_obj)
    else:
        spm, q_vals, obj_val = {}, base_q, base_obj

    # Stage 3: shard allocation
    shard_alloc = _allocate_shards(
        usable, q_vals, spm,
        scenario.power_shards_available, scenario.max_power_mw,
    )

    # Build flows — single pass over active recipes
    meta = machine_meta if machine_meta is not None else load_machine_meta()
    flows:             List[FlowResult] = []
    total_power        = 0.0
    total_machines_int = 0
    total_shards       = 0
    total_sloops       = 0

    for k, r in usable.items():
        qv = q_vals.get(k, 0.0)
        if qv < 1e-5:
            continue

        sa             = shard_alloc.get(k, {})
        machines_final = sa.get("machines", math.ceil(qv))
        clock_pct      = sa.get("clock_pct", 100.0)
        shards_this    = sa.get("shards", 0)

        spm_k        = spm.get(k, 0)
        sloops_total = spm_k * machines_final

        mult      = _output_mult(r, spm_k)
        clk       = clock_pct / 100.0
        sloop_pw  = _sloop_power_mult(r, spm_k)
        hi_n      = sa.get("hi_machines", 0)
        # Mixed layout: hi_n machines at clk, (machines_final - hi_n) at 100%.
        # When hi_n == 0 (no shards / uniform layout) all machines run at clk.
        if hi_n > 0 and hi_n < machines_final:
            lo_n = machines_final - hi_n
            pw = r.base_power_mw * sloop_pw * (
                hi_n * (clk ** POWER_EXP) + lo_n * 1.0
            )
        else:
            pw = r.base_power_mw * (clk ** POWER_EXP) * machines_final * sloop_pw

        total_power        += pw
        total_machines_int += machines_final
        total_shards       += shards_this
        total_sloops       += sloops_total

        # qv is the LP's normalised throughput with sloop multiplier already
        # baked into the constraint coefficients via eff_out.  The per-unit
        # base rate × qv therefore gives the correct physical output; there
        # is no need to multiply by mult again.
        eff_rate = qv   # LP throughput; sloop boost already embedded

        flows.append(FlowResult(
            recipe_key=k, display=r.display, machine=r.machine,
            machines_float=round(qv, 4),
            machines_final=machines_final,
            clock_pct=round(clock_pct, 1),
            shards_used=shards_this,
            sloops_per_machine=spm_k,
            sloops_used=sloops_total,
            sloop_slots=r.sloop_slots,
            output_multiplier=round(mult, 4),
            power_mw=round(pw, 2),
            inputs={item: round(r.inputs[item] * qv, 4) for item in r.inputs},
            outputs={item: round(r.outputs[item] * eff_rate, 4) for item in r.outputs},
            layout_options=_layout_options(r, qv, spm_k),
            has_shard=shards_this > 0,
            has_sloop=spm_k > 0,
            hi_machines=hi_n,
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
