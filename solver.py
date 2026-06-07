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

import math, yaml, json
from pathlib import Path
from dataclasses import dataclass, field
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


# ── Loaders ───────────────────────────────────────────────────────────────────
def _si(v, d=0):
    try: return int(v) if v is not None else d
    except: return d

def _sf(v, d=0.0):
    try: return float(v) if v is not None else d
    except: return d

def load_recipes(path=RECIPES_PATH) -> Dict[str,Recipe]:
    with open(path) as f: raw = yaml.safe_load(f)
    meta = raw.get("machine_meta", {})
    out = {}
    for key, d in raw["recipes"].items():
        machine = d["machine"]
        m = meta.get(machine, {})
        out[key] = Recipe(
            key=key, display=d.get("display", key), machine=machine,
            alternate=d.get("alternate", False),
            inputs={k: float(v) for k,v in d.get("inputs", {}).items()},
            outputs={k: float(v) for k,v in d.get("outputs", {}).items()},
            base_power_mw=float(m.get("base_power_mw", 10.0)),
            sloop_slots=int(SLOOP_SLOTS_BY_MACHINE.get(machine, 0)),
        )
    return out

def load_machine_meta(path=RECIPES_PATH) -> Dict:
    with open(path) as f: raw = yaml.safe_load(f)
    return raw.get("machine_meta", {})

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
    items = set()
    for r in recipes.values():
        items.update(r.inputs.keys()); items.update(r.outputs.keys())
    return sorted(items)


# ── Pruning — forward grounding + backward demand ─────────────────────────────
def prune_recipes(
    scenario: Scenario,
    all_recipes: Dict[str,Recipe],
) -> Tuple[Dict[str,Recipe], Dict[str,List[str]]]:
    """
    Phase 1: Forward topological grounding (eliminates cycles).
    Phase 2: Backward demand from objectives through fireable recipes.
    Phase 3: Unsatisfiable detection for error nodes.
    Pruned set is reused for all LP solves in the iterative loop.
    """
    available_raw = set(scenario.available_resources.keys())
    target_items = (set(scenario.objective.keys()) | set(scenario.must_produce.keys())
                  | set(scenario.min_produce.keys()) | set(scenario.max_produce.keys()))

    def is_allowed(key, r):
        if scenario.enabled_machines and r.machine not in scenario.enabled_machines:
            return False
        if r.alternate and key not in scenario.alternate_recipes_enabled:
            return False
        return True

    allowed = {k: r for k,r in all_recipes.items() if is_allowed(k, r)}

    # Phase 1: forward grounding
    grounded: Set[str] = set(available_raw)
    fireable: Set[str] = set()
    changed = True
    while changed:
        changed = False
        for key, r in allowed.items():
            if key in fireable: continue
            if all(inp in grounded for inp in r.inputs):
                fireable.add(key)
                new = set(r.outputs.keys()) - grounded
                if new:
                    grounded.update(new)
                    changed = True

    # Phase 2: backward demand through fireable only
    allowed_producers: Dict[str,List[str]] = {}
    for key in fireable:
        for item in allowed[key].outputs:
            allowed_producers.setdefault(item, []).append(key)

    needed: Set[str] = set()
    visited: Set[str] = set(available_raw)
    queue = list(target_items)
    while queue:
        item = queue.pop()
        if item in visited: continue
        visited.add(item)
        for rkey in allowed_producers.get(item, []):
            needed.add(rkey)
            for inp in allowed[rkey].inputs:
                if inp not in visited: queue.append(inp)

    usable = {k: allowed[k] for k in needed}

    # Phase 3: unsatisfiable detection
    all_prod: Dict[str,List[str]] = {}
    for key, r in all_recipes.items():
        for item in r.outputs:
            all_prod.setdefault(item, []).append(key)

    unsatisfiable: Dict[str,List[str]] = {}
    for item in target_items:
        if item in grounded: continue
        reasons = []
        for rkey in all_prod.get(item, []):
            r = all_recipes[rkey]
            if scenario.enabled_machines and r.machine not in scenario.enabled_machines:
                reasons.append(f"requires {r.machine} (not enabled)")
            elif r.alternate and rkey not in scenario.alternate_recipes_enabled:
                reasons.append(f"requires alternate '{r.display}' (not enabled)")
            else:
                missing = [inp for inp in r.inputs if inp not in grounded]
                if missing:
                    reasons.append(f"inputs unavailable: {', '.join(missing[:3])}")
        if not reasons:
            reasons = ["no recipe exists for this item"]
        unsatisfiable[item] = list(dict.fromkeys(reasons))

    return usable, unsatisfiable


