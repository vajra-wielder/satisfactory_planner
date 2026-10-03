"""
Satisfactory Factory Planner — exact solver

PLAN (see _plan):
  One mixed-integer model of the whole factory — integer machines per recipe,
  a somersloop level per recipe, power shards per recipe, hard budgets for
  sloops and shards — solved in three lexicographic stages:
    1. Goal   maximise the weighted goals
    2. Lean   least raw resources, then least machine space — machines
              weighed by the room they take (or the reverse with machines_first)
    3. Clean  fewest recipes and duplicate producers
  Each stage is solved to proven optimality (MIP gap 1e-9) with earlier
  stages locked, so the result is the best plan, not a greedy approximation.

SLOOP ACCOUNTING:
  sloops per machine l ∈ 0..slots, output × (1 + l/slots), power × (1 + l/slots)²,
  sloops used = l × machines.

POWER FORMULA:
  P = base_mw × clock^log2(2.5) × (1 + sloops_per_machine / max_slots)^2, per machine.
  Power isn't minimised. max_power_mw is a hard cap the plan is built to
  fit, as close under it as it can get (see _power_bound and solve).

PRUNING:
  Recipe tree is computed once (forward grounding + backward demand).

ANALYSIS:
  analyse() reads what limits a plan — resource shadow prices, exact
  saturation points, machine/shard budget prices and an alternate ranking —
  off the continuous relaxation of the same planning model.
"""

import math, os, threading, yaml, json
from dataclasses import dataclass, field, replace as _dc_replace
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple
from ortools.linear_solver import pywraplp

ROOT          = Path(__file__).parent
RECIPES_PATH  = ROOT / "data" / "recipes_complete.yaml"
SCENARIOS_DIR = ROOT / "scenarios"

POWER_EXP   = math.log2(2.5)   # ≈1.3219 — 1.0 overclock power curve (250% → 3.36× power)
_POWER_ROUNDS = 4      # re-solves that move a power-capped plan closer to the cap
_POWER_CLOSE  = 0.002  # … stopping once within 0.2% of it
# Min New Alts: the goal may drop by at most this share to use fewer alts you
# haven't unlocked yet (each costs a hard drive, however much it runs).
_NEW_ALT_TOL = 0.01
# Machines are weighed by the room they take, not counted: w × l × h from
# machine_meta size_m (metres), in Smelter units — nothing is smaller than a
# Smelter, so it is 1 and every machine is a whole number of them (at least 1).
# Small whole numbers let the solver round its bounds, as it can for counts.
_SPACE_UNIT_MACHINE = "Smelter"
_DEFAULT_SPACE_UNITS = 2
def _volume(meta: Dict, machine: str) -> Optional[float]:
    size = (meta.get(machine) or {}).get("size_m")
    if not size or len(size) != 3:
        return None
    return float(size[0]) * float(size[1]) * float(size[2])

def machine_space(meta: Dict, machine: str) -> int:
    """Room one machine takes, in Smelter units."""
    v, unit = _volume(meta, machine), _volume(meta, _SPACE_UNIT_MACHINE)
    if v is None or not unit:
        return _DEFAULT_SPACE_UNITS
    return max(1, int(round(v / unit)))

# Power cap. Per machine, power = base × clock^POWER_EXP. A linear upper
# bound the model can use: at ≤100% clock^1.32 ≤ clock (exact at 100%), and
# above it each shard (+50% clock) adds at most the chord's slope over
# 100–250% — exact at 250%. So per recipe and sloop level:
#     power ≤ base × sloop_mult × (q + _SHARD_POWER × shards)
# The layouts never run a machine beyond 100% + 50% per shard it holds, so
# the bound holds for every plan; it runs a little high for machines clocked
# in between, which solve() takes back by re-solving closer to the cap.
SHARD_BOOST = 0.5
MAX_CLOCK   = 2.5
# Extra power per shard above the straight line q (see the power-cap note above)
_SHARD_POWER = SHARD_BOOST * ((MAX_CLOCK ** POWER_EXP - 1.0) / (MAX_CLOCK - 1.0) - 1.0)

POWER_ITEM = "Power"   # what generators put out: MW, an item so a factory can aim for it

SLOOP_SLOTS_BY_MACHINE = {
    "Smelter":1, "Constructor":1,
    "Foundry":2, "Assembler":2, "Refinery":2, "Converter":2,
    "Packager":0,   # the Packager can't take somersloops
    "Manufacturer":4, "Blender":4, "Particle_Accelerator":4, "Quantum_Encoder":4,
    "Miner":0, "Water_Extractor":0, "Oil_Extractor":0, "Nuclear_Power_Plant":0,
    "Coal_Generator":0, "Fuel_Generator":0,
}


# ── Data classes ──────────────────────────────────────────────────────────────
@dataclass
class Recipe:
    key: str; display: str; machine: str; alternate: bool
    inputs: Dict[str,float]; outputs: Dict[str,float]
    base_power_mw: float = 10.0; sloop_slots: int = 0
    space: int = _DEFAULT_SPACE_UNITS   # room one machine takes, Smelter units (see machine_space)

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
    notes: str = ""
    # Permanent unlock tracking — populated by the server from unlocked_alts.yaml.
    # The solver treats these alts as always-available (no per-scenario enable needed)
    # and does NOT count them when minimize_new_alts is True.
    unlocked_alt_recipes: List[str] = field(default_factory=list)
    # When True, use the fewest alternates that are NOT in unlocked_alt_recipes
    # (each costs a hard drive), giving up at most _NEW_ALT_TOL of the goal.
    minimize_new_alts: bool = False
    # Resources treated as unlimited: no supply cap, and left out of the
    # resource score so they're free and don't dilute the finite ones.
    unlimited_resources: List[str] = field(default_factory=list)
    # Somersloop placement: "dive" (fast, certified ≥ 95% of the best) or
    # "exact" (the full integer search, for comparing on big plans).
    sloop_search: str = "dive"
    # Lean stage order: least raw resources first (default), or least machine
    # space first and then the least resources among those plans.
    machines_first: bool = False

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
    certified: Optional[float] = None   # goal ≥ this fraction of the best possible (proven)
    power_bound_mw: Optional[float] = None   # the model's bound on power (with a cap)
    ceiling: Optional[float] = None   # the goal with machines, shards and sloops fractional — no plan beats it
    diagnosis: Optional[dict] = None   # when it can't be made: what's short, and what would help (diagnose)


# ── Loaders ───────────────────────────────────────────────────────────────────
def _si(v, d=0):
    try: return int(v) if v is not None else d
    except: return d

def _sf(v, d=0.0):
    try: return float(v) if v is not None else d
    except: return d

_RAW: Dict[str, Tuple[float, dict]] = {}

def _load_raw_yaml(path=RECIPES_PATH) -> dict:
    """The recipes YAML, parsed once per process; callers slice what they need.
    Pure-Python YAML takes ~0.6 s for this file, so a JSON copy beside it
    (data/.recipes_cache.json, rebuilt whenever the YAML changes) loads instead."""
    path = Path(path)
    mtime = path.stat().st_mtime
    hit = _RAW.get(str(path))
    if hit and hit[0] == mtime:
        return hit[1]
    cache = path.with_name(f".{path.stem}_cache.json")
    raw = None
    try:
        if cache.exists() and cache.stat().st_mtime >= mtime:
            raw = json.loads(cache.read_text(encoding="utf-8"))
    except Exception:
        raw = None
    if raw is None:
        with open(path) as f:
            raw = yaml.safe_load(f)
        try:
            cache.write_text(json.dumps(raw), encoding="utf-8")
        except Exception:
            pass
    _RAW[str(path)] = (mtime, raw)
    return raw

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
            # A recipe may set its own power (variable-power machines)
            base_power_mw=float(d.get("power_mw", m.get("base_power_mw", 10.0))),
            sloop_slots=int(SLOOP_SLOTS_BY_MACHINE.get(machine, 0)),
            space=machine_space(meta, machine),
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
        notes=raw.get("notes", "") or "",
        minimize_new_alts=bool(raw.get("minimize_new_alts", False)),
        unlimited_resources=list(raw.get("unlimited_resources") or []),
        sloop_search="exact" if raw.get("sloop_search") == "exact" else "dive",
        machines_first=bool(raw.get("machines_first", False)),
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
# Defined early so every model below can use them.

