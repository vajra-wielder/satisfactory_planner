"""
network.py — plan several factories together, joined by paths.

Each factory keeps its own node supply, its own enabled recipes and machines,
and the goal outputs its current plan makes. Routes join factories by train,
truck, tractor or drone, each with its round trip time. One continuous model of the whole
network (fractional machines — a planning view; each factory is then solved
on its own for its exact build) decides which recipe runs where and what
crosses each path, in stages, each locked before the next. A path is a line of
stops one vehicle runs (A→B→C and back), or a loop (A→B→C→D→A): any stop can
load for any other, and what it keeps busy is its heaviest leg.

  1. least resources — every factory's draw over its own supply, averaged,
     so a scarce resource costs more than an abundant one (held within
     _RES_SLACK, so fractional machines alone don't force a rebuild)
  2. least transport — each route's load in what moving it takes: freight
     cars, trucks, tractors or drones for its round trip (stack sizes decide
     how much fits; fluids go by fluid car, or packaged)
  3. least change — each solved factory as close to its own plan as it can
     stay, so only what improves 1 or 2 moves (equal options don't churn)
  4. least machine space

What a factory declared as supplied but isn't mined (an import standing in for
another factory) has to come over a route — unless no factory in the network
can make it, then it stays an outside supply. A factory's own goals are made in
it: they're never shipped to it.

Headroom, per factory with a goal: the most of it the network could make with
every other factory's outputs held, less what it makes now — what the
network's leftover resources are worth to it.
"""
from typing import Dict, List, Optional

from ortools.linear_solver import pywraplp

from solver import Recipe, Scenario, _load_raw_yaml, machine_space
import supply

_RAW = _load_raw_yaml()
FLUIDS = set(_RAW.get("fluids") or [])
NODE = set(_RAW.get("node_resources") or [])
STACK = dict(_RAW.get("stack_sizes") or {})
VEHICLES = dict(_RAW.get("vehicles") or {})
META = dict(_RAW.get("machine_meta") or {})
TRANSPORT = dict(_RAW.get("transport") or {})

_SHOW = 0.01      # flows and recipes below this (per min / machines) are numeric dust
_SHOW_FLOW = 0.05 # a shipment below this per min is not worth a car
_RES_SLACK = 0.002   # stage 1 is held within 0.2% of its best


def _allowed(sc: Scenario, recipes: Dict[str, Recipe], own: Dict[str, float]) -> Dict[str, Recipe]:
    """Recipes a factory may run in the network: its machines and alternates —
    with Min New Alts on, only alternates you've unlocked or its plan uses."""
    machines = set(sc.enabled_machines)
    alts = set(sc.alternate_recipes_enabled) | set(sc.unlocked_alt_recipes)
    if sc.minimize_new_alts:
        alts = set(sc.unlocked_alt_recipes) | {k for k in own if k in recipes and recipes[k].alternate}
    return {k: r for k, r in recipes.items()
            if (not machines or r.machine in machines) and (not r.alternate or k in alts)}


def _unit_cost(item: str, route: dict) -> Optional[float]:
    """What 1 item (or m³) per minute costs on this route: the vehicles (or
    freight cars) it keeps busy — one load per round trip. None = this route
    can't carry it (fluids by truck, tractor or drone, unpackaged)."""
    mode, trip = route.get("mode", "train"), max(float(route.get("trip_min") or 1.0), 0.05)
    fluid = item in FLUIDS
    v = VEHICLES.get(mode) or VEHICLES["train"]
    if fluid:
        return trip / v["fluid"] if v.get("fluid") else None
    return trip / (v.get("stacks", 32) * STACK.get(item, 100))


def stops(rt: dict) -> List[str]:
    """A path's stops in order: [a, b] for a plain route."""
    return list(rt.get("stops") or [rt.get("a"), rt.get("b")])


