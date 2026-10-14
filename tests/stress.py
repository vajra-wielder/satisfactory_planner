"""
Stress suite: every saved scenario over a grid of somersloop / shard budgets,
plus three deep late-game chains. A plan fails when it breaks a promise its
scenario makes (check, below) or a dive is certified below 95%.

    python -m tests.stress            # everything, a case per core
    python -m tests.stress steel      # scenarios whose name has "steel"
    python -m tests.stress -j 1       # one at a time: per-case times without contention
"""
import dataclasses as d
import glob
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import solver

# A plan is valid when it keeps every promise its scenario makes
def check(sc, r):
    """Problems with plan r for scenario sc (empty when it's sound)."""
    errs = []
    for k, v in r.net_items.items():
        if v < -1e-3 and k not in sc.available_resources:
            errs.append(f"deficit {k}")
    for it in sc.available_resources:
        if r.net_items.get(it, 0) < -1e-3:
            errs.append(f"overuse {it}")
    for it, q in sc.must_produce.items():
        if abs(r.net_items.get(it, 0) - q) > max(0.05, q * 0.01):
            errs.append(f"must {it}")
    for it, q in sc.min_produce.items():
        if r.net_items.get(it, 0) < q - max(0.05, q * 0.01):
            errs.append(f"min {it}")
    if r.sloops_used > sc.somersloops_available:
        errs.append("sloops over")
    if r.shards_used > sc.power_shards_available:
        errs.append("shards over")
    if sc.max_power_mw is not None and r.total_power_mw > sc.max_power_mw + 0.5:
        errs.append("power over")
    for f in r.flows:
        lay = getattr(f, "layout", None)
        if not lay:
            continue
        cap = sum(g["count"] * g["clock_pct"] / 100 for g in lay)
        if abs(cap - f.machines_float) > 1e-3:
            errs.append(f"layout {f.recipe_key} {cap} vs {f.machines_float}")
        if sum(g["count"] for g in lay) != f.machines_final:
            errs.append(f"count {f.recipe_key}")
        if sum(g["count"] * g["shards"] for g in lay) != f.shards_used:
            errs.append(f"shardsum {f.recipe_key}")
        for g in lay:
            if g["clock_pct"] > 100 + 50 * g["shards"] + 1e-6:
                errs.append(f"clock {f.recipe_key}")
            if g.get("sloops", 0) > f.sloop_slots:
                errs.append(f"slots {f.recipe_key}")
        if "sloops" in lay[0] and sum(g["count"] * g["sloops"] for g in lay) != f.sloops_used:
            errs.append(f"sloopsum {f.recipe_key}")
    # no ghost leftovers: a byproduct or surplus shown is never a rounding crumb
    for k, v in {**r.error_sinks, **r.surplus_intermediates}.items():
        if v < 0.005:
            errs.append(f"crumb {k} {v}")
    return errs


REC, META = solver.load_recipes(), solver.load_machine_meta()
ALL_ALTS = [k for k, r in REC.items() if r.alternate]
MACHINES = ['Smelter', 'Constructor', 'Assembler', 'Foundry', 'Manufacturer', 'Refinery',
            'Packager', 'Blender', 'Particle_Accelerator', 'Converter', 'Quantum_Encoder', 'Nuclear_Power_Plant']
MAP = dict(Iron_Ore=6000, Copper_Ore=3000, Limestone=4000, Coal=4000, Caterium_Ore=1500,
           Raw_Quartz=1500, Sulfur=1200, Bauxite=1500, Uranium_Ore=600, SAM=800,
           Crude_Oil=3000, Nitrogen_Gas=1200, Water=100000)


def _deep(name, objective, resources):
    return solver.Scenario(name=name, alternate_recipes_enabled=ALL_ALTS, enabled_machines=MACHINES,
                           available_resources=dict(resources), objective=objective, unlimited_resources=['Water'])


DEEP = {
    'warp_drive': _deep('Warp Drive', {'Ballistic_Warp_Drive': 1.0}, MAP),
    'uranium_rods': _deep('Uranium Rods', {'Uranium_Fuel_Rod': 1.0}, {**MAP, 'Uranium_Ore': 900}),
    'ficsonium': _deep('Ficsonium', {'Ficsonium_Fuel_Rod': 1.0}, MAP),
}


def cases(only=None):
    out = []
    for p in sorted(glob.glob(str(solver.SCENARIOS_DIR / '*.yaml'))):
        b, n = solver.load_scenario(p), p.split('/')[-1][:-5]
        for S, SH in ((0, 0), (0, 30), (12, 0), (30, 30), (106, 100)):
            out.append((n, d.replace(b, somersloops_available=S, power_shards_available=SH), S, SH))
    for n, b in DEEP.items():
        for S, SH in ((20, 50), (60, 50), (106, 100)):
            out.append((n, d.replace(b, somersloops_available=S, power_shards_available=SH), S, SH))
    return [c for c in out if not only or only in c[0]]


def _run(case):
    n, sc, S, SH = case
    t = time.time()
    r = solver.solve(sc, REC, META)
    # a plan is checked; one that can't be made must say why (your scenarios may ask too much)
    errs = check(sc, r) if r.status == 'Optimal' else [] if r.conflict_hints else [f'{r.status}, no reason given']
    if r.status != 'Optimal' and not errs:
        r.warnings = [f"can't be made: {r.conflict_hints[0]}"] + r.warnings
    return n, S, SH, r.objective_value, r.certified, time.time() - t, errs, r.warnings


def main(only=None, jobs=None) -> int:
    bad = below = 0
    t0 = time.time()
    todo = cases(only)
    jobs = jobs or os.cpu_count() or 1
    if jobs > 1:
        with ProcessPoolExecutor(jobs) as pool:
            results = list(pool.map(_run, todo))
    else:
        results = map(_run, todo)
    for n, S, SH, goal, cert, dt, errs, warnings in results:
        bad += bool(errs)
        below += cert is not None and cert < 0.95
        print(f"{n[:14]:14s} S={S:3d} SH={SH:3d}  goal={goal:12.3f}  "
              f"certified={'exact' if cert is None else f'{cert * 100:6.2f}%':>7s}  {dt:6.2f}s"
              f"{'  ERR ' + str(errs) if errs else ''}{'  WARN ' + str(warnings) if warnings else ''}", flush=True)
    print(f"\n{bad} unsound, {below} certified below 95%, {time.time() - t0:.1f}s ({jobs} at a time)")
    return 1 if bad or below else 0


if __name__ == '__main__':
    args = sys.argv[1:]
    jobs = None
    if '-j' in args:
        i = args.index('-j')
        jobs = int(args[i + 1])
        del args[i:i + 2]
    sys.exit(main(args[0] if args else None, jobs))