def _sloop_power_mult(r: Recipe, spm_val: int) -> float:
    """(1 + sloops_per_machine / max_slots)^2  — power scaling factor."""
    return (1.0 + spm_val / r.sloop_slots) ** 2 if r.sloop_slots > 0 else 1.0

def _output_mult(r: Recipe, spm_val: int) -> float:
    """1 + sloops_per_machine / max_slots  — throughput scaling factor."""
    return 1.0 + (spm_val / r.sloop_slots) if r.sloop_slots > 0 else 1.0


# ── Unlimited resources ───────────────────────────────────────────────────────
_UNLIMITED = 1e9   # supply used for resources marked unlimited (never binding)

_CRUMB = 0.005   # per minute: less than this left over is rounding, not a surplus


def _with_unlimited(scenario: Scenario) -> Scenario:
    """Scenario whose unlimited resources get a supply that can never bind."""
    if not scenario.unlimited_resources:
        return scenario
    res = dict(scenario.available_resources)
    for it in scenario.unlimited_resources:
        res[it] = _UNLIMITED
    return _dc_replace(scenario, available_resources=res)


# ── Pruning — forward grounding + backward demand ─────────────────────────────
def _pointless_loops(recipes: Dict[str, "Recipe"], targets: Set[str],
                     supplied: Set[str] = frozenset()) -> Set[str]:
    """Recipes that can only ever run as half of a net-zero loop: a recipe and
    its exact inverse (pack X / unpack X — same items, same ratios, no sloop
    slots, so the loop can't amplify). Unpacking is pointless when packing is
    the only source of what it unpacks; packing is pointless when unpacking is
    the only use of what it packs (and it isn't a goal). What you supply
    counts as a source, so unpacking a supplied packaged item always stays.
    Repeats until stable,
    since dropping one can make its partner pointless too."""
    def ratio(r, items):
        base = r.inputs[items[0]] if items[0] in r.inputs else r.outputs[items[0]]
        return {i: (r.inputs.get(i) or r.outputs.get(i)) / base for i in items}
    dropped: Set[str] = set()
    while True:
        live = {k: r for k, r in recipes.items() if k not in dropped}
        prod: Dict[str, Set[str]] = {}
        cons: Dict[str, Set[str]] = {}
        for k, r in live.items():
            for it in r.outputs:
                prod.setdefault(it, set()).add(k)
            for it in r.inputs:
                cons.setdefault(it, set()).add(k)
        new: Set[str] = set()
        for a, ra in live.items():                      # a packs, b unpacks
            if ra.sloop_slots:
                continue
            for b in {k for it in ra.outputs for k in cons.get(it, ())}:
                rb = live[b]
                if b == a or rb.sloop_slots or set(ra.outputs) != set(rb.inputs) \
                        or set(ra.inputs) != set(rb.outputs):
                    continue
                items = sorted(set(ra.inputs) | set(ra.outputs))
                if any(abs(x - y) > 1e-9 for x, y in
                       zip(ratio(ra, items).values(), ratio(rb, items).values())):
                    continue                            # not an exact inverse
                if all(prod.get(i, set()) == {a} and i not in supplied for i in rb.inputs):
                    new.add(b)
                if all(cons.get(i, set()) <= {b} and i not in targets for i in ra.outputs):
                    new.add(a)
        if not new:
            return dropped
        dropped |= new


_NODE_RES: Optional[Set[str]] = None

def _node_resources() -> Set[str]:
    """Items mined from nodes (node_resources in the recipe data)."""
    global _NODE_RES
    if _NODE_RES is None:
        _NODE_RES = set(_load_raw_yaml().get("node_resources") or [])
    return _NODE_RES


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

    # What's supplied but isn't mined (parts from another factory) can still be
    # made here too — an import adds to what the factory makes, it doesn't cap it
    mined = available_raw & _node_resources()

    def demand(skip: Set[str]) -> Set[str]:
        needed: Set[str] = set()
        visited: Set[str] = set(mined)
        # under a power cap, generators can raise it: their fuel chains stay in
        queue = list(target_items) + ([POWER_ITEM] if scenario.max_power_mw is not None else [])
        while queue:
            item = queue.pop()
            if item in visited:
                continue
            visited.add(item)
            for rkey in allowed_producers.get(item, []):
                if rkey in skip:
                    continue
                needed.add(rkey)
                for inp in allowed[rkey].inputs:
                    if inp not in visited:
                        queue.append(inp)
        return needed

    needed = demand(set())
    # Pointless loops out, then demand again: what only fed them goes too
    loops = _pointless_loops({k: allowed[k] for k in needed}, target_items,
                             available_raw) if _PRUNE_LOOPS else set()
    if loops:
        needed = demand(loops)

    # Sorted: set order changes between runs, and the model's row/column order
    # steers which of several equal LP optima the dive lands on — sorting
    # makes every solve reproducible.
    usable = {k: allowed[k] for k in sorted(needed)}

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


# ── Exact planner (mixed-integer) ─────────────────────────────────────────────
# One mixed-integer model of the whole factory, solved in three lexicographic
# stages. Each stage keeps the previous stages' optimum locked in place:
#
#   1. Goal  — maximise the weighted goal items.
#   2. Lean  — (a) least raw resources, then (b) least machine space: whole
#              machines weighed by the room they take (w·l·h, size_m).
#              Resources are the finite thing; machines can always be built,
#              so machines never buy back resources. (machines_first swaps
#              the two: least machine space, then least resources.)
#   3. Clean — minimise recipes and duplicate producers of one product, letting
#              machines rise by at most _MACHINE_SLACK (resources stay locked).
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
# Budgets: Σ l·n ≤ somersloops, Σ s ≤ shards.
#
# Stage 2a scores resources as the mean over resources of (net use / supply),
# so each is measured on its own scale — 50 Water/min out of 5000 counts the
# same as 1.2 Caterium/min out of 120. Resources marked unlimited are left out
# of that mean entirely (and uncapped), so they're free and don't dilute the
# rest. Stage 2b's whole-number score lets the solver round its bound up
# (77.2 → 78 machines) and prune, which keeps shard-heavy plans fast.
# Power is not optimised.
_GOAL_TOL      = 1e-7    # relative slack on the locked goal
_RES_TOL       = 1e-6    # relative slack on the locked resource score (numerics only)
# With machines_first the resource stage finds its best plan early but proving
# it to 1e-9 can take the whole time limit (a weak bound under the machine
# lock). Stopping within 1% mirrors _MACHINE_SLACK in the default order.
_RES_GAP       = 0.01    # machines_first: resources within 1% of the least
_MACHINE_SLACK = 0.01    # stage 3 may add ≤1% more machine space for fewer recipes