def legs(rt: dict) -> List[tuple]:
    """The legs a path's vehicles run, each one way: round a loop (A→B→C→A),
    or out and back along a line (A→B→C→B→A). Two stops: there and back."""
    st = stops(rt)
    fwd = list(zip(st, st[1:]))
    if rt.get("loop") and len(st) > 2:
        return fwd + [(st[-1], st[0])]
    return fwd + [(b, a) for a, b in reversed(fwd)]


def _hops(rt: dict, src: str, dst: str) -> List[int]:
    """Which legs (indices into legs(rt)) a load from src to dst rides."""
    st, L = stops(rt), legs(rt)
    i, j = st.index(src), st.index(dst)
    if rt.get("loop") and len(st) > 2:
        n = len(st)
        return [(i + k) % n for k in range((j - i) % n)]
    n = len(st) - 1                       # legs[0:n] go forward, legs[n:] come back
    return list(range(i, j)) if j > i else [n + (n - 1 - k) for k in range(i - 1, j - 1, -1)]


class _Net:
    """One LP of the network. held: per factory, outputs it must still make."""

    def __init__(self, sites: List[dict], routes: List[dict], recipes: Dict[str, Recipe], free_goal=None,
                 allow=None, nearby=None):
        """allow: the (from, to, item) that may cross (None: anything a route can
        carry); nearby: {factory: {resource: /min}} more it could mine nearby."""
        self.s = s = pywraplp.Solver.CreateSolver("GLOP")
        inf = s.infinity()
        self.keys = keys = [x["key"] for x in sites]
        self.by = by = {x["key"]: x for x in sites}
        self.allowed = allowed = {k: _allowed(by[k]["scenario"], recipes, by[k]["own"]) for k in keys}
        makeable = {it for k in keys for r in allowed[k].values() for it in r.outputs}
        self.q = q = {(k, rk): s.NumVar(0, inf, "") for k in keys for rk in allowed[k]}

        # Arcs from every stop of a path to every other, for items the source
        # can have and the target can use
        self.arcs = arcs = []          # (route index, src, dst, item, var, unit cost)
        for ri, rt in enumerate(routes):
            st = stops(rt)
            for src, dst in ((x, y) for x in st for y in st if x != y):
                if src not in by or dst not in by:
                    continue
                have = {it for r in allowed[src].values() for it in r.outputs} | \
                       set(by[src]["scenario"].available_resources)
                use = {it for r in allowed[dst].values() for it in r.inputs} | set(by[dst]["held"])
                # a factory's goals are made in it: never shipped to it from another
                dsc = by[dst]["scenario"]
                own_goals = set(dsc.objective) | set(dsc.must_produce) | set(dsc.min_produce)
                for it in sorted((have & use) - own_goals):
                    if allow is not None and (src, dst, it) not in allow:
                        continue
                    c = _unit_cost(it, rt)
                    if c is not None:
                        arcs.append((ri, src, dst, it, s.NumVar(0, inf, ""), c))

        # Per factory and item: net (made + brought − sent) ≥ what must stay
        self.net: Dict[tuple, Dict[object, float]] = {}
        # what it makes of an item, whether it keeps it or ships it on (its goals
        # count this: a modular factory makes its goal to send it out)
        self.made: Dict[tuple, Dict[object, float]] = {}
        self.draw: Dict[tuple, object] = {}
        self.near: Dict[tuple, object] = {}       # (factory, resource) → what it takes from nodes nearby
        nearby = nearby or {}
        for k in keys:
            sc = by[k]["scenario"]
            unlimited = set(sc.unlimited_resources)
            held = by[k]["held"]
            if k == free_goal or (isinstance(free_goal, set) and k in free_goal):   # its goal items are what's being maximised
                held = {it: r for it, r in held.items() if it not in sc.objective}
            items = {it for r in allowed[k].values() for it in (*r.inputs, *r.outputs)} \
                | set(sc.available_resources) | set(by[k]["held"]) | set(nearby.get(k) or {})
            for it in items:
                expr: Dict[object, float] = {}
                for rk, r in allowed[k].items():
                    c = r.outputs.get(it, 0.0) - r.inputs.get(it, 0.0)
                    if c:
                        expr[q[(k, rk)]] = c
                self.made[(k, it)] = dict(expr)
                for (_, a, b, i2, v, _c) in arcs:
                    if i2 == it and b == k:
                        expr[v] = expr.get(v, 0.0) + 1.0
                    elif i2 == it and a == k:
                        expr[v] = expr.get(v, 0.0) - 1.0
                self.net[(k, it)] = expr
                h = held.get(it, 0.0)        # a plan's rates are rounded: held a hair under
                ct = s.Constraint(h - 1e-5 * abs(h), inf)
                for v, c in expr.items():
                    ct.SetCoefficient(v, c)
                supply = float(sc.available_resources.get(it, 0.0) or 0.0)
                if it in unlimited:
                    ct.SetLb(-inf)
                elif supply > 0 and (it in NODE or it not in makeable):
                    u = self.draw[(k, it)] = s.NumVar(0, supply, "")   # from its own supply
                    ct.SetCoefficient(u, 1.0)
                cap = float((nearby.get(k) or {}).get(it, 0.0) or 0.0)
                if cap > 0 and it not in unlimited:
                    u = self.near[(k, it)] = s.NumVar(0, cap, "")      # from free nodes nearby
                    ct.SetCoefficient(u, 1.0)

    def run(self, obj: Dict[object, float], maximize: bool = False) -> bool:
        o = self.s.Objective()
        o.Clear()
        for v, c in obj.items():
            o.SetCoefficient(v, o.GetCoefficient(v) + c)
        o.SetMaximization() if maximize else o.SetMinimization()
        return self.s.Solve() in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE)

    def lock(self, obj: Dict[object, float], value: float) -> None:
        # held a little loose: a stage after must still find the last one's optimum
        ct = self.s.Constraint(-self.s.infinity(), value + abs(value) * 1e-5 + 1e-6)
        for v, c in obj.items():
            ct.SetCoefficient(v, ct.GetCoefficient(v) + c)

    def value(self, obj: Dict[object, float]) -> float:
        return sum(c * v.solution_value() for v, c in obj.items())

    def ct_ge(self, expr: Dict[object, float], lo: float) -> None:
        ct = self.s.Constraint(lo, self.s.infinity())
        for v, c in expr.items():
            ct.SetCoefficient(v, c)

    def goal_of(self, k: str) -> Dict[object, float]:
        """Factory k's weighted goal: what it makes of its goal items (kept or shipped)."""
        g: Dict[object, float] = {}
        for it, w in self.by[k]["scenario"].objective.items():
            for v, c in self.made.get((k, it), {}).items():
                g[v] = g.get(v, 0.0) + w * c
        return g


