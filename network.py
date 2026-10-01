"""
network.py — plan several factories together, joined by routes.

Each factory keeps its own node supply, its own enabled recipes and machines,
and the goal outputs its current plan makes. Routes join factories by belt
(pipes for fluids), train, truck or drone. One continuous model of the whole
network (fractional machines — a planning view; each factory is then solved
on its own for its exact build) decides which recipe runs where and what
crosses each route, in three stages, each locked before the next:

  1. least resources — every factory's draw over its own supply, averaged,
     so a scarce resource costs more than an abundant one (held within
     _RES_SLACK, so fractional machines alone don't force a rebuild)
  2. least transport — each route's load in what moving it takes: lanes for
     belts and pipes, cars / vehicles per trip time for trains, trucks, drones
     (stack sizes decide how much fits)
  3. least change — each solved factory as close to its own plan as it can
     stay, so only what improves 1 or 2 moves (equal options don't churn)
  4. least machine space

What a factory declared as supplied but isn't mined (an import standing in for
another factory) has to come over a route — unless no factory in the network
can make it, then it stays an outside supply.

Headroom, per factory with a goal: the most of it the network could make with
every other factory's outputs held, less what it makes now — what the
network's leftover resources are worth to it.
"""
from typing import Dict, List, Optional

import yaml
from ortools.linear_solver import pywraplp

from solver import RECIPES_PATH, Recipe, Scenario, machine_space

with open(RECIPES_PATH) as _f:
    _RAW = yaml.safe_load(_f)
FLUIDS = set(_RAW.get("fluids") or [])
NODE = set(_RAW.get("node_resources") or [])
STACK = dict(_RAW.get("stack_sizes") or {})
VEHICLES = dict(_RAW.get("vehicles") or {})
TRANSPORT = dict(_RAW.get("transport") or {})
META = dict(_RAW.get("machine_meta") or {})

_SHOW = 0.01      # flows and recipes below this (per min / machines) are numeric dust
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


def _unit_cost(item: str, route: dict, belt: str, pipe: str) -> Optional[float]:
    """What 1 item (or m³) per minute costs on this route: lanes, or vehicles.
    None = this route can't carry it (fluids by truck or drone, unpackaged)."""
    mode, trip = route.get("mode", "belt"), max(float(route.get("trip_min") or 1.0), 0.05)
    fluid = item in FLUIDS
    if mode == "belt":
        return 1.0 / (TRANSPORT["pipes"][pipe] if fluid else TRANSPORT["belts"][belt])
    v = VEHICLES.get(mode) or {}
    if fluid:
        return trip / v["fluid"] if v.get("fluid") else None
    return trip / (v.get("stacks", 32) * STACK.get(item, 100))


class _Net:
    """One LP of the network. held: per factory, outputs it must still make."""

    def __init__(self, sites: List[dict], routes: List[dict], recipes: Dict[str, Recipe],
                 belt: str, pipe: str, free_goal: Optional[str] = None):
        self.s = s = pywraplp.Solver.CreateSolver("GLOP")
        inf = s.infinity()
        self.keys = keys = [x["key"] for x in sites]
        self.by = by = {x["key"]: x for x in sites}
        self.allowed = allowed = {k: _allowed(by[k]["scenario"], recipes, by[k]["own"]) for k in keys}
        makeable = {it for k in keys for r in allowed[k].values() for it in r.outputs}
        self.q = q = {(k, rk): s.NumVar(0, inf, "") for k in keys for rk in allowed[k]}

        # Route arcs both ways, for items the source can have and the target can use
        self.arcs = arcs = []          # (route index, src, dst, item, var, unit cost)
        for ri, rt in enumerate(routes):
            for src, dst in ((rt["a"], rt["b"]), (rt["b"], rt["a"])):
                if src not in by or dst not in by:
                    continue
                have = {it for r in allowed[src].values() for it in r.outputs} | \
                       set(by[src]["scenario"].available_resources)
                use = {it for r in allowed[dst].values() for it in r.inputs} | set(by[dst]["held"])
                for it in sorted(have & use):
                    c = _unit_cost(it, rt, belt, pipe)
                    if c is not None:
                        arcs.append((ri, src, dst, it, s.NumVar(0, inf, ""), c))

        # Per factory and item: net (made + brought − sent) ≥ what must stay
        self.net: Dict[tuple, Dict[object, float]] = {}
        self.draw: Dict[tuple, object] = {}
        for k in keys:
            sc = by[k]["scenario"]
            unlimited = set(sc.unlimited_resources)
            held = by[k]["held"]
            if k == free_goal:     # its goal items are what's being maximised
                held = {it: r for it, r in held.items() if it not in sc.objective}
            items = {it for r in allowed[k].values() for it in (*r.inputs, *r.outputs)} \
                | set(sc.available_resources) | set(by[k]["held"])
            for it in items:
                expr: Dict[object, float] = {}
                for rk, r in allowed[k].items():
                    c = r.outputs.get(it, 0.0) - r.inputs.get(it, 0.0)
                    if c:
                        expr[q[(k, rk)]] = c
                for (_, a, b, i2, v, _c) in arcs:
                    if i2 == it and b == k:
                        expr[v] = expr.get(v, 0.0) + 1.0
                    elif i2 == it and a == k:
                        expr[v] = expr.get(v, 0.0) - 1.0
                self.net[(k, it)] = expr
                ct = s.Constraint(held.get(it, 0.0), inf)
                for v, c in expr.items():
                    ct.SetCoefficient(v, c)
                supply = float(sc.available_resources.get(it, 0.0) or 0.0)
                if it in unlimited:
                    ct.SetLb(-inf)
                elif supply > 0 and (it in NODE or it not in makeable):
                    u = self.draw[(k, it)] = s.NumVar(0, supply, "")   # from its own supply
                    ct.SetCoefficient(u, 1.0)

    def run(self, obj: Dict[object, float], maximize: bool = False) -> bool:
        o = self.s.Objective()
        o.Clear()
        for v, c in obj.items():
            o.SetCoefficient(v, o.GetCoefficient(v) + c)
        o.SetMaximization() if maximize else o.SetMinimization()
        return self.s.Solve() in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE)

    def lock(self, obj: Dict[object, float], value: float) -> None:
        ct = self.s.Constraint(-self.s.infinity(), value + abs(value) * 1e-6 + 1e-9)
        for v, c in obj.items():
            ct.SetCoefficient(v, ct.GetCoefficient(v) + c)

    def value(self, obj: Dict[object, float]) -> float:
        return sum(c * v.solution_value() for v, c in obj.items())