_PARALLEL_PEN  = 0.5     # a 2nd producer of one product costs half a recipe extra
# No time limits: every stage runs until proven — plans are cached, so even a
# long solve is a one-time cost. (None = unlimited; a number caps a stage.)
_STAGE_TIME_S: Tuple[Optional[float], ...] = (None, None, None)
_PRUNE_LOOPS   = True    # drop pack/unpack pairs that can only loop (see _pointless_loops)
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
    goal_bound: Optional[float] = None   # proven upper bound on the goal (stage 1)
    goal_pre: Optional[float] = None     # stage-1 goal before Min New Alts traded some away
    lean_proven: bool = True   # resource and machine stages proven (within their gaps)
    power_bound: Optional[float] = None   # the model's (upper-bound) power, with a cap

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
                for it in sorted(set(r.inputs) | set(r.outputs)):
                    c = r.outputs.get(it, 0.0) * mult - r.inputs.get(it, 0.0)
                    if c:
                        self.net.setdefault(it, {})[("q", k, l)] = c
            self.links[k] = links

        res = scenario.available_resources
        self.res_ct: Dict[str, object] = {}     # resource → its supply constraint
        for it, sp in self.net.items():
            if it in res:
                self.res_ct[it] = self.ct(-INF, res[it], {v: -c for v, c in sp.items()})
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
        # What the lean stages minimise: machine space, not machine count
        self.space = {key: float(usable[key[1]].space) for key in self.machines}
        self.sloops = {key: float(key[2]) for key in self.machines if key[2]}
        # Budgets, kept by name so the analysis can read their prices
        self.budget_ct: Dict[str, object] = {}
        if use_sloops:
            self.budget_ct["sloops"] = self.ct(-INF, float(S), self.sloops)
        if SH > 0:
            self.budget_ct["shards"] = self.ct(
                -INF, float(SH), {key: 1.0 for key in self.var if key[0] == "s"})
        self.power: Dict[Key, float] = {}
        if scenario.max_power_mw is not None:
            self.power = _power_bound(usable, self.var)
            self.budget_ct["power"] = self.ct(-INF, float(scenario.max_power_mw), self.power)

        self.goal: Dict[Key, float] = {}
        for it, w in scenario.objective.items():
            for key, c in self.net.get(it, {}).items():
                self.goal[key] = self.goal.get(key, 0.0) + w * c
        self.new_alt: Dict[Key, float] = {}
        if scenario.minimize_new_alts:
            unlocked = set(scenario.unlocked_alt_recipes)
            self.new_alt = {key: 1.0 for key in self.var if key[0] == "q"
                            and usable[key[1]].alternate and key[1] not in unlocked}
        self.new_alt_recipes = sorted({key[1] for key in self.new_alt})
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

    def run(self, coeffs: Dict[Key, float], maximize: bool, time_s: Optional[float],
            gap: Optional[float] = None, nodes: Optional[int] = None) -> Optional[bool]:
        """Solve with this objective. None = failed, else True if proven optimal
        (within `gap`, relative, when given). self.bound holds the proven bound.
        nodes: stop after this many branch-and-bound nodes — a limit that, unlike
        time, gives the same plan on any machine."""
        obj = self.s.Objective()
        obj.Clear()
        for key, a in coeffs.items():
            v = self.var.get(key)
            if v is not None:
                obj.SetCoefficient(v, obj.GetCoefficient(v) + a)
        obj.SetMaximization() if maximize else obj.SetMinimization()
        # None = no limit (the limit persists between solves, so always set it)
        self.s.SetTimeLimit(int(time_s * 1000) if time_s is not None else 10 ** 12)
        if self.integer:
            if self._hint and _USE_HINTS:
                self.s.SetHint(*self._hint)
            if self.s.SolverVersion().startswith("SCIP"):
                # the node limit persists between solves, so always set it
                self.s.SetSolverSpecificParametersAsString(
                    _SCIP_PARAMS + f"limits/nodes = {nodes if nodes else -1}\n")
            p = pywraplp.MPSolverParameters()
            p.SetDoubleParam(p.RELATIVE_MIP_GAP, _MIP_GAP if gap is None else gap)
            st = self.s.Solve(p)
        else:
            st = self.s.Solve()
        if st not in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE):
            return None
        self.bound = self.s.Objective().BestBound() if self.integer else self.s.Objective().Value()
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
        return _Plan(parts, self.value(self.goal), proven,
                     goal_bound=getattr(self, "goal_bound", None),
                     goal_pre=getattr(self, "goal_pre", None),
                     lean_proven=getattr(self, "lean_proven", True),
                     power_bound=self.value(self.power) if self.power else None)


# Bounds take one LP per recipe — hundreds on a big plan. Only the objective
# changes between them, so GLOP's presolve (which discards the last basis) is
# turned off, and they're split across threads: OR-Tools releases Python's
# lock while it solves, and each thread has its own copy of the model.
# Every LP is the same as one after the other, so the bounds are too.
_THREADS = max(1, min(4, os.cpu_count() or 1))
_LP_WARM = "use_preprocessing:false use_dual_simplex:false"