def _made_now(x: dict) -> dict:
    """What its plan makes now, shipped or kept (held is what it keeps)."""
    return x.get("made") or x["held"]

def _now_goal(x: dict) -> float:
    return sum(w * _made_now(x).get(it, 0.0) for it, w in x["scenario"].objective.items())


def _grow(m: "_Net", sites: List[dict], floor=None) -> Optional[float]:
    """Raise every goal together: the largest t with each goal item of every
    factory (each on its own — a factory after Power and Computers keeps its
    Computers) made at least t × what it makes now, so none is traded for
    another; then — t held — the most of every one on top, each as a share of
    its own. Returns t, or None when nothing has a goal to grow.
    floor: {(factory, item): /min} — instead of t, each goal item at least that
    (comparing an option: no goal below what it is anyway)."""
    # (a goal it makes none of yet — a new factory waiting on its imports — grows
    # from nothing, each per minute counted as one)
    items = [(x["key"], it, _made_now(x).get(it, 0.0)) for x in sites for it in x["scenario"].objective]
    if not items:
        return None
    if floor is not None:
        for k, it, now in items:
            lo = floor.get((k, it), 0.0) * (1 - 1e-5)
            if lo > 0:
                m.ct_ge(m.made.get((k, it), {}), lo)
        best = 1.0
    else:
        t = m.s.NumVar(0, m.s.infinity(), "")
        for k, it, now in items:
            ct = m.s.Constraint(0, m.s.infinity())          # made − t·now ≥ 0
            for v, c in m.made.get((k, it), {}).items():
                ct.SetCoefficient(v, c)
            ct.SetCoefficient(t, -now)
        if not m.run({t: 1.0}, maximize=True):
            return None
        best = t.solution_value()
        t.SetLb(best * (1 - 1e-5))
    share: Dict[object, float] = {}
    for k, it, now in items:
        for v, c in m.made.get((k, it), {}).items():
            share[v] = share.get(v, 0.0) + c / max(now, 1.0)
    if m.run(share, maximize=True):
        m.lock({v: -c for v, c in share.items()}, -m.value(share))
    return best