# ── LP with sloop multipliers baked in ───────────────────────────────────────
def _build_lp(
    scenario: Scenario,
    usable: Dict[str,Recipe],
    spm: Dict[str,int],
) -> Tuple[object, list, dict, dict, dict]:
    """
    Build the GLOP LP and return (solver, q_vars, net_expr, resource_constraints, item_set).
    Separated from solving so callers can extract duals after solving.
    """
    rkeys = list(usable.keys())
    n     = len(rkeys)

    eff_out = {}
    for k in rkeys:
        r = usable[k]; s = spm.get(k, 0)
        mult = 1.0 + (s / r.sloop_slots) if r.sloop_slots > 0 else 1.0
        eff_out[k] = {item: rate * mult for item, rate in r.outputs.items()}

    item_set = set(scenario.available_resources.keys())
    for k in rkeys:
        item_set.update(usable[k].inputs.keys())
        item_set.update(eff_out[k].keys())
    items = list(item_set)

    slvr = pywraplp.Solver.CreateSolver("GLOP")
    slvr.SuppressOutput()
    INF = slvr.infinity()
    q   = [slvr.NumVar(0, INF, f"q{i}") for i in range(n)]

    def net(item):
        supply = scenario.available_resources.get(item, 0.0)
        prod   = slvr.Sum([q[i] * eff_out[rkeys[i]].get(item, 0.0) for i in range(n)])
        cons   = slvr.Sum([q[i] * usable[rkeys[i]].inputs.get(item, 0.0) for i in range(n)])
        return prod - cons + supply

    net_expr = {item: net(item) for item in items}

    for item in items:
        if item not in scenario.available_resources:
            slvr.Add(net_expr[item] >= 0.0)

    # Resource capacity constraints — kept separately so we can read their duals
    res_constraints: Dict[str, object] = {}
    for item, supply in scenario.available_resources.items():
        cons = slvr.Sum([q[i] * usable[rkeys[i]].inputs.get(item, 0.0) for i in range(n)])
        prod = slvr.Sum([q[i] * eff_out[rkeys[i]].get(item, 0.0) for i in range(n)])
        ct   = slvr.Add(cons - prod <= supply)
        res_constraints[item] = ct

    for item, qty in scenario.must_produce.items():
        if item in net_expr: slvr.Add(net_expr[item] == qty)
    for item, qty in scenario.min_produce.items():
        if item in net_expr: slvr.Add(net_expr[item] >= qty)
    for item, qty in scenario.max_produce.items():
        if item in net_expr: slvr.Add(net_expr[item] <= qty)

    if scenario.max_machines is not None:
        slvr.Add(slvr.Sum(q) <= float(scenario.max_machines))

    obj_in = [item for item in scenario.objective if item in net_expr]
    slvr.Maximize(slvr.Sum([scenario.objective[item] * net_expr[item] for item in obj_in]))

    return slvr, q, rkeys, net_expr, res_constraints


def _solve_lp(
    scenario: Scenario,
    usable: Dict[str,Recipe],
    spm: Dict[str,int],
) -> Tuple[str, float, Dict[str,float]]:
    """Standard solve — returns status, objective, q_values."""
    if not usable: return "No recipes", 0.0, {}
    slvr, q, rkeys, _, _ = _build_lp(scenario, usable, spm)
    status = slvr.Solve()
    ok = status in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE)
    if not ok: return "Infeasible", 0.0, {}
    q_vals = {rkeys[i]: max(0.0, q[i].solution_value()) for i in range(len(rkeys))}
    return "Optimal", slvr.Objective().Value(), q_vals


