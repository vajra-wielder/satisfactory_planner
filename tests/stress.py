"""
Stress suite: every saved scenario over a grid of somersloop / shard budgets,
plus three deep late-game chains. A plan fails when it breaks a promise its
scenario makes (tests/checks.py) or a dive is certified below 95%.

    python -m tests.stress            # everything (a minute or so)
    python -m tests.stress steel      # scenarios whose name has "steel"
"""
import dataclasses as d
import glob
import sys
import time

import solver
from tests.checks import check

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


def main(only=None) -> int:
    bad = below = 0
    t0 = time.time()
    for n, sc, S, SH in cases(only):
        t = time.time()
        r = solver.solve(sc, REC, META)
        errs = check(sc, r) if r.status.startswith('Optimal') else [r.status]
        cert = r.certified
        bad += bool(errs)
        below += cert is not None and cert < 0.95
        print(f"{n[:14]:14s} S={S:3d} SH={SH:3d}  goal={r.objective_value:12.3f}  "
              f"certified={'exact' if cert is None else f'{cert * 100:6.2f}%':>7s}  {time.time() - t:6.2f}s"
              f"{'  ERR ' + str(errs) if errs else ''}{'  WARN ' + str(r.warnings) if r.warnings else ''}", flush=True)
    print(f"\n{bad} unsound, {below} certified below 95%, {time.time() - t0:.1f}s")
    return 1 if bad or below else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else None))