def plan_network(sites: List[dict], routes: List[dict], recipes: Dict[str, Recipe], grow: bool = False,
                 allow=None, nearby=None, headroom: bool = True, floor=None) -> dict:
    """sites: [{key, name, scenario: Scenario, held: {item: rate},
    own: {recipe: machine-equivalents}, own_draw: {item: rate}}];
    routes: [{a, b, mode, trip_min}]. grow: raise every goal together first
    (see _grow) — the factories' goals, not only their current outputs.
    allow: only these (from, to, item) may cross; nearby: {factory: {resource:
    /min}} it could also mine from free nodes nearby (each counted as a
    resource, like its own); headroom: also each goal's most on its own."""
    goals = {x["key"] for x in sites if x["scenario"].objective} if grow else None
    m = _Net(sites, routes, recipes, free_goal=goals, allow=allow, nearby=nearby)
    t = _grow(m, sites, floor) if grow else None
    if grow and t is None:
        return {"ok": False, "error": "No factory here has a goal it makes yet — solve them first."}
    supply = {key: float(m.by[key[0]]["scenario"].available_resources[key[1]]) for key in m.draw}
    n_res = max(1, len(m.draw) + len(m.near))
    res_obj = {u: 100.0 / supply[key] / n_res for key, u in m.draw.items()}
    for key, u in m.near.items():      # a node nearby costs like its own: a share of what's there
        res_obj[u] = 100.0 / max(1e-9, u.ub()) / n_res
    if not m.run(res_obj):
        return {"ok": False, "error": "The network can't make every factory's current outputs."}
    score = m.value(res_obj)
    m.lock(res_obj, score * (1 + _RES_SLACK))
    # A vehicle carries a load each way on one round trip: a route keeps busy
    # what its heavier way needs — freight and fluid cars counted apart — so
    # what goes back the other way rides along. A sliver on every arc keeps
    # nothing moving that needn't.
    inf = m.s.infinity()
    ways: Dict[tuple, Dict[object, float]] = {}        # (path, kind, leg) → its loads
    for (ri, a, b, it, v, c) in m.arcs:
        for h in _hops(routes[ri], a, b):
            ways.setdefault((ri, "fluid" if it in FLUIDS else "solid", h), {})[v] = c
    busy: Dict[tuple, object] = {}
    for (ri, kind, _a), terms in ways.items():
        L = busy.get((ri, kind)) or m.s.NumVar(0, inf, "")
        busy[(ri, kind)] = L
        ct = m.s.Constraint(0, inf)                  # L ≥ this way's loads
        ct.SetCoefficient(L, 1.0)
        for v, c in terms.items():
            ct.SetCoefficient(v, -c)
    move_obj = {L: 1.0 for L in busy.values()}
    for (_, _, _, _, v, c) in m.arcs:
        move_obj[v] = move_obj.get(v, 0.0) + 1e-3 * c
    if not m.run(move_obj):
        return {"ok": False, "error": "The network plan didn't settle (numerics) — try again with fewer routes."}
    m.lock(move_obj, m.value(move_obj))
    # Least change from each solved factory's own plan: |q − own| per recipe
    change: Dict[object, float] = {}
    inf = m.s.infinity()
    for k in m.keys:
        own = m.by[k]["own"]
        if not own:
            continue
        for rk in m.allowed[k]:
            d = m.s.NumVar(0, inf, "")
            q, o = m.q[(k, rk)], own.get(rk, 0.0)
            for sign in (1.0, -1.0):          # d ≥ ±(q − own)
                ct = m.s.Constraint(-sign * o, inf)
                ct.SetCoefficient(d, 1.0)
                ct.SetCoefficient(q, -sign)
            change[d] = 1.0
    if change and m.run(change):
        m.lock(change, m.value(change))
    if not m.run({m.q[(k, rk)]: float(machine_space(META, r.machine))
                  for k in m.keys for rk, r in m.allowed[k].items()}):
        m.run(move_obj)                   # (a failed solve leaves no plan: the last one back)

    out = {"ok": True, "resource_score": round(score, 3), "factories": [], "routes": [],
           "grow": None if t is None else round(t, 4)}
    for k in m.keys:
        ran = {rk: m.q[(k, rk)].solution_value() for rk in m.allowed[k]}
        ran = {rk: v for rk, v in ran.items() if v > _SHOW}
        own = m.by[k]["own"]
        moved = {"added": {}, "dropped": {}, "changed": {}}
        for rk in sorted(set(ran) | set(own)):
            a, b = own.get(rk, 0.0), ran.get(rk, 0.0)
            if a < _SHOW and b > _SHOW:
                moved["added"][rk] = round(b, 3)
            elif b < _SHOW and a > _SHOW:
                moved["dropped"][rk] = round(a, 3)
            elif abs(a - b) > max(1e-3, 0.01 * a):
                moved["changed"][rk] = [round(a, 3), round(b, 3)]
        res = {it: {"supply": round(supply[(kk, it)], 3), "used": round(u.solution_value(), 3),
                    "before": round(m.by[k]["own_draw"].get(it, 0.0), 3)}
               for (kk, it), u in m.draw.items() if kk == k}
        near = {it: round(u.solution_value(), 3) for (kk, it), u in m.near.items() if kk == k and u.solution_value() > _SHOW}
        sc = m.by[k]["scenario"]
        goal = None
        if sc.objective:
            items = {it: round(m.value(m.made.get((k, it), {})), 3) for it in sc.objective}
            goal = {it: {"now": round(_made_now(m.by[k]).get(it, 0.0), 3), "then": v} for it, v in items.items()}
        out["factories"].append({"key": k, "name": m.by[k]["name"], "recipes": moved, "resources": res, "goal": goal,
                                 "nearby": near})
    for ri, rt in enumerate(routes):
        items, each = [], {}
        for (r2, a, b, it, v, c) in m.arcs:
            x = v.solution_value()
            if r2 == ri and x > _SHOW_FLOW:
                kind = "fluid" if it in FLUIDS else "solid"
                items.append({"item": it, "from": a, "to": b, "rate": round(x, 3),
                              "stacks": None if it in FLUIDS else round(x / STACK.get(it, 100), 3),
                              "load": round(x * c, 4)})
                for h in _hops(rt, a, b):
                    each[(kind, h)] = each.get((kind, h), 0.0) + x * c
        # vehicles busy: the heaviest leg, per kind of car
        cars = {kind: round(max([v for (k2, _h), v in each.items() if k2 == kind] or [0.0]), 4) for kind in ("solid", "fluid")}
        load = cars["solid"] + cars["fluid"]
        out["routes"].append({**rt, "items": items, "load": round(load, 4), "cars": cars,
                              "legs": [{"from": a, "to": b, "load": round(sum(v for (_k, h2), v in each.items() if h2 == h), 4)}
                                       for h, (a, b) in enumerate(legs(rt))],
                              "throughput": round(sum(i["rate"] for i in items), 3),
                              "stacks": round(sum(i["stacks"] or 0 for i in items), 3)})
    out["throughput"] = round(sum(r["throughput"] for r in out["routes"]), 3)
    out["stacks"] = round(sum(r["stacks"] for r in out["routes"]), 3)

    # Headroom: each goal factory's most, with every other factory still making
    # its goals (shipped on or kept — what it ships is the network's to place)
    out["headroom"] = {}
    goal_keys = {y["key"] for y in sites if y["scenario"].objective}
    for x in (sites if headroom else []):
        sc = x["scenario"]
        if not sc.objective:
            continue
        h = _Net(sites, routes, recipes, free_goal=goal_keys)
        for y in sites:
            if y["key"] != x["key"] and y["key"] in goal_keys:
                for it, r in _made_now(y).items():
                    if it in y["scenario"].objective and (y["key"], it) in h.made:
                        h.ct_ge(h.made[(y["key"], it)], r * (1 - 1e-6))
        goal = h.goal_of(x["key"])
        if goal and h.run(goal, maximize=True):
            now = _now_goal(x)
            most = h.value(goal)
            if len(sc.objective) == 1:        # one goal item: say it in items per minute
                w = next(iter(sc.objective.values())) or 1.0
                now, most, unit = now / w, most / w, "per_min"
            else:
                unit = "score"                # several weighted items: the goal's own score
            out["headroom"][x["key"]] = {"items": list(sc.objective), "unit": unit,
                                         "now": round(now, 3), "most": round(most, 3)}
    return out


