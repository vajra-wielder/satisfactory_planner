"""Plans are sound: the saved scenarios over a few somersloop/shard budgets,
and power plants (solver.py). The full grid is tests/stress.py."""
import dataclasses
import glob
import unittest

import solver
from tests.checks import check

RECIPES, META = solver.load_recipes(), solver.load_machine_meta()


class SavedScenarios(unittest.TestCase):
    def test_plans_are_sound(self):
        for p in sorted(glob.glob(str(solver.SCENARIOS_DIR / "*.yaml"))):
            base = solver.load_scenario(p)
            for S, SH in ((0, 0), (12, 30)):
                sc = dataclasses.replace(base, somersloops_available=S, power_shards_available=SH)
                with self.subTest(scenario=p.split("/")[-1], sloops=S, shards=SH):
                    r = solver.solve(sc, RECIPES, META)
                    self.assertTrue(r.status.startswith("Optimal"), r.status)
                    self.assertEqual(check(sc, r), [])
                    if sc.objective:   # the fractional ceiling bounds every plan
                        self.assertGreaterEqual(r.ceiling * (1 + 1e-6) + 1e-6, r.objective_value)


class Imports(unittest.TestCase):
    def test_an_import_adds_to_what_is_made(self):
        # 10 imported ingots don't stop it smelting its own ore
        sc = solver.Scenario(name="imp", enabled_machines=["Smelter", "Constructor"],
                             available_resources={"Iron_Ore": 300, "Iron_Ingot": 10}, objective={"Iron_Ingot": 1})
        r = solver.solve(sc, RECIPES, META)
        self.assertTrue(r.status.startswith("Optimal"))
        self.assertAlmostEqual(r.objective_value, 300, places=3)


class Power(unittest.TestCase):
    def scenario(self, **kw):
        return solver.Scenario(name="pp", enabled_machines=["Coal_Generator", "Fuel_Generator", "Refinery"],
                               available_resources={"Turbofuel": 75, "Coal": 120, "Water": 10000},
                               unlimited_resources=["Water"], objective={"Power": 1}, **kw)

    def test_power_plant(self):
        r = solver.solve(self.scenario(), RECIPES, META)
        self.assertTrue(r.status.startswith("Optimal"))
        self.assertAlmostEqual(r.objective_value, 10 * 250 + 8 * 75, places=3)   # every fuel burnt
        self.assertEqual(r.error_sinks, {})                                       # power is never a stray byproduct

    def test_generators_lift_a_power_cap(self):
        # 30 MW of machines under a 0 MW cap: only possible because generators feed it
        sc = solver.Scenario(name="cap", enabled_machines=["Constructor", "Coal_Generator"],
                             available_resources={"Iron_Ingot": 300, "Coal": 15, "Water": 1000},
                             unlimited_resources=["Water"], objective={"Iron_Plate": 1}, max_power_mw=0.0)
        r = solver.solve(sc, RECIPES, META)
        self.assertTrue(r.status.startswith("Optimal"))
        self.assertGreater(r.objective_value, 0)
        self.assertLessEqual(r.total_power_mw, 0.5)


if __name__ == "__main__":
    unittest.main()