def _solve_lp_with_duals(
    scenario: Scenario,
    usable: Dict[str,Recipe],
    spm: Dict[str,int],
) -> Tuple[str, float, Dict[str,float], Dict[str,float], Dict[str,Optional[float]]]:
    """
    Solve LP and extract shadow prices + saturation points for resource constraints.

    Shadow price of resource R = how much the objective improves per additional
    unit/min of R, at the current supply level.  This is the LP dual value.

    GLOP dual_value() for a <= constraint in a maximisation problem returns a
    NON-NEGATIVE value when the constraint is binding (the shadow price IS the
    raw dual — no negation needed).  A value of 0 means the resource has slack.

    Saturation point: the supply level at which the shadow price drops to zero
    (i.e. adding more of that resource stops helping).  Found by binary search.

    Returns (status, objective, q_vals, shadow_prices, saturation_points).
    saturation_points[item] = None if shadow price is already 0 (not binding),
                              or the supply level where it becomes 0.
    """
    if not usable: return "No recipes", 0.0, {}, {}, {}
    slvr, q, rkeys, _, res_constraints = _build_lp(scenario, usable, spm)
    status = slvr.Solve()
    ok = status in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE)
    if not ok: return "Infeasible", 0.0, {}, {}, {}

    q_vals = {rkeys[i]: max(0.0, q[i].solution_value()) for i in range(len(rkeys))}

    # Extract duals — raw dual_value() IS the shadow price (no negation)
    shadow: Dict[str,float] = {}
    for item, ct in res_constraints.items():
        try:
            shadow[item] = round(ct.dual_value(), 6)
        except Exception:
            shadow[item] = 0.0

    # Compute saturation point for each binding resource via binary search
    saturation: Dict[str, Optional[float]] = {}
    for item, sp in shadow.items():
        if sp < 0.001:
            saturation[item] = None  # already not binding
            continue
        # Binary search for the supply level where dual drops to ~0
        lo  = scenario.available_resources[item]
        hi  = lo * 20 + 5000   # generous upper bound
        for _ in range(28):    # 28 iterations → precision < 0.0001
            mid = (lo + hi) / 2
            res2 = dict(scenario.available_resources)
            res2[item] = mid
            sc2  = Scenario(
                name=scenario.name, description='',
                alternate_recipes_enabled=scenario.alternate_recipes_enabled,
                enabled_machines=scenario.enabled_machines,
                available_resources=res2,
                must_produce=scenario.must_produce,
                min_produce=scenario.min_produce,
                max_produce=scenario.max_produce,
                objective=scenario.objective,
                power_shards_available=scenario.power_shards_available,
                somersloops_available=scenario.somersloops_available,
                max_power_mw=scenario.max_power_mw,
                max_machines=scenario.max_machines,
                notes='',
            )
            slvr2, _, _, _, res_ct2 = _build_lp(sc2, usable, spm)
            slvr2.Solve()
            try:
                dual_mid = res_ct2[item].dual_value()
            except Exception:
                dual_mid = 0.0
            if dual_mid < 0.001:
                hi = mid
            else:
                lo = mid
        saturation[item] = round(hi, 1)

    return "Optimal", slvr.Objective().Value(), q_vals, shadow, saturation


# ── Power computation ─────────────────────────────────────────────────────────
def _total_power(
    usable: Dict[str,Recipe],
    q_vals: Dict[str,float],
    spm: Dict[str,int],           # sloops_per_machine
    clock_fracs: Dict[str,float], # clock fraction per recipe (default 1.0)
) -> float:
    """P = sum(base_mw × clock^1.6 × n_machines × (1 + spm/max_slots)^2)"""
    total = 0.0
    for k, r in usable.items():
        qv = q_vals.get(k, 0.0)
        if qv < 1e-5: continue
        clk = clock_fracs.get(k, 1.0)
        n   = max(1, math.ceil(qv / clk))
        s   = spm.get(k, 0)
        mult = 1.0 + (s / r.sloop_slots) if r.sloop_slots > 0 else 1.0
        total += r.base_power_mw * (clk ** POWER_EXP) * n * (mult ** 2)
    return total