# ── Each factory from outside ─────────────────────────────────────────────────
# what each saved factory takes in and sends out, for the
# Blackboard's factory planner.
#
# A saved scenario is a whole factory. Seen from outside it is a black box:
#   imports  parts and fluids it is supplied with that aren't mined from nodes
#            (at the rate its last plan actually draws them)
#   exports  its goal items, and surplus byproducts another factory could use
#            (at the rates its last plan makes them)
# Node resources (ore, crude, water…) are the factory's own supply and stay
# inside the box.

def factory_io(scenario: dict, result: Optional[dict]) -> dict:
    """{imports, exports, surplus, spare, solved}: item → rate per minute
    (spare: what its own nodes give that its plan doesn't use).
    Without a plan, the scenario's own declared numbers stand in."""
    supplied = {k: v for k, v in supply.available(scenario).items() if v > 0}
    goals = (set(scenario.get("objective") or {}) | set(scenario.get("must_produce") or {})
             | set(scenario.get("min_produce") or {}))
    if result is None or not str(result.get("status", "")).startswith("Optimal"):
        return {
            "solved": False,
            "imports": {k: round(v, 3) for k, v in supplied.items() if k not in NODE},
            # objective items have no rate until solved ("max")
            "exports": {**{k: None for k in (scenario.get("objective") or {})},
                        **{k: round(float(v), 3) for k, v in
                           {**(scenario.get("min_produce") or {}), **(scenario.get("must_produce") or {})}.items()}},
            "surplus": {},
            "spare": {},
        }
    drawn: Dict[str, float] = {}
    for f in result.get("flows", []):
        for it, q in (f.get("inputs") or {}).items():
            drawn[it] = drawn.get(it, 0.0) + q
        for it, q in (f.get("outputs") or {}).items():
            drawn[it] = drawn.get(it, 0.0) - q
    imports = {k: round(drawn[k], 3) for k in supplied
               if k not in NODE and drawn.get(k, 0.0) > 1e-4}
    spare = spare_supply(scenario, result)
    exports = {k: round(v, 3) for k, v in (result.get("sink_nodes") or {}).items()
               if k in goals and v > 1e-4}
    surplus = {k: round(v, 3) for k, v in {**(result.get("surplus_intermediates") or {}),
                                           **(result.get("error_sinks") or {})}.items()
               if v > 1e-4 and k not in exports}
    return {"solved": True, "imports": imports, "exports": exports, "surplus": surplus, "spare": spare}