def plan_network(sites: List[dict], routes: List[dict], recipes: Dict[str, Recipe],
                 belt: str = "Mk5", pipe: str = "Mk2") -> dict:
    """sites: [{key, name, scenario: Scenario, held: {item: rate},
    own: {recipe: machine-equivalents}, own_draw: {item: rate}}];
    routes: [{a, b, mode, trip_min}]."""
    m = _Net(sites, routes, recipes, belt, pipe)
    supply = {key: float(m.by[key[0]]["scenario"].available_resources[key[1]]) for key in m.draw}
    res_obj = {u: 100.0 / supply[key] / max(1, len(m.draw)) for key, u in m.draw.items()}
    if not m.run(res_obj):
        return {"ok": False, "error": "The network can't make every factory's current outputs."}
    score = m.value(res_obj)
    m.lock(res_obj, score * (1 + _RES_SLACK))
    move_obj = {v: c for (_, _, _, _, v, c) in m.arcs}
    m.run(move_obj)
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
    if change:
        m.run(change)
        m.lock(change, m.value(change))
    m.run({m.q[(k, rk)]: float(machine_space(META, r.machine))
           for k in m.keys for rk, r in m.allowed[k].items()})

    out = {"ok": True, "resource_score": round(score, 3), "factories": [], "routes": []}
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
        out["factories"].append({"key": k, "name": m.by[k]["name"], "recipes": moved, "resources": res})
    for ri, rt in enumerate(routes):
        items, load = [], 0.0
        for (r2, a, b, it, v, c) in m.arcs:
            x = v.solution_value()
            if r2 == ri and x > _SHOW:
                items.append({"item": it, "from": a, "to": b, "rate": round(x, 3),
                              "stacks": None if it in FLUIDS else round(x / STACK.get(it, 100), 3),
                              "load": round(x * c, 4)})
                load += x * c
        out["routes"].append({**rt, "items": items, "load": round(load, 4),
                              "throughput": round(sum(i["rate"] for i in items), 3),
                              "stacks": round(sum(i["stacks"] or 0 for i in items), 3)})
    out["throughput"] = round(sum(r["throughput"] for r in out["routes"]), 3)
    out["stacks"] = round(sum(r["stacks"] for r in out["routes"]), 3)

    # Headroom: each goal factory's most, with every other factory held
    out["headroom"] = {}
    for x in sites:
        sc = x["scenario"]
        if not sc.objective:
            continue
        h = _Net(sites, routes, recipes, belt, pipe, free_goal=x["key"])
        goal: Dict[object, float] = {}
        for it, w in sc.objective.items():
            for v, c in h.net.get((x["key"], it), {}).items():
                goal[v] = goal.get(v, 0.0) + w * c
        if goal and h.run(goal, maximize=True):
            now = sum(w * x["held"].get(it, 0.0) for it, w in sc.objective.items())
            most = h.value(goal)
            if len(sc.objective) == 1:        # one goal item: say it in items per minute
                w = next(iter(sc.objective.values())) or 1.0
                now, most, unit = now / w, most / w, "per_min"
            else:
                unit = "score"                # several weighted items: the goal's own score
            out["headroom"][x["key"]] = {"items": list(sc.objective), "unit": unit,
                                         "now": round(now, 3), "most": round(most, 3)}
    return out