# ── Iterative sloop allocation ────────────────────────────────────────────────
def _iterate_sloops(
    scenario: Scenario,
    usable: Dict[str,Recipe],
    base_q: Dict[str,float],
    base_obj: float,
) -> Tuple[Dict[str,int], Dict[str,float], float]:
    """
    spm[k] = sloops per machine (0..max_slots). Starts at 0.
    Each iteration: try incrementing spm[k] by 1 for each eligible recipe.
    Budget cost = ceil(q[k]) sloops (one per physical machine).
    Accept if objective improves and power stays within cap.
    Re-solve LP each time so network rebalances without surplus.
    Pruned recipe set is fixed — only LP inputs change.
    """
    if scenario.somersloops_available == 0:
        return {}, base_q, base_obj

    spm: Dict[str,int] = {k: 0 for k in usable}
    best_q   = dict(base_q)
    best_obj = base_obj
    budget   = scenario.somersloops_available

    candidates = [k for k,r in usable.items() if r.sloop_slots > 0]

    while budget > 0:
        best_gain   = 0.0
        best_k      = None
        best_new_q  = None
        best_new_obj = None

        for k in candidates:
            r = usable[k]
            if spm[k] >= r.sloop_slots: continue  # maxed out

            # Cost: one more sloop on every physical machine of this recipe
            # Machine count estimated from current best_q
            n_machines = max(1, math.ceil(best_q.get(k, 0.0)))
            cost = n_machines  # sloops consumed

            if cost > budget: continue

            # Trial: increment spm[k] by 1
            trial_spm = dict(spm)
            trial_spm[k] = spm[k] + 1

            status, obj_val, q_vals = _solve_lp(scenario, usable, trial_spm)
            if status != "Optimal": continue

            # Power check at underclocked baseline (no shards applied yet)
            pw = _total_power(usable, q_vals, trial_spm, {})
            if scenario.max_power_mw is not None and pw > scenario.max_power_mw:
                continue

            gain = obj_val - best_obj
            if gain > best_gain or (best_k is None and gain >= -1e-6):
                best_gain    = gain
                best_k       = k
                best_new_q   = q_vals
                best_new_obj = obj_val
                best_cost    = cost

        if best_k is None or best_gain <= 0:
            break  # no objective-improving assignments remain

        spm[best_k] += 1
        best_q       = best_new_q
        best_obj     = best_new_obj
        budget      -= best_cost

    return spm, best_q, best_obj


# ── Shard allocation ──────────────────────────────────────────────────────────
def _allocate_shards(
    usable: Dict[str,Recipe],
    q_vals: Dict[str,float],
    spm: Dict[str,int],
    shards_available: int,
    max_power_mw: Optional[float],
) -> Dict[str, dict]:
    """
    Greedy: prefer floor(machines) overclocked over ceil(machines) underclocked.
    Returns {key: {machines, clock_pct, shards, power_mw}}.
    Power uses correct per-machine sloop formula.
    """
    result = {}
    shards_left = shards_available

    for k, r in usable.items():
        qv = q_vals.get(k, 0.0)
        if qv < 1e-5:
            result[k] = {"machines": 0, "clock_pct": 100.0, "shards": 0, "power_mw": 0.0}
            continue

        ceil_n  = math.ceil(qv)
        floor_n = max(1, math.floor(qv))
        s       = spm.get(k, 0)
        sloop_pw = (1.0 + s / r.sloop_slots)**2 if r.sloop_slots > 0 else 1.0

        # Option A: ceil machines underclocked
        clk_a = qv / ceil_n
        pw_a  = r.base_power_mw * (clk_a**POWER_EXP) * ceil_n * sloop_pw
        chosen = {"machines": ceil_n, "clock_pct": clk_a*100, "shards": 0, "power_mw": pw_a}

        if floor_n < ceil_n:
            clk_b = qv / floor_n
            if clk_b <= MAX_CLOCK:
                shards_pm  = min(3, max(0, math.ceil((clk_b - 1.0) / SHARD_BOOST)))
                shards_tot = shards_pm * floor_n
                pw_b = r.base_power_mw * (clk_b**POWER_EXP) * floor_n * sloop_pw

                if shards_tot <= shards_left:
                    if max_power_mw is None or pw_b <= max_power_mw:
                        chosen = {"machines": floor_n, "clock_pct": clk_b*100,
                                  "shards": shards_tot, "power_mw": pw_b}

        result[k] = chosen
        shards_left = max(0, shards_left - chosen["shards"])

    return result