def spare_supply(scenario: dict, result: dict) -> Dict[str, float]:
    """What a factory's own nodes give that its plan doesn't use, per minute —
    free for a factory nearby to take. Imports and unlimited resources aren't
    counted (an import left over goes back to where it came from)."""
    own = supply.available({**scenario, "from_factories": []}) if scenario.get("resource_nodes") is not None \
        else {k: float(v or 0) for k, v in (scenario.get("available_resources") or {}).items()
              if k not in {f.get("item") for f in scenario.get("from_factories") or []}}
    unlimited = set(scenario.get("unlimited_resources") or [])
    used = drawn(result)
    out = {}
    for k, v in own.items():
        if k not in NODE or k in unlimited or v <= 0:   # only what's mined or pumped
            continue
        left = v - used.get(k, 0.0)
        if left > max(0.005, v * 1e-5):          # not a rounding crumb (solver._CRUMB)
            out[k] = round(left, 3)
    return out


def made(result: dict) -> Dict[str, float]:
    """Everything a plan puts out, per minute: its goal outputs and its surplus."""
    out = {k: v for k, v in (result.get("sink_nodes") or {}).items() if v > 1e-4}
    for k, v in {**(result.get("surplus_intermediates") or {}), **(result.get("error_sinks") or {})}.items():
        if v > 1e-4 and k not in out:
            out[k] = v
    return out


