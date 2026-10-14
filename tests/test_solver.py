"""Plans are sound: the saved scenarios over a few somersloop/shard budgets,
and power plants (solver.py). The full grid is tests/stress.py."""
import dataclasses
import glob
import unittest

import solver
from tests.stress import check

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


class Budget(unittest.TestCase):
    def test_machine_cap(self):
        # 300 ore is 10 smelters of ingots; with 4 machines it makes 120
        sc = solver.Scenario(name="cap", enabled_machines=["Smelter"], available_resources={"Iron_Ore": 300},
                             objective={"Iron_Ingot": 1}, max_machines=4)
        r = solver.solve(sc, RECIPES, META)
        self.assertTrue(r.status.startswith("Optimal"))
        self.assertLessEqual(r.total_machines, 4)
        self.assertAlmostEqual(r.objective_value, 120, places=3)
        # shards stretch a budget: 4 smelters at 250% make all 300
        r = solver.solve(dataclasses.replace(sc, power_shards_available=12), RECIPES, META)
        self.assertAlmostEqual(r.objective_value, 300, places=3)


class AltsEverywhere(unittest.TestCase):
    def test_ranked_by_what_they_add(self):
        mk = lambda **kw: solver.Scenario(name="a", enabled_machines=["Smelter", "Refinery"], unlimited_resources=["Water"], **kw)
        out = solver.alts_everywhere({
            "ingots": mk(available_resources={"Iron_Ore": 300, "Water": 1000}, objective={"Iron_Ingot": 1}),
            # nothing to maximise: the same 100 ingots from less ore
            "fixed": mk(available_resources={"Iron_Ore": 300, "Water": 1000}, must_produce={"Iron_Ingot": 100})}, RECIPES)
        top = out[0]
        self.assertEqual(top["key"], "Alt_Pure_Iron_Ingot")
        self.assertAlmostEqual(top["output"]["ingots"], 100 * (65 / 35 - 1), places=1)   # 35 ore → 65 ingots, not 35
        self.assertGreater(top["resources"]["fixed"], 40)
        # an unlocked one isn't new
        un = solver.alts_everywhere({"i": mk(available_resources={"Iron_Ore": 300, "Water": 1000}, objective={"Iron_Ingot": 1},
                                             unlocked_alt_recipes=["Alt_Pure_Iron_Ingot"])}, RECIPES)
        self.assertNotIn("Alt_Pure_Iron_Ingot", [a["key"] for a in un])


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


class Milestones(unittest.TestCase):
    """A recipe a milestone you haven't done unlocks is left out of the solve."""
    def test_locked_recipe_is_not_used(self):
        sc = solver.Scenario(name="steel", enabled_machines=["Smelter", "Foundry", "Constructor"],
                             available_resources={"Iron_Ore": 240, "Coal": 240}, objective={"Steel_Beam": 1})
        self.assertTrue(solver.solve(sc, RECIPES, META).status.startswith("Optimal"))
        locked = solver.solve(dataclasses.replace(sc, locked_recipes=["Steel_Ingot"]), RECIPES, META)
        self.assertFalse(any(f.recipe_key == "Steel_Ingot" for f in locked.flows))
        usable, _ = solver.prune_recipes(dataclasses.replace(sc, locked_recipes=["Steel_Ingot"]), RECIPES)
        self.assertNotIn("Steel_Ingot", usable)


class Needs(unittest.TestCase):
    """The goal tree's faded parts: what so much of one takes that the factory can't give it."""
    def scenario(self, **kw):
        return solver.Scenario(name="t", enabled_machines=["Smelter", "Constructor", "Assembler", "Foundry", "Manufacturer"],
                               available_resources={"Iron_Ore": 480, "Coal": 240}, **kw)

    def test_parts_it_cant_make(self):
        n = solver.needs(self.scenario(), RECIPES, "Computer", 2.5)
        self.assertEqual(n["status"], "ok")
        self.assertAlmostEqual(n["bring"]["Plastic"], 40.0, places=3)        # a Computer: 16 plastic each
        self.assertAlmostEqual(n["bring"]["Circuit_Board"], 10.0, places=3)
        self.assertNotIn("Screw", n["bring"])                               # made here

    def test_more_of_what_it_has(self):
        n = solver.needs(self.scenario(), RECIPES, "Steel_Beam", 400)
        self.assertGreater(n["bring"].get("Iron_Ore", 0) + n["bring"].get("Coal", 0), 0)
        self.assertFalse(any(k in n["bring"] for k in ("Alien_Protein", "Biomass", "Leaves")), n)   # never what's only found

    def test_nothing_when_it_fits(self):
        self.assertEqual(solver.needs(self.scenario(), RECIPES, "Steel_Beam", 5)["bring"], {})

    def test_waits_on_a_machine_still_answers(self):
        n = solver.needs(dataclasses.replace(self.scenario(), enabled_machines=["Smelter", "Constructor", "Assembler"]), RECIPES, "Computer", 2.5)
        self.assertIn("Plastic", n["bring"])