# ── Layout options ────────────────────────────────────────────────────────────
def _layout_options(r: Recipe, qv: float, s: int) -> List[LayoutOption]:
    sloop_pw = (1.0 + s / r.sloop_slots)**2 if r.sloop_slots > 0 else 1.0
    opts = []
    ceil_n  = math.ceil(qv)
    floor_n = max(1, math.floor(qv))

    clk_a = qv / ceil_n
    pw_a  = r.base_power_mw * (clk_a**POWER_EXP) * ceil_n * sloop_pw
    opts.append(LayoutOption(ceil_n, round(clk_a*100,1), 0, round(pw_a,2),
                             f"{ceil_n} × {clk_a*100:.1f}%"))
    if floor_n < ceil_n:
        clk_b = qv / floor_n
        if clk_b <= MAX_CLOCK:
            shards_pm = min(3, max(0, math.ceil((clk_b-1.0)/SHARD_BOOST)))
            pw_b = r.base_power_mw * (clk_b**POWER_EXP) * floor_n * sloop_pw
            opts.append(LayoutOption(floor_n, round(clk_b*100,1), shards_pm*floor_n,
                                     round(pw_b,2),
                                     f"{floor_n} × {clk_b*100:.1f}%  ({shards_pm} shard/machine)"))
    return opts


# ── Main solve ────────────────────────────────────────────────────────────────
def solve(scenario: Scenario, all_recipes: Dict[str,Recipe]) -> SolveResult:
    warnings:       List[str] = []
    conflict_hints: List[str] = []
    cap_overshoot:  Dict[str,float] = {}

    # Prune once — reused for all LP solves
    usable, unsatisfiable = prune_recipes(scenario, all_recipes)
    pruned_count = len(usable)

    if not usable and not unsatisfiable:
        conflict_hints.append("No recipes reachable from your resources and objectives.")
        return SolveResult("No recipes", 0, [], {}, {}, {}, {}, {}, {}, {},
                          0, 0, 0, 0, warnings, conflict_hints, 0, {})

    # Stage 1: base LP (no sloops) — also extracts shadow prices + saturation points
    if usable:
        status, base_obj, base_q, shadow_prices, saturation_points = _solve_lp_with_duals(scenario, usable, {})
    else:
        status, base_obj, base_q, shadow_prices, saturation_points = "Infeasible", 0.0, {}, {}, {}

    # Stage 2: iterative sloop assignment (LP re-solved each step, same pruned set)
    if status == "Optimal" and scenario.somersloops_available > 0:
        spm, q_vals, obj_val = _iterate_sloops(scenario, usable, base_q, base_obj)
    else:
        spm, q_vals, obj_val = {}, base_q, base_obj

    # Stage 3: shard allocation
    shard_alloc = _allocate_shards(
        usable, q_vals, spm,
        scenario.power_shards_available, scenario.max_power_mw
    )

    # Build flows
    meta = load_machine_meta()
    flows: List[FlowResult] = []
    total_power        = 0.0
    total_machines_int = 0
    total_shards       = 0
    total_sloops       = 0

    for k, r in usable.items():
        qv = q_vals.get(k, 0.0)
        if qv < 1e-5: continue

        sa             = shard_alloc.get(k, {})
        machines_final = sa.get("machines", math.ceil(qv))
        clock_pct      = sa.get("clock_pct", 100.0)
        shards_this    = sa.get("shards", 0)

        spm_k     = spm.get(k, 0)   # sloops per machine
        sloops_total = spm_k * machines_final  # total physical sloops

        mult = 1.0 + (spm_k / r.sloop_slots) if r.sloop_slots > 0 else 1.0
        clk  = clock_pct / 100.0
        pw   = r.base_power_mw * (clk**POWER_EXP) * machines_final * (mult**2)

        total_power        += pw
        total_machines_int += machines_final
        total_shards       += shards_this
        total_sloops       += sloops_total

        eff_rate = qv * mult  # LP throughput × sloop multiplier

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
            inputs={item: round(r.inputs[item]*qv, 4) for item in r.inputs},
            outputs={item: round(r.outputs[item]*eff_rate, 4) for item in r.outputs},
            layout_options=_layout_options(r, qv, spm_k),
            has_shard=shards_this > 0,
            has_sloop=spm_k > 0,
        ))

    # Cap overshoot
    if scenario.max_machines is not None and total_machines_int > scenario.max_machines:
        cap_overshoot["machines_over"] = total_machines_int - scenario.max_machines
    if scenario.max_power_mw is not None and total_power > scenario.max_power_mw + 0.5:
        cap_overshoot["power_over"] = round(total_power - scenario.max_power_mw, 1)

    # Net items
    producible = set()
    for r in usable.values(): producible.update(r.outputs.keys())
    all_system = set(scenario.available_resources.keys()) | producible

    net_items: Dict[str,float] = {}
    for item in all_system:
        supply   = scenario.available_resources.get(item, 0.0)
        produced = sum(f.outputs.get(item, 0) for f in flows)
        consumed = sum(f.inputs.get(item, 0) for f in flows)
        net = supply + produced - consumed
        if abs(net) > 1e-4:
            net_items[item] = round(net, 4)

    source_nodes: Dict[str,float] = {}
    for item, supply in scenario.available_resources.items():
        if sum(f.inputs.get(item, 0) for f in flows) > 1e-5:
            source_nodes[item] = supply

    sink_nodes: Dict[str,float] = {}
    for item in list(scenario.objective.keys()) + list(scenario.must_produce.keys()):
        val = net_items.get(item, 0)
        if val > 1e-5:
            sink_nodes[item] = round(val, 4)

    wanted = (set(scenario.objective.keys()) | set(scenario.must_produce.keys())
            | set(scenario.min_produce.keys()) | set(scenario.available_resources.keys()))
    has_consumer = set()
    for r in usable.values(): has_consumer.update(r.inputs.keys())

    error_sinks:          Dict[str,float] = {}
    surplus_intermediates: Dict[str,float] = {}
    for item, net in net_items.items():
        if net > 1e-4 and item not in wanted:
            if item in has_consumer:
                surplus_intermediates[item] = net
            else:
                error_sinks[item] = net

    error_sources: Dict[str,float] = {}
    for item, reasons in unsatisfiable.items():
        qty = scenario.must_produce.get(item) or scenario.objective.get(item) or \
              scenario.min_produce.get(item, 1.0)
        error_sources[item] = float(qty)
        conflict_hints.append(f"'{item}' cannot be produced: {'; '.join(reasons)}")

    if status == "Optimal":
        for item, qty in scenario.must_produce.items():
            if item in net_items and item not in error_sources:
                actual = net_items.get(item, 0)
                if actual < qty - max(0.05, qty*0.01):
                    conflict_hints.append(
                        f"'{item}': needed {qty:.1f}/min, achieved {actual:.2f}/min"
                    )

    flows.sort(key=lambda f: (f.machine, f.display))

    final_status = ("Optimal" if status == "Optimal" and not error_sources
                    else "Optimal (with errors)" if status == "Optimal"
                    else "Infeasible")

    return SolveResult(
        status=final_status, objective_value=round(obj_val, 4),
        flows=flows, net_items=net_items,
        objective_items={item: round(net_items.get(item,0),4) for item in scenario.objective},
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
    )