def drawn(result: dict) -> Dict[str, float]:
    """What a plan uses of each item net of what it makes, per minute (> 0 only)."""
    out: Dict[str, float] = {}
    for f in result.get("flows", []):
        for it, q in (f.get("inputs") or {}).items():
            out[it] = out.get(it, 0.0) + q
        for it, q in (f.get("outputs") or {}).items():
            out[it] = out.get(it, 0.0) - q
    return {k: v for k, v in out.items() if v > 1e-6}


# ── Comparing trades ─────────────────────────────────────────────────────────
# "Should Rex Roar bring in Quickwire for its computers, or send its Plastic
# over to the factory that makes it?" Each trade a route could carry is tried
# on its own, on top of what the factories already send each other: how much
# every goal could rise together (grow), and — goals held where they are —
# what each factory then needs of its resources, against now (what it frees).
# All of them together is the network plan. Ranked by the rise, then by what
# it frees.

def _summary(g: dict, h: dict) -> dict:
    flows = [{"from": i["from"], "to": i["to"], "item": i["item"], "rate": i["rate"]}
             for rt in (g.get("routes") or []) for i in rt["items"]]
    cars = [{"stops": stops(rt), "loop": bool(rt.get("loop")), "mode": rt["mode"], "trip_min": rt["trip_min"],
             "cars": rt["cars"], "load": rt["load"]} for rt in (g.get("routes") or []) if rt["items"]]
    return {"ok": bool(g.get("ok") and h.get("ok")), "grow": g.get("grow"), "flows": flows, "routes": cars,
            "goals": {f["key"]: f.get("goal") for f in g.get("factories", []) if f.get("goal")},
            "nearby": {f["key"]: f["nearby"] for f in g.get("factories", []) if f.get("nearby")},
            "used": {f["key"]: {it: x["used"] for it, x in f["resources"].items()} for f in h.get("factories", [])},
            "score_held": h.get("resource_score"),
            "held_nearby": {f["key"]: f["nearby"] for f in h.get("factories", []) if f.get("nearby")},
            "error": g.get("error") or h.get("error")}


