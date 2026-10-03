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
                    # your scenarios may ask for more than they can have: then it says why
                    if r.status != "Optimal":
                        self.assertTrue(r.conflict_hints, f"{r.status} with no reason given")
                        continue
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


class WhyNot(unittest.TestCase):
    """A plan that can't be made says why, and each fix it offers works."""
    def scenario(self, **kw):
        kw = {"min_produce": {"High_Speed_Connector": 10, "Circuit_Board": 10}, **kw}
        return solver.Scenario(name="hsc", enabled_machines=["Smelter", "Constructor", "Assembler", "Manufacturer", "Refinery"],
                               available_resources={"Caterium_Ore": 300, "Copper_Ore": 600, "Iron_Ore": 600, "Crude_Oil": 600},
                               objective={"Wire": 1}, **kw)

    def test_short_supply_is_named_and_the_fixes_work(self):
        sc = self.scenario()
        r = solver.solve(sc, RECIPES, META)
        self.assertEqual(r.status, "Infeasible")
        d = r.diagnosis
        self.assertIn("Caterium_Ore", d["short"])
        self.assertTrue(any("Not enough Caterium Ore" in h for h in r.conflict_hints), r.conflict_hints)
        # more of what's short: it fits
        more = dict(sc.available_resources)
        for it, v in d["short"].items():
            more[it] = more.get(it, 0) + v + 1
        self.assertTrue(solver.solve(dataclasses.replace(sc, available_resources=more), RECIPES, META).status.startswith("Optimal"))
        # the goal lowered to what fits with the rest: it fits
        most, _ = d["most"]["High_Speed_Connector"]
        low = dataclasses.replace(sc, min_produce={**sc.min_produce, "High_Speed_Connector": most})
        self.assertTrue(solver.solve(low, RECIPES, META).status.startswith("Optimal"))
        # the alternates it names: they fit
        if d.get("alts") and not d["alts"]["short"]:
            alt = dataclasses.replace(sc, alternate_recipes_enabled=d["alts"]["use"])
            self.assertTrue(solver.solve(alt, RECIPES, META).status.startswith("Optimal"))

    def test_a_plan_that_fits_has_no_diagnosis(self):
        r = solver.solve(self.scenario(min_produce={"Circuit_Board": 1}), RECIPES, META)
        self.assertTrue(r.status.startswith("Optimal"))
        self.assertIsNone(r.diagnosis)


class WorthUnlocking(unittest.TestCase):
    """The alternates you haven't unlocked that would help: what each is said
    to add is what the full solve gets with it on."""
    def test_the_best_one_gives_what_it_says(self):
        sc = solver.Scenario(name="plates", enabled_machines=["Smelter", "Constructor", "Assembler", "Foundry"],
                             available_resources={"Iron_Ore": 480, "Copper_Ore": 240}, objective={"Iron_Plate": 1})
        r = solver.solve(sc, RECIPES, META)
        a = solver.analyse(sc, RECIPES, [dataclasses.asdict(f) for f in r.flows], r.usable, r.objective_value)
        self.assertTrue(a["new_alts"], a.get("new_alts_error"))
        best = a["new_alts"][0]
        self.assertGreater(best["output"], 0)
        r1 = solver.solve(dataclasses.replace(sc, alternate_recipes_enabled=[best["key"]]), RECIPES, META)
        gained = 100 * (r1.objective_value / r.objective_value - 1)
        self.assertAlmostEqual(gained, best["output"], delta=max(1.0, best["output"] * 0.05))
        # one already turned on isn't suggested again
        a2 = solver.analyse(dataclasses.replace(sc, alternate_recipes_enabled=[best["key"]]), RECIPES,
                            [dataclasses.asdict(f) for f in r1.flows], r1.usable, r1.objective_value)
        self.assertNotIn(best["key"], [x["key"] for x in a2["new_alts"]])


if __name__ == "__main__":
    unittest.main()