def compute_build_cost(result: SolveResult, machine_meta: Dict) -> Dict[str,int]:
    machine_totals: Dict[str,float] = {}
    for f in result.flows:
        machine_totals[f.machine] = machine_totals.get(f.machine, 0) + f.machines_final
    total: Dict[str,int] = {}
    for machine, count in machine_totals.items():
        for item, qty in machine_meta.get(machine, {}).get("build_cost", {}).items():
            total[item] = total.get(item, 0) + qty * count
    return dict(sorted(total.items()))


def result_to_dict(result: SolveResult, scenario: Scenario, machine_meta: Dict) -> dict:
    def lo(o):
        if o is None: return None
        return {"machines":o.machines,"clock_pct":o.clock_pct,
                "shards_needed":o.shards_needed,"power_mw":o.power_mw,"label":o.label}
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
        } for f in result.flows],
    }


if __name__ == "__main__":
    import sys
    recipes = load_recipes(); meta = load_machine_meta()
    name = sys.argv[1] if len(sys.argv) > 1 else "iron_hub"
    path = SCENARIOS_DIR / f"{name}.yaml"
    if not path.exists():
        print(f"Not found. Available: {list_scenarios()}"); exit(1)
    s = load_scenario(path)
    result = solve(s, recipes)
    print(json.dumps(result_to_dict(result, s, meta), indent=2))