def compare_trades(sites: List[dict], routes: List[dict], recipes: Dict[str, Recipe], declared,
                   nearby=None, most: int = 40) -> dict:
    """declared: the (from, to, item) the factories already send each other.
    {now, all, trades: [{from, to, item, …summary}]}, each summary: grow (every
    goal × this), goals {factory: {item: {now, then}}}, freed {factory:
    {resource: /min less than now, goals held}}, routes (the vehicles busy),
    nearby (what it takes from free nodes nearby, when offered)."""
    declared = {tuple(d) for d in declared}
    probe = _Net(sites, routes, recipes)
    # a trade worth trying: something the receiving factory's plan makes or uses
    # today — or the sending factory's own goal, made to be shipped on
    touch = {x["key"]: {it for rk in x["own"] if rk in recipes for it in (*recipes[rk].inputs, *recipes[rk].outputs)}
             for x in sites}
    goals = {x["key"]: set(x["scenario"].objective) for x in sites}
    cands = sorted({(a, b, it) for (_, a, b, it, _, _) in probe.arcs
                    if (a, b, it) not in declared and (it in touch.get(b, ()) or it in goals.get(a, ()))})

    def run(allow, floor=None):
        g = plan_network(sites, routes, recipes, grow=True, allow=allow, nearby=nearby, headroom=False, floor=floor)
        h = plan_network(sites, routes, recipes, grow=False, allow=allow, nearby=nearby, headroom=False)
        return _summary(g, h)

    now = run(set(declared))
    # an option keeps every goal at least where it is now; what it adds is on top
    floor = {(k, it): g["then"] for k, gs in now["goals"].items() for it, g in gs.items()}
    best = run(None, floor)
    import threading
    out: Dict[tuple, dict] = {}
    def work(cs):
        for c in cs:
            out[c] = run(set(declared) | {c}, floor)
    ts = [threading.Thread(target=work, args=(cands[i::4],)) for i in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()

    # against the network as it is (the same model, today's trades only) — not
    # the saved plans, whose whole machines make every option look like a gain
    def compare(sm):
        f = {}
        for k, used in sm["used"].items():
            base = now["used"].get(k, {})
            # a real saving, not the slack the later stages may shift (past 2%)
            d = {it: round(base.get(it, 0.0) - v, 3) for it, v in used.items()
                 if base.get(it, 0.0) - v > max(1.0, 0.02 * base.get(it, 0.0))}
            if d:
                f[k] = d
        sm["freed"] = f
        gain, pct, new = {}, [], {}
        for k, gs in sm["goals"].items():
            for it, g in gs.items():
                b = now["goals"].get(k, {}).get(it, {}).get("then", g["now"])
                if b > 1e-6:
                    p = (g["then"] - b) / b
                elif g["then"] > 1e-3:          # made at all only with this trade: counted as +100%
                    p = 1.0
                    new.setdefault(k, {})[it] = round(g["then"], 3)
                else:
                    p = 0.0
                pct.append(p)
                if abs(p) > 1e-4:
                    gain.setdefault(k, {})[it] = round(100 * p, 2)
        sm["gain"] = gain                      # {factory: {goal item: % against now}}
        sm["new"] = new                        # {factory: {goal item: /min}} made only with it
        sm["score"] = round(100 * sum(pct) / len(pct), 3) if pct else 0.0   # the mean, %
        # what it frees: the network's resource score (each resource as a share of
        # its supply, averaged), goals held, against now — % less
        b0, b1 = now.get("score_held"), sm.get("score_held")
        sm["frees"] = round(100 * (b0 - b1) / b0, 3) if b0 and b1 is not None else 0.0
        return sm
    compare(now)
    compare(best)
    trades, quiet = [], []
    for (a, b, it), sm in out.items():
        if not sm["ok"]:
            continue
        compare(sm)
        (trades if sm["score"] > 0.05 or sm["frees"] > 0.25 else quiet).append({"from": a, "to": b, "item": it, **sm})
    trades.sort(key=lambda t: (-t["score"], -t["frees"]))
    return {"now": now, "all": best, "trades": trades[:most], "tried": len(cands),
            "no_effect": sorted({(q["from"], q["to"], q["item"]) for q in quiet})}