def _max_each(build, keys) -> Dict[str, float]:
    """Most each recipe in `keys` can run (machine-equivalents) on the
    relaxation build() returns — the bounds that make tight big-Ms."""
    keys = list(keys)
    out: Dict[str, float] = {}

    def work(ks):
        lp = build()
        lp.s.SetSolverSpecificParametersAsString(_LP_WARM)
        for k in ks:
            cols = {("q", k, l): 1.0 for l in lp.levels[k]}
            if lp.run(cols, True, 5) is not None:
                out[k] = lp.value(cols) * (1 + 1e-7) + 1e-6

    n = min(_THREADS, len(keys) // 25)   # a thread is worth it from ~25 LPs
    if n <= 1:
        work(keys)
    else:
        ts = [threading.Thread(target=work, args=(keys[i::n],)) for i in range(n)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
    return out


def _recipe_bounds(scenario: Scenario, usable: Dict[str, Recipe]) -> Dict[str, float]:
    """Most each recipe can run (machine-equivalents), on the relaxation with no
    sloop caps — valid bounds for every plan of this scenario."""
    return _max_each(lambda: _Model(scenario, usable, integer=False), usable)


def _plan(scenario: Scenario, usable: Dict[str, Recipe], warnings: List[str],
          sloop_caps: Optional[Dict[str, int]] = None,
          goal_gap: Optional[float] = None,
          goal_time: Optional[float] = None,
          goal_nodes: Optional[int] = None,
          beat: Optional[float] = None,
          info: Optional[dict] = None,
          bounds: Optional[Dict[str, float]] = None,
          seed: Optional[_Plan] = None,
          known: Optional[dict] = None) -> Optional[_Plan]:
    """
    Run the stages. Returns None when the scenario is infeasible.
    sloop_caps: at most this many sloops per recipe (from _dive_sloops).
    goal_gap:   stop stage 1 once proven within this relative gap.
    goal_time:  stage-1 time limit (default _STAGE_TIME_S[0], none).
    goal_nodes: stage-1 node limit (none).
    beat:       goal-only mode — stop right after stage 1 and return None, with
                info["goal"], ["goal_bound"], ["proven"] and ["plan"] (for
                `known`); if its goal beats this, info["alloc"] gets its sloops
                per recipe so the caller can build with those fixed.
    info:       receives {"goal_bound": …} after stage 1.
    known:      stage 1's result from an earlier goal-only run of this same
                model (its info dict): stage 1 is skipped and resumes from it.
    seed:       a plan to start the search from (the dive's): the goal search
                then only has to prove its bound, not also find a good plan.
    bounds:     per-recipe throughput bounds already worked out for this
                scenario (see _recipe_bounds) — valid under any sloop caps, so
                the plans of one solve share them instead of re-deriving.
    """
    mip = _Model(scenario, usable, integer=True)
    lp  = _Model(scenario, usable, integer=False)    # relaxation: bounds + LP-only stages
    # What's been added to lp, so tighten() can build copies of it for threads
    lp_edits: List = []

    def caps(m) -> None:
        for k, levels in m.levels.items():
            expr = {("n", k, l): float(l) for l in levels if l}
            if expr:
                m.ct(-m.inf, float(sloop_caps.get(k, 0)), expr)

    if sloop_caps is not None:
        caps(mip)
        caps(lp)
        lp_edits.append(caps)
    if not mip.integer:
        warnings.append("No integer solver available — machine counts are rounded, "
                        "somersloops and shards are not optimised.")

    def lock(lo: float, hi: float, expr_of) -> None:
        mip.ct(lo, hi, expr_of(mip))
        lp.ct(lo, hi, expr_of(lp))
        lp_edits.append(lambda m: m.ct(lo, hi, expr_of(m)))

    def lp_copy() -> "_Model":
        m = _Model(scenario, usable, integer=False)
        for edit in lp_edits:
            edit(m)
        return m

    def tighten(only=None) -> None:
        """Per-recipe max throughput under the current locks → tight big-Ms.
        Recipes that can't run at all under the locks are switched off.
        only: just these recipes (the others keep their earlier, looser
        but still valid bounds)."""
        keys = [k for k in lp.levels if only is None or k in only]
        for k, ub in _max_each(lp_copy, keys).items():
            mip.bound_recipe(k, ub)

    if bounds is None:
        tighten()
    else:
        for k, ub in bounds.items():
            mip.bound_recipe(k, ub)
    if seed is None and known is not None:
        seed = known.get("plan")
    if seed is not None and mip.integer:
        vals: Dict[Key, float] = {key: 0.0 for key in mip.var}
        for k, parts in seed.parts.items():
            for p in parts:
                for key, v in ((("q", k, p.level), p.q), (("n", k, p.level), p.n),
                               (("s", k, p.level), p.shards)):
                    if key in vals:
                        vals[key] = float(v)
        mip._hint = ([mip.var[k] for k in vals], list(vals.values()))
    proven = True
    best: Optional[_Plan] = None

    # ── Stage 1: goal ──
    # Min New Alts adds two steps: with the goal kept within _NEW_ALT_TOL of
    # its best, use the fewest alts you haven't unlocked (a count — each is a
    # hard drive, however much it runs); then the best goal with that many.
    if mip.goal or mip.new_alt:
        # Integers only matter for the goal when sloops are in play
        integer_goal = mip.integer and scenario.somersloops_available > 0
        m1 = mip if integer_goal or not mip.integer else lp
        if known is not None:
            ok, g, goal_bound = known["proven"], known["goal"], known["goal_bound"]
        else:
            ok = m1.run(m1.goal, True, goal_time or _STAGE_TIME_S[0], gap=goal_gap, nodes=goal_nodes)
            if ok is None:
                return None
            g = m1.value(m1.goal)
            # Proven ceiling on the goal, before any trade for fewer new alts
            goal_bound = m1.bound if mip.goal else None
        proven &= ok
        mip.goal_pre = g        # the best goal before any trade for fewer new alts
        mip.goal_bound = goal_bound
        if info is not None:
            info["goal_bound"] = goal_bound
        if beat is not None:
            if info is not None:
                info.update(goal=g, proven=ok,
                            plan=mip.snapshot(proven) if m1 is mip else None)
                if g > beat + max(1e-9, abs(beat) * 1e-9):
                    alloc: Dict[str, float] = {}
                    for (kind, k, l), v in m1.var.items():
                        if kind == "n" and l:
                            alloc[k] = alloc.get(k, 0.0) + l * v.solution_value()
                    info["alloc"] = {k: int(round(x)) for k, x in alloc.items() if round(x) > 0}
            return None
        if mip.new_alt:
            if mip.goal:
                lock(g - abs(g) * _NEW_ALT_TOL - 1e-6, mip.inf, lambda m: m.goal)
            if mip.integer:
                count = {("y", k, 0): 1.0 for k in mip.new_alt_recipes}
                for k in mip.new_alt_recipes:
                    mip.var[("y", k, 0)] = mip.y[k]
                ok = mip.run(count, False, _STAGE_TIME_S[0])
                if ok is None:
                    return None
                proven &= ok
                # Keep the chosen alts and leave the rest out entirely — a far
                # easier model for the later stages than a count constraint
                # (read the choice first: changing the model voids the solution)
                dropped = [k for k in mip.new_alt_recipes if mip.y[k].solution_value() < 0.5]
                for k in dropped:
                    mip.bound_recipe(k, 0.0)
                    lp.bound_recipe(k, 0.0)
                lp_edits.append(lambda m, ks=tuple(dropped): [m.bound_recipe(k, 0.0) for k in ks])
                m1 = mip
            else:
                # No integer solver: fall back to the least new-alt throughput
                if lp.run(lp.new_alt, False, _STAGE_TIME_S[0]) is None:
                    return None
                lock(-mip.inf, lp.value(lp.new_alt) + 1e-6, lambda m: m.new_alt)
            if mip.goal:
                ok = m1.run(m1.goal, True, goal_time or _STAGE_TIME_S[0], gap=goal_gap, nodes=goal_nodes)
                if ok is None:
                    return None
                proven &= ok
                g = m1.value(m1.goal)
        if m1 is mip and (known is None or mip.new_alt):   # only if solved here
            best = mip.snapshot(proven)
        if mip.goal:
            lock(g - max(1e-6, abs(g) * _GOAL_TOL), mip.inf, lambda m: m.goal)
    else:
        goal_bound = None
        mip.goal_bound = None

    # ── Stage 2: lean ──
    # Default order: (a) least raw resources, then (b) least machine space —
    # resources are the finite thing, so they are never traded for machines.
    # machines_first swaps the two: least machine space, then the least
    # resources among plans that small.
    unlimited = set(scenario.unlimited_resources)
    supplied = [it for it, v in scenario.available_resources.items()
                if v > 0 and it not in unlimited]
    def resources_of(m) -> Dict[Key, float]:
        # One score across resources: the mean of net use / supply (each
        # resource on its own scale).
        cost: Dict[Key, float] = {}
        for it in supplied:
            w = 1.0 / len(supplied) / scenario.available_resources[it]
            for key, c in m.net.get(it, {}).items():
                cost[key] = cost.get(key, 0.0) - c * w     # −net = consumption
        return cost

    # Each step snapshots its plan before locking its score (adding the lock
    # invalidates the solver's current solution).
    def lean_resources() -> bool:
        nonlocal proven, best
        if not supplied:
            return True
        # Resources depend only on throughput; integers matter only through
        # sloops or a space lock, so otherwise the LP gives the exact optimum.
        integer_res = mip.integer and (scenario.somersloops_available > 0
                                       or scenario.machines_first)
        m2 = mip if integer_res or not mip.integer else lp
        ok = m2.run(resources_of(m2), False, _STAGE_TIME_S[1],
                    gap=_RES_GAP if scenario.machines_first else None)
        if ok is None:
            return False
        proven &= ok
        mip.lean_proven = getattr(mip, "lean_proven", True) and ok
        r2 = m2.value(resources_of(m2))
        if m2 is mip:
            best = mip.snapshot(proven)
        lock(-mip.inf, r2 + abs(r2) * _RES_TOL + 1e-9, resources_of)
        return True

    def lean_machines() -> bool:
        # Least machine space (whole machines weighed by the room they take).
        # A whole-number score (space in Smelter units) lets the solver round its
        # bound up and prune — what keeps shard-heavy plans fast. Stage 3 may
        # add _MACHINE_SLACK anyway, so proving the minimum more tightly than
        # that is wasted search: stop within that gap, then allow at most
        # _MACHINE_SLACK over the proven minimum in total.
        nonlocal proven, best
        ok = mip.run(mip.space, False, _STAGE_TIME_S[1], gap=_MACHINE_SLACK)
        if ok is None:
            return False
        proven &= ok
        mip.lean_proven = getattr(mip, "lean_proven", True) and ok
        best = mip.snapshot(proven)
        v2 = mip.value(mip.space)
        v_floor = math.ceil(mip.bound - 1e-6) if mip.integer else v2
        mip.space_floor = v_floor     # proven: no plan under these locks takes less
        cap = max(v2, math.floor(v_floor * (1 + _MACHINE_SLACK) + 1e-9))
        lock(-mip.inf, cap + 0.5, lambda m: m.space)
        return True

    for step in ((lean_machines, lean_resources) if scenario.machines_first
                 else (lean_resources, lean_machines)):
        if not step():
            return best
    if not mip.integer:
        return best
    # Tight big-Ms for the recipe-count stage — for the recipes in the plan;
    # the rest keep their first, looser but valid bounds
    tighten(set(best.parts) if best is not None else None)

    # ── Stage 3: clean ──
    # 3a: fewest recipes + duplicate producers (a half-integer score, quick to
    # prove); 3b: with that locked, the least machine space among such plans.
    # Scored in half-recipes (×2) on integer variables, so the solver knows the
    # score is whole and can round its bound — much quicker to prove.
    obj: Dict[Key, float] = {}
    for k, yv in mip.y.items():
        obj[("y", k, 0)] = 2.0
        mip.var[("y", k, 0)] = yv
    by_main: Dict[str, List[str]] = {}
    for k, r in usable.items():
        if r.outputs:
            by_main.setdefault(next(iter(r.outputs)), []).append(k)
    for i, ks in enumerate(by_main.values()):
        if len(ks) > 1:
            extra = mip.var[("x", f"dup{i}", 0)] = mip.s.IntVar(0, mip.inf, "")
            c = mip.s.Constraint(-1.0, mip.inf)    # extra ≥ (#producers used) − 1
            c.SetCoefficient(extra, 1.0)
            for k in ks:
                c.SetCoefficient(mip.y[k], -1.0)
            obj[("x", f"dup{i}", 0)] = _PARALLEL_PEN * 2.0
    ok = mip.run(obj, False, _STAGE_TIME_S[2])
    if ok is None:
        return best
    best = mip.snapshot(proven)
    best.clean_proven = ok
    # Space is in whole Smelter units, so the solver rounds its bound and this
    # proves quickly (in m³ it couldn't, and ran out of time).
    mip.ct(-mip.inf, mip.value(obj) + 1e-6, obj)
    # Stage 2 proved no plan takes less space than its floor, and 3b only adds
    # locks — so the floor is a valid cut, and the search starts its bound there
    # instead of at a weak relaxation (it often proves at once)
    floor = getattr(mip, "space_floor", None)
    if floor:
        mip.ct(floor - 1e-6, mip.inf, mip.space)
    ok_b = mip.run(mip.space, False, _STAGE_TIME_S[2])
    if ok_b is None:
        return best
    best = mip.snapshot(proven)
    best.clean_proven = ok and ok_b

    # ── Stage 4: tidy ──
    if mip.sloops and scenario.somersloops_available > 0:
        mip.ct(-mip.inf, mip.value(mip.space) + 0.5, mip.space)
        if mip.run(mip.sloops, False, _STAGE_TIME_S[2]) is not None:
            tidy = mip.snapshot(proven)
            tidy.clean_proven = best.clean_proven
            best = tidy
    return best


# ── Somersloop dive ───────────────────────────────────────────────────────────
# Somersloops are what makes big plans slow for the exact search: whole sloops
# in whole machines across hundreds of recipes. The dive decides them on the
# continuous relaxation instead — the same matrix, where co-binding chains are
# balanced jointly — and then only needs whole numbers for one recipe at a time:
#   1. solve the relaxation (sloops, shards, machines fractional) → the ceiling
#   2. fix the recipe whose sloop count is closest to whole to that whole number
#   3. re-solve so every other chain re-balances around it; repeat until all whole
# One warm LP per fixed recipe. The plan is then built with those counts as
# per-recipe caps, and certified against the ceiling: goal ÷ ceiling is a
# proven lower bound on how close the plan is to the best buildable one.
_CERT_TARGET = 0.95   # below this, fall back to an exact goal search (to 1 − target)
_POLISH_BELOW = 0.99  # below this, give the exact goal search a short try too
# The polish's budget, in branch-and-bound nodes rather than seconds, so a
# scenario gives the same plan however fast the machine is. 300 nodes matched
# or beat the old 3-second limit on every stress case (150 lost 0.2% on one).
_POLISH_NODES = 300


# ── Why a plan can't be made ─────────────────────────────────────────────────
# When the goals can't all be met, a quick continuous model (machines
# fractional, no shards or sloops) says by how much: the least extra supply
# that would meet every exact and minimum goal, how much of each such goal
# what you have can make on its own, and which alternates you haven't
# unlocked would close the gap.
_RAW_ITEMS: Dict[int, Set[str]] = {}

def _raw_items(all_recipes: Dict[str, Recipe]) -> Set[str]:
    """Items no recipe makes: ores, oil, water, gases."""
    key = id(all_recipes)
    if key not in _RAW_ITEMS:
        made = {it for r in all_recipes.values() for it in r.outputs}
        _RAW_ITEMS[key] = {it for r in all_recipes.values() for it in r.inputs} - made
    return _RAW_ITEMS[key]

def _relaxed(scenario: Scenario, all_recipes: Dict[str, Recipe], slack: bool,
             most: Optional[str] = None, alts: Set[str] = frozenset(), alone: bool = False) -> Optional[dict]:
    """The continuous model. slack: extra supply allowed (raw items and imports),
    its total minimised — {"short": {item: extra/min}, "recipes": {key: rate}}.
    most: no slack — the most of that item it can make with the other goals
    met (alone: with no other goals)."""
    sc = _dc_replace(scenario, objective={} if most is None else {most: 1.0},
                     alternate_recipes_enabled=sorted(set(scenario.alternate_recipes_enabled) | set(alts)))
    if most is not None:           # its own goal goes; the others stay unless `alone`
        sc = _dc_replace(sc, must_produce={} if alone else {k: v for k, v in sc.must_produce.items() if k != most},
                         min_produce={} if alone else {k: v for k, v in sc.min_produce.items() if k != most})
    raws = _raw_items(all_recipes)
    res = dict(sc.available_resources)
    unlimited = set(sc.unlimited_resources)
    # recipes reachable if any raw were supplied, so a missing ore still shows up
    usable, _ = prune_recipes(_dc_replace(sc, available_resources={**{r: _UNLIMITED for r in raws}, **res}), all_recipes)
    if not usable:
        return None
    s = pywraplp.Solver.CreateSolver("GLOP")
    if s is None:
        return None
    inf = s.infinity()
    q = {k: s.NumVar(0, inf, "") for k in usable}
    net: Dict[str, Dict[str, float]] = {}
    for k, r in usable.items():
        for it, a in r.outputs.items():
            net.setdefault(it, {})[k] = net.setdefault(it, {}).get(k, 0.0) + a
        for it, a in r.inputs.items():
            net.setdefault(it, {})[k] = net.setdefault(it, {}).get(k, 0.0) - a
    obj = s.Objective()
    x: Dict[str, object] = {}
    for it, coeffs in net.items():
        if it in unlimited:
            continue
        A = res.get(it, 0.0)
        if it in sc.must_produce:
            lo = hi = sc.must_produce[it] - A
        else:
            lo = sc.min_produce[it] - A if it in sc.min_produce else (-A if it in res else 0.0)
            hi = sc.max_produce[it] - A if it in sc.max_produce else inf
        if most is None and it not in res and it not in raws and lo <= 0 and hi == inf:
            lo = 0.0
        c = s.Constraint(lo, hi)
        for k, a in coeffs.items():
            c.SetCoefficient(q[k], a)
        if slack and (it in raws or it in res):
            v = x[it] = s.NumVar(0, inf, "")
            c.SetCoefficient(v, 1.0)
            obj.SetCoefficient(v, 1.0 if A > 0 else 4.0)   # more of what it mines first
    for k in q:
        obj.SetCoefficient(q[k], obj.GetCoefficient(q[k]) + 1e-6)   # no idle loops
    if most is not None:
        for k, a in net.get(most, {}).items():
            obj.SetCoefficient(q[k], a)
        obj.SetMaximization()
    else:
        obj.SetMinimization()
    if s.Solve() != pywraplp.Solver.OPTIMAL:
        return None
    if most is not None:
        return {"most": max(0.0, sum(a * q[k].solution_value() for k, a in net.get(most, {}).items())
                               + res.get(most, 0.0))}
    return {"short": {it: v.solution_value() for it, v in x.items() if v.solution_value() > 0.01},
            "recipes": {k: v.solution_value() for k, v in q.items() if v.solution_value() > 1e-6}}

def diagnose(scenario: Scenario, all_recipes: Dict[str, Recipe]) -> dict:
    """Why the goals can't be met, and what would meet them:
    {"short": {item: extra/min}, "has": {item: per min now},
     "most": {goal: [most it can make with the other goals met, asked]},
     "alone": {goal: [most on its own, asked]} (when the others can't be met anyway),
     "alts": {"use": [alternates], "short": {item: extra still}} (alternates
     you haven't unlocked that close or narrow the gap), "fits_relaxed": True
     when the continuous model fits — then it's whole machines, the power cap,
     shards or sloops}."""
    sc = _with_unlimited(scenario)
    base = _relaxed(sc, all_recipes, slack=True)
    if base is None:
        return {}
    out: dict = {"short": {k: round(v, 1) for k, v in base["short"].items()},
                 "has": {k: round(sc.available_resources.get(k, 0.0), 1) for k in base["short"]}}
    if not base["short"]:
        out["fits_relaxed"] = True
        return out
    # each goal: the most of it there can be with the rest met — lowered to
    # that, the plan fits; failing that, the most on its own
    most, alone = {}, {}
    for g, qty in {**scenario.min_produce, **scenario.must_produce}.items():
        m = _relaxed(sc, all_recipes, slack=False, most=g)
        if m is not None:
            if m["most"] < qty * (1 - 1e-3) - 1e-3:
                most[g] = [math.floor(m["most"] * 10) / 10, qty]
        else:
            a = _relaxed(sc, all_recipes, slack=False, most=g, alone=True)
            if a is not None and a["most"] < qty * (1 - 1e-3) - 1e-3:
                alone[g] = [math.floor(a["most"] * 10) / 10, qty]
    if most:
        out["most"] = most
    if alone:
        out["alone"] = alone
    known = set(scenario.alternate_recipes_enabled) | set(scenario.unlocked_alt_recipes)
    locked = {k for k, r in all_recipes.items() if r.alternate and k not in known}
    total = sum(base["short"].values())
    if locked:
        alt = _relaxed(sc, all_recipes, slack=True, alts=locked)
        if alt is not None and sum(alt["short"].values()) < total - 0.5:
            use = sorted(k for k in alt["recipes"] if k in locked)
            best = sum(alt["short"].values())
            for k in list(use):                      # the fewest that do as well
                trial = _relaxed(sc, all_recipes, slack=True, alts=set(use) - {k})
                if trial is not None and sum(trial["short"].values()) <= best + 0.5:
                    use.remove(k)
                    best = sum(trial["short"].values())
            final = _relaxed(sc, all_recipes, slack=True, alts=set(use))
            out["alts"] = {"use": use, "short": {k: round(v, 1) for k, v in (final or alt)["short"].items()}}
    return out

ITEM_NAMES: Dict[str, str] = {}   # in-game item names, where they differ (server.py fills it)

def diagnosis_hints(d: dict, name=None, recipe=lambda k: k) -> List[str]:
    """The diagnosis in words, for the issues list."""
    name = name or (lambda k: ITEM_NAMES.get(k, k.replace("_", " ")))
    out = []
    f = lambda v: f"{v:,.1f}".rstrip("0").rstrip(".")
    for it, v in sorted(d.get("short", {}).items(), key=lambda kv: -kv[1]):
        has = d.get("has", {}).get(it, 0.0)
        out.append(f"Not enough {name(it)}: the goals need about {f(v)}/min more"
                   + (f" than the {f(has)}/min it has." if has > 0 else " — it has none."))
    for g, (most, asked) in d.get("most", {}).items():
        out.append(f"{name(g)}: at most {f(most)}/min with the other goals met (asked {f(asked)}/min) — "
                   "lower it to that, or bring in more.")
    for g, (most, asked) in d.get("alone", {}).items():
        out.append(f"{name(g)}: at most {f(most)}/min even on its own (asked {f(asked)}/min).")
    a = d.get("alts")
    if a:
        names = ", ".join(recipe(k) for k in a["use"])
        out.append(f"Alternates you haven't unlocked would {'make it work' if not a['short'] else 'narrow the gap'}: {names}"
                   + ("." if not a["short"] else f" (still short: {', '.join(f'{name(k)} {f(v)}/min' for k, v in a['short'].items())})."))
    if d.get("fits_relaxed"):
        out.append("The goals fit with fractional machines but not whole ones — loosen an exact amount, "
                   "raise the power cap, or allow more shards.")
    return out


def _fractional_ceiling(scenario: Scenario, usable: Dict[str, Recipe]) -> Optional[float]:
    """The goal of the continuous relaxation: whole machines, shards and sloops
    made fractional. A bound no buildable plan can pass."""
    lp = _Model(scenario, usable, integer=False)
    if lp.run(lp.goal, True, _STAGE_TIME_S[0]) is None:
        return None
    return lp.value(lp.goal) + 0.0


def _dive_sloops(scenario: Scenario, usable: Dict[str, Recipe]
                 ) -> Optional[Tuple[Dict[str, int], float]]:
    """Returns (sloops per recipe, relaxation ceiling on the goal), or None."""
    lp = _Model(scenario, usable, integer=False)
    obj = lp.goal
    if lp.run(obj, True, _STAGE_TIME_S[0]) is None:
        return None
    ceiling = lp.value(lp.goal) + 0.0
    sloops: Dict[str, Dict[Key, float]] = {}
    for (kind, k, l) in lp.var:
        if kind == "n" and l:
            sloops.setdefault(k, {})[("n", k, l)] = float(l)
    fixed: Set[str] = set()
    for _ in range(len(sloops) + 1):
        vals = {k: lp.value(e) for k, e in sloops.items()}
        frac = {k: x for k, x in vals.items() if k not in fixed and abs(x - round(x)) > 1e-6}
        if not frac:
            break
        k = min(frac, key=lambda k: abs(frac[k] - round(frac[k])))   # least disruptive
        x = frac[k]
        for target in sorted({math.floor(x), math.ceil(x)}, key=lambda t: abs(t - x)):
            c = lp.ct(target, target, sloops[k])
            if lp.run(obj, True, _STAGE_TIME_S[0]) is not None:
                break
            c.SetBounds(-lp.inf, lp.inf)          # that side is infeasible — try the other
        else:
            lp.ct(math.floor(x), math.floor(x), sloops[k])   # rounding down is always feasible
            lp.run(obj, True, _STAGE_TIME_S[0])
        fixed.add(k)
    alloc = {k: int(round(lp.value(e))) for k, e in sloops.items()}
    return {k: v for k, v in alloc.items() if v > 0}, ceiling


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


def _power_bound(usable: Dict[str, Recipe], var: Dict[Key, object]) -> Dict[Key, float]:
    """Linear upper bound on power (MW) over the model's columns (see _SHARD_POWER).
    Generators (negative power) scale exactly with clock, so they're just q."""
    out: Dict[Key, float] = {}
    for kind, k, l in var:
        r = usable.get(k)
        if r is None or kind not in ("q", "s"):
            continue
        per = r.base_power_mw * _sloop_power_mult(r, l)
        if kind == "q":
            out[(kind, k, l)] = per
        elif per > 0:
            out[(kind, k, l)] = per * _SHARD_POWER
    return out


def _layout_power(r: Recipe, level: int, groups: List[Tuple[int, float, int]]) -> float:
    # Generators (negative power) produce in proportion to their clock
    exp = 1.0 if r.base_power_mw < 0 else POWER_EXP
    return r.base_power_mw * _sloop_power_mult(r, level) * \
        sum(c * clk ** exp for c, clk, _ in groups)


def _min_shards(q: float, n: int) -> Optional[int]:
    """Fewest shards letting n machines deliver q, or None if impossible."""
    if q > n * MAX_CLOCK + 1e-9:
        return None
    return max(0, math.ceil(2.0 * (q - n) - 1e-6)) if q > n + 1e-9 else 0


# ── Main solve ────────────────────────────────────────────────────────────────
def solve(scenario: Scenario, all_recipes: Dict[str,Recipe],
          machine_meta: Optional[Dict] = None) -> SolveResult:
    """Plan the factory. With a power cap, the plan is fit under it as closely
    as the model allows: the model's power is an upper bound (see
    _SHARD_POWER), so the first plan can sit a little under the cap. The
    re-solves raise the model's cap by that slack, keeping a plan only if its
    real power still fits the cap and it makes at least as much."""
    result = _solve_once(scenario, all_recipes, machine_meta)
    cap = scenario.max_power_mw
    if cap is None or cap <= 0 or not result.status.startswith("Optimal"):
        return result
    # Search the model's cap between one whose plan fits (lo) and one whose
    # plan overshoots or gains nothing (hi); keep the best plan that fits.
    lo, hi = cap, None
    for _ in range(_POWER_ROUNDS):
        used, bound = result.total_power_mw, result.power_bound_mw
        if used <= 0 or bound is None or used >= cap * (1 - _POWER_CLOSE):
            break
        if bound < lo * (1 - _POWER_CLOSE):
            break                      # power isn't what limits this plan
        guess = lo * cap / used        # where the bound's slack says the cap could go
        trial_cap = guess if hi is None else (lo + min(hi, guess)) / 2
        trial = _solve_once(_dc_replace(scenario, max_power_mw=trial_cap), all_recipes, machine_meta)
        if trial.status.startswith("Optimal") and trial.total_power_mw <= cap + 1e-6 \
                and trial.objective_value > result.objective_value * (1 + 1e-6) + 1e-9:
            result, lo = trial, trial_cap
        else:
            hi = trial_cap
    # Overshoot against the real cap (re-solves measured it against theirs)
    over = result.total_power_mw - cap
    if over > 0.5:
        result.cap_overshoot["power_over"] = round(over, 1)
    else:
        result.cap_overshoot.pop("power_over", None)
    return result


def _solve_once(scenario: Scenario, all_recipes: Dict[str,Recipe],
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

    shadow_prices:     Dict[str,float]  = {}   # computed lazily via analyse()
    saturation_points: Dict[str,object] = {}

    model_sc = _with_unlimited(scenario)
    plan, certified, frac_ceiling = None, None, None
    if usable and model_sc.somersloops_available > 0 and model_sc.objective \
            and model_sc.sloop_search != "exact":
        dive = _dive_sloops(model_sc, usable)
        if dive is not None:
            alloc, ceiling = dive
            frac_ceiling = ceiling
            # One set of recipe bounds for every plan this solve builds
            rb = _recipe_bounds(model_sc, usable)
            # Decide the sloop placement on the goal alone, then build the full
            # plan (resources, space, cleanup) once, for the placement that wins.
            first: dict = {}
            _plan(model_sc, usable, warnings, sloop_caps=alloc, bounds=rb,
                  beat=math.inf, info=first)
            if "goal" in first and ceiling > 1e-9:
                # Placement is judged on the goal before Min New Alts trades any
                # away (stage 1's own goal) — that trade is deliberate.
                use_alloc, use_known, use_seed = alloc, first, None
                if first["goal"] / ceiling < _POLISH_BELOW:
                    # Try the exact goal search, seeded with the dive's plan:
                    #  • below the target (whole machines make the fractional
                    #    ceiling loose): run until proven within the target —
                    #    its bound respects whole machines;
                    #  • otherwise: a short polish, kept only if it beats the dive.
                    # Either way the tighter of the two bounds certifies.
                    info: dict = {}
                    below = first["goal"] / ceiling < _CERT_TARGET
                    _plan(model_sc, usable, [],
                          # The solver's gap is (bound − plan) ÷ plan, so
                          # certifying the target needs 1/target − 1
                          goal_gap=(1 / _CERT_TARGET - 1) if below else None,
                          goal_nodes=None if below else _POLISH_NODES,
                          beat=first["goal"], info=info, bounds=rb, seed=first.get("plan"))
                    if "alloc" in info:
                        # Better placement. Its goal search ran under a time
                        # limit, so the build searches again with the sloops
                        # fixed — often finding more — starting from its plan
                        use_alloc, use_known, use_seed = info["alloc"], None, info.get("plan")
                    bound = info.get("goal_bound")
                    if bound and bound > 1e-9:
                        ceiling = min(ceiling, bound)
                plan = _plan(model_sc, usable, warnings, sloop_caps=use_alloc, bounds=rb,
                             known=use_known, seed=use_seed)
                if plan is None and use_alloc is not alloc:
                    plan = _plan(model_sc, usable, warnings, sloop_caps=alloc, bounds=rb,
                                 known=first)
                if plan is not None:
                    certified = min(1.0, plan.goal / ceiling)
    if plan is None:
        plan = _plan(model_sc, usable, warnings) if usable else None
        if plan is not None and plan.goal_bound:
            certified = min(1.0, plan.goal / plan.goal_bound) if plan.goal_bound > 1e-9 else None
    if plan is not None and frac_ceiling is None and model_sc.objective:
        frac_ceiling = _fractional_ceiling(model_sc, usable)
    status  = "Optimal" if plan is not None else "Infeasible"
    obj_val = plan.goal if plan is not None else 0.0
    # Warn on the plan's own shortfall, not on a Min New Alts trade
    placed_cert = certified
    if certified is not None and plan.goal_pre and plan.goal > 1e-12:
        placed_cert = min(1.0, certified * plan.goal_pre / plan.goal)
    if placed_cert is not None and placed_cert < _CERT_TARGET - 1e-9:
        warnings.append(f"Plan is certified to reach at least {100 * certified:.1f}% of the "
                        f"best possible — below the {100 * _CERT_TARGET:.0f}% target.")
    elif certified is None and plan is not None and not plan.proven:
        warnings.append("Solver time limit reached — this is the best plan found, "
                        "but it is not proven optimal.")
    elif plan is not None and not plan.lean_proven:
        # The goal is certified, but trimming resources/machines ran out of time
        warnings.append("Resource and machine minimisation hit its time limit — the "
                        "output is as certified, but a leaner plan may exist.")
    elif plan is not None and not plan.clean_proven:
        warnings.append("Recipe cleanup hit its time limit — output and machine space "
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
            has_shard=sh_k > 0,
            has_sloop=sl_k > 0,
            hi_machines=sum(g["count"] for g in layout if g["shards"]),
            layout=layout,
        ))

    # Cap overshoot warnings
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
    # Unlimited resources supply exactly what the plan draws (no leftover shown)
    for item in scenario.unlimited_resources:
        item_supply[item] = max(item_consumed.get(item, 0.0) - item_produced.get(item, 0.0), 0.0)

    all_system = set(item_supply.keys()) | set(item_produced.keys())
    net_items: Dict[str,float] = {}
    source_nodes: Dict[str,float] = {}

    for item in all_system:
        supply   = item_supply.get(item, 0.0)
        produced = item_produced.get(item, 0.0)
        consumed = item_consumed.get(item, 0.0)
        net = supply + produced - consumed
        # Rounding (each flow to 4 places) and the solver's tolerance leave
        # crumbs: under 0.005/min, or a millionth-scale share of what flows,
        # it's nothing — never a "0.00" byproduct
        if abs(net) > max(_CRUMB, 1e-5 * max(supply, produced, consumed)):
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
    # Power (MW, from generators) goes to the grid, never a stray byproduct
    wanted = sink_items | set(scenario.available_resources.keys()) | {POWER_ITEM}
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
    diagnosis = None
    if final_status == "Infeasible" and not error_sources:
        try:
            diagnosis = diagnose(scenario, all_recipes)
        except Exception as e:      # a diagnosis never breaks a solve
            diagnosis = {"error": str(e)}
        names = {k: r.display for k, r in all_recipes.items()}
        conflict_hints.extend(diagnosis_hints(diagnosis, recipe=lambda k: names.get(k, k)) if diagnosis else [])
        if not conflict_hints:
            conflict_hints.append("These goals can't all be met together, and no single shortage explains it — "
                                  "try removing exact amounts one at a time.")

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
        certified=None if certified is None else round(certified, 6),
        power_bound_mw=None if plan is None or plan.power_bound is None else round(plan.power_bound, 2),
        ceiling=None if frac_ceiling is None else round(frac_ceiling, 6),
        usable=usable,
        diagnosis=diagnosis,
    )
    return result


# ── Public helpers ────────────────────────────────────────────────────────────
def analyse(scenario: Scenario, all_recipes: Dict[str, Recipe],
            flows: List[dict], usable: Optional[Dict[str, Recipe]] = None,
            plan_goal: Optional[float] = None) -> dict:
    """
    What limits the plan — for the Analysis window. Runs on the continuous
    relaxation of the planning model (fractional machines; shards, the machine
    cap and every budget included) with the plan's somersloops held where the
    plan put them, and with any new alt the plan chose not to use left out.
    One warm model; every number is a few LP solves.

      shadow_prices[r]     goal gained per extra unit/min of resource r
      saturation_points[r] supply of r beyond which more r stops helping —
                           exact: the least r that reaches the best goal with r
                           unlimited (None when more r never stops helping)
      limits[b]            goal gained per extra power shard / MW of power cap
    (Which alternates to unlock: suggest_alts.)
    """
    if usable is None:
        usable, _ = prune_recipes(scenario, all_recipes)
    out = {"shadow_prices": {}, "saturation_points": {}, "limits": {}}
    if not usable:
        return out
    sc = _with_unlimited(scenario)
    lp = _Model(sc, usable, integer=False)
    used = {f["recipe_key"]: f for f in flows}
    # The plan's somersloops stay where the plan put them
    for k, levels in lp.levels.items():
        expr = {("n", k, l): float(l) for l in levels if l}
        if expr:
            lp.ct(-lp.inf, float(used.get(k, {}).get("sloops_used", 0)), expr)
    # New alts the plan passed on (Min New Alts) stay out
    for k in lp.new_alt_recipes:
        if k not in used:
            for l in lp.levels[k]:
                lp.var[("q", k, l)].SetUb(0.0)

    unlimited = set(scenario.unlimited_resources)
    finite = [it for it, v in sc.available_resources.items()
              if v > 0 and it not in unlimited and it in lp.res_ct]
    T = _STAGE_TIME_S[0]
    goal_best = None
    if lp.goal:
        if lp.run(lp.goal, True, T) is None:
            return out
        goal_best = lp.value(lp.goal)
        def price(ct) -> float:
            try:
                return round(max(0.0, ct.dual_value()), 6)
            except Exception:
                return 0.0
        for it in finite:
            out["shadow_prices"][it] = price(lp.res_ct[it])
        for name, ct in lp.budget_ct.items():
            if name != "sloops":    # sloops are held where the plan put them
                out["limits"][name] = price(ct)
        for it in finite:
            if out["shadow_prices"][it] < 1e-4:
                out["saturation_points"][it] = None
                continue
            ct = lp.res_ct[it]
            ub = ct.ub()
            ct.SetUb(lp.inf)
            sat = None
            if lp.run(lp.goal, True, T) is not None:
                g = lp.value(lp.goal)
                g_ct = lp.ct(g - max(1e-9, abs(g) * 1e-9), lp.inf, lp.goal)
                use = {key: -c for key, c in lp.net[it].items()}
                if lp.run(use, False, T) is not None:
                    sat = round(lp.value(use), 2)
                g_ct.SetBounds(-lp.inf, lp.inf)
            ct.SetUb(ub)
            out["saturation_points"][it] = sat

    return out


# ── Alternates worth unlocking ────────────────────────────────────────────────
# The best plan with every alternate you haven't unlocked, in the analysis
# model (machines fractional), against the plan with none of them: the ones it
# uses, in the order to unlock them — each the one that adds most on top of
# those before it — with what each adds:
#   output     more of the goal with your supply and limits (% of now)
#   resources  less of your resources for the same output (%, supply uncapped)
#   machines   less machine space for that output, using no more of your
#              resources than now (Smelter units)
# An alternate the factory has turned on but you haven't unlocked counts as
# new: the baseline is your unlocked ones only.
_SUGGEST_MAX = 12
_GAIN = {"output": 0.1, "resources": 0.1, "machines": 0.5}   # less than this adds nothing

def suggest_alts(scenario: Scenario, all_recipes: Dict[str, Recipe]) -> dict:
    """{"all": {output, resources, machines} with every one on,
        "steps": [{key, output, resources, machines}] — in unlock order, each
        what it adds to the ones above (as % of now / space units),
        "on": [keys among them this factory has turned on]}"""
    out: dict = {"all": None, "steps": [], "on": []}
    unlocked = set(scenario.unlocked_alt_recipes)
    new = {k for k, r in all_recipes.items() if r.alternate and k not in unlocked}
    if not new:
        return out
    sc = _with_unlimited(_dc_replace(scenario, minimize_new_alts=False,
                                     alternate_recipes_enabled=sorted(set(scenario.alternate_recipes_enabled) | new)))
    usable, _ = prune_recipes(sc, all_recipes)
    cand = sorted(k for k in usable if k in new)
    if not cand:
        return out
    lp = _Model(sc, usable, integer=False)
    T = _STAGE_TIME_S[0]
    cols = {k: [lp.var[("q", k, l)] for l in lp.levels[k]] for k in cand}

    def only(on) -> None:
        for k, vs in cols.items():
            for v in vs:
                v.SetUb(lp.inf if k in on else 0.0)

    unlimited = set(scenario.unlimited_resources)
    finite = [it for it, v in sc.available_resources.items() if v > 0 and it not in unlimited and it in lp.res_ct]
    score: Dict[Key, float] = {}
    for it in finite:
        w = 1.0 / len(finite) / sc.available_resources[it]
        for key, c in lp.net.get(it, {}).items():
            score[key] = score.get(key, 0.0) - c * w
    caps = [lp.res_ct[it] for it in sc.available_resources if it in lp.res_ct]
    if "power" in lp.budget_ct:
        caps.append(lp.budget_ct["power"])

    def goal_now() -> Optional[float]:
        return lp.value(lp.goal) if lp.run(lp.goal, True, T) is not None else None

    def cost_now(target, within=None):
        """(least resource score, least space using no more resources than
        `within` — or than the least), for the target output, caps lifted;
        and the candidates that plan runs."""
        ubs = [ct.ub() for ct in caps]
        for ct in caps:
            ct.SetUb(lp.inf)
        held = lp.ct(target - max(1e-9, abs(target) * 1e-7), lp.inf, lp.goal) if lp.goal and target is not None else None
        try:
            r, lock = 0.0, None
            if score:
                if lp.run(score, False, T) is None:
                    return None
                r = lp.value(score)
                bound = r if within is None else max(r, within)
                lock = lp.ct(-lp.inf, bound + abs(bound) * 1e-7 + 1e-9, score)
            got = None
            if lp.run(lp.space, False, T) is not None:
                runs = {k for k, vs in cols.items() if any(v.solution_value() > 1e-6 for v in vs)}
                got = (r, lp.value(lp.space), runs)
            if lock is not None:
                lock.SetBounds(-lp.inf, lp.inf)
            return got
        finally:
            if held is not None:
                held.SetBounds(-lp.inf, lp.inf)
            for ct, ub in zip(caps, ubs):
                ct.SetUb(ub)

    only(set())
    g0 = goal_now() if lp.goal else None
    if lp.goal and g0 is None:
        return out                      # it can't be made without them: the diagnosis says which
    c0 = cost_now(g0)
    if c0 is None:
        return out

    def value(on) -> Optional[dict]:
        """What these on add to the plan with none: output, resources, space."""
        only(on)
        m = {"output": 0.0, "resources": 0.0, "machines": 0.0}
        if lp.goal and g0:
            g = goal_now()
            if g is None:
                return None
            m["output"] = 100.0 * (g - g0) / abs(g0)
        c = cost_now(g0, within=c0[0])
        if c is None:
            return None
        m["resources"] = 100.0 * (c0[0] - c[0]) / c0[0] if c0[0] > 1e-12 else 0.0
        m["machines"] = c0[1] - c[1]
        m["runs"] = c[2]
        return m

    best = value(set(cand))
    if best is None:
        return out
    # The best plan's own: what it runs at its best output (more output first)
    used = set()
    if lp.goal and g0:
        only(set(cand))
        g = goal_now()
        if g is not None:
            c = cost_now(g)
            used = c[2] if c else set()
    used |= best["runs"]
    if not used:
        return out
    rnd = lambda m: {k: round(m[k], 2 if k != "machines" else 1) for k in ("output", "resources", "machines")}
    out["all"] = rnd(best)
    chosen, now = [], {"output": 0.0, "resources": 0.0, "machines": 0.0}
    # the next to unlock: most output added, then resources, then space —
    # a gain too small to count (_GAIN) counts as none
    key3 = lambda m: tuple((lambda a: a if a > _GAIN[d] else 0.0)(m[d] - now[d]) for d in ("output", "resources", "machines"))
    left = set(used)
    while left and len(chosen) < _SUGGEST_MAX:
        best_k, best_m = None, None
        for k in sorted(left):
            m = value(set(chosen) | {k})
            if m is not None and (best_m is None or key3(m) > key3(best_m)):
                best_k, best_m = k, m
        if best_k is None:
            break
        add = {d: best_m[d] - now[d] for d in now}
        if not any(add[d] > _GAIN[d] for d in now):
            break                       # the rest add nothing on top of these
        chosen.append(best_k)
        left.discard(best_k)
        out["steps"].append({"key": best_k, **rnd(add)})
        now = {d: best_m[d] for d in now}
    out["on"] = sorted(k for k in chosen if k in set(scenario.alternate_recipes_enabled))
    return out


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
    return {
        "scenario_name":         scenario.name,
        "status":                result.status,
        "objective_value":       result.objective_value,
        "total_power_mw":        result.total_power_mw,
        "max_power_mw":          scenario.max_power_mw,
        "total_machines":        result.total_machines,
        # Room the machines take (Σ machines × w·l·h), what the planner minimises
        "total_space":           sum(f.machines_final * machine_space(machine_meta, f.machine)
                                     for f in result.flows),
        "shards_used":           result.shards_used,
        "sloops_used":           result.sloops_used,
        "warnings":              result.warnings,
        "conflict_hints":        result.conflict_hints,
        "diagnosis":             result.diagnosis,
        "error_sources":         result.error_sources,
        "error_sinks":           result.error_sinks,
        "surplus_intermediates": result.surplus_intermediates,
        "cap_overshoot":         result.cap_overshoot,
        "certified_pct":         None if result.certified is None else round(100 * result.certified, 2),
        # the plan against the fractional ceiling (whole machines, shards, sloops relaxed)
        "ceiling":               result.ceiling,
        "ceiling_pct":           (None if not result.ceiling or result.ceiling <= 1e-9
                                  else round(min(100.0, 100 * result.objective_value / result.ceiling), 2)),
        "unlimited_resources":   list(scenario.unlimited_resources),
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