class WorthUnlocking(unittest.TestCase):
    """New alternates: the best plan with every one you haven't unlocked, in
    unlock order. What the first ones are said to add is what full solves get."""
    def scenario(self, **kw):
        return solver.Scenario(name="plates", enabled_machines=["Smelter", "Constructor", "Assembler", "Foundry"],
                               available_resources={"Iron_Ore": 480, "Copper_Ore": 240}, objective={"Iron_Plate": 1}, **kw)

    def test_unlock_order_gives_what_it_says(self):
        sc = self.scenario()
        g = solver.suggest_alts(sc, RECIPES)
        self.assertTrue(g["steps"])
        r0 = solver.solve(sc, RECIPES, META)
        on, total = [], 0.0
        for step in g["steps"][:3]:
            on.append(step["key"])
            total += step["output"]
            r = solver.solve(dataclasses.replace(sc, alternate_recipes_enabled=list(on)), RECIPES, META)
            gained = 100 * (r.objective_value / r0.objective_value - 1)
            self.assertAlmostEqual(gained, total, delta=max(1.0, total * 0.05), msg=on)
        self.assertGreaterEqual(g["all"]["output"] + 1e-6, total)

    def test_space_and_resources_are_what_a_solve_gives(self):
        # Each step's space is the plan a solve makes with it against today's —
        # more output costs space, shown as such; never a saving bigger than
        # the plan, measured from a baseline no solve makes (caps lifted)
        sc = self.scenario()
        g = solver.suggest_alts(sc, RECIPES)
        space = lambda r: solver.result_to_dict(r, sc, META)["total_space"]
        r0 = solver.solve(sc, RECIPES, META)
        s0, on, said = space(r0), [], 0.0
        for step in g["steps"][:3]:
            on.append(step["key"])
            said += step["machines"]
            r = solver.solve(dataclasses.replace(sc, alternate_recipes_enabled=list(on)), RECIPES, META)
            # whole machines against the lab's fractional ones: within a few machines' room
            self.assertAlmostEqual(s0 - space(r), said, delta=max(12.0, abs(said) * 0.05), msg=on)
        self.assertLess(g["all"]["machines"], s0)

    def test_fast_and_the_same_every_time(self):
        # the deepest chain, every alternate new: warm copies in parallel, under a second
        import time
        from tests.stress import DEEP
        sc = dataclasses.replace(DEEP["ficsonium"], alternate_recipes_enabled=[], somersloops_available=0)
        t = time.time()
        runs = [solver.suggest_alts(sc, RECIPES) for _ in range(3)]
        self.assertLess((time.time() - t) / 3, 2.0)
        self.assertTrue(runs[0]["steps"])
        self.assertTrue(all([x["key"] for x in r["steps"]] == [x["key"] for x in runs[0]["steps"]] for r in runs))

    def test_turned_on_here_still_listed_unlocked_never(self):
        first = solver.suggest_alts(self.scenario(), RECIPES)["steps"][0]["key"]
        here = solver.suggest_alts(self.scenario(alternate_recipes_enabled=[first]), RECIPES)
        self.assertIn(first, [x["key"] for x in here["steps"]])      # still new: you can untick it
        self.assertEqual(here["on"], [first])
        unlocked = solver.suggest_alts(self.scenario(unlocked_alt_recipes=[first]), RECIPES)
        self.assertNotIn(first, [x["key"] for x in unlocked["steps"]])


if __name__ == "__main__":
    unittest.main()


class Spread(unittest.TestCase):
    """Shards and sloops shared out across factories, and the what-if slider."""
    def setUp(self):
        import server
        self.server = server
        self.mk = lambda ore, goal: server._build_scenario(server._clean_scenario(
            {"name": goal, "resource_nodes": [{"resource": "Iron_Ore", "extractor": "fixed", "rate": ore}], "objective": {goal: 1}}))

    def test_budget_is_shared_out_whole(self):
        scs = {"a": self.mk(480, "Iron_Plate"), "b": self.mk(480, "Reinforced_Iron_Plate")}
        got = solver.spread_budget(scs, self.server.ALL_RECIPES, 30, 10)
        self.assertLessEqual(sum(g["shards"] for g in got.values()), 30)
        self.assertLessEqual(sum(g["sloops"] for g in got.values()), 10)
        self.assertGreater(sum(g["sloops"] for g in got.values()), 0)
        for g in got.values():
            self.assertGreaterEqual(g["goal"], g["goal0"] - 1e-6)            # never worse
            self.assertLessEqual(g["space"], g["space0"] + 1e-6)
        # each sloop went where it raised a goal the most: moving the last one over doesn't help
        a, b = got["a"], got["b"]
        if a["sloops"] and b["sloops"] < 10:
            one = solver.spread_budget({"b": scs["b"]}, self.server.ALL_RECIPES, 0, b["sloops"] + 1)["b"]
            gain_b = (one["goal"] - b["goal"]) / b["goal0"]
            less = solver.spread_budget({"a": scs["a"]}, self.server.ALL_RECIPES, 0, a["sloops"] - 1)["a"]
            loss_a = (a["goal"] - less["goal"]) / a["goal0"]
            self.assertGreaterEqual(loss_a + 1e-6, gain_b)

    def test_whatif_follows_supply(self):
        sc = self.mk(480, "Iron_Plate")
        lo = solver.whatif(sc, self.server.ALL_RECIPES)
        hi = solver.whatif(dataclasses.replace(sc, available_resources={"Iron_Ore": 960.0}), self.server.ALL_RECIPES)
        self.assertTrue(lo["ok"] and hi["ok"])
        self.assertAlmostEqual(hi["items"]["Iron_Plate"], 2 * lo["items"]["Iron_Plate"], places=3)
        bad = solver.whatif(dataclasses.replace(sc, must_produce={"Iron_Plate": 10000.0}), self.server.ALL_RECIPES)
        self.assertFalse(bad["ok"])
