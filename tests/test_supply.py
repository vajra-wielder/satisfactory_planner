"""Supply from nodes, shards, wells, geysers and imports (supply.py)."""
import unittest

import supply


def _ids(resource, purity, n=1, well=False):
    out = [k for k, v in supply.map_nodes().items()
           if v["r"] == resource and v["p"] == purity and bool(v.get("w")) == well]
    return out[:n]


class Rates(unittest.TestCase):
    def test_typed_miner(self):
        # Mk.3 on a pure node at 250% is a full Mk.6 belt; the cap holds above it
        n = {"resource": "Iron_Ore", "extractor": "Miner", "purity": "pure", "count": 2, "shards": 3}
        self.assertAlmostEqual(supply.node_rate(n, "Mk3"), 2400)
        self.assertAlmostEqual(supply.node_rate({**n, "shards": 0}, "Mk1"), 240)
        self.assertEqual(supply.node_rate({**n, "count": 0}, "Mk3"), 0)

    def test_old_rows(self):
        # rows saved with a tier and a clock still read
        n = {"resource": "Coal", "extractor": "Miner_Mk2", "purity": "normal", "count": 1, "clock": 150}
        self.assertAlmostEqual(supply.node_rate(n, "Mk3"), 360)

    def test_map_nodes_each_with_shards(self):
        a, b = _ids("Iron_Ore", "pure", 2)
        n = {"resource": "Iron_Ore", "extractor": "Miner", "nodes": [a, b], "node_shards": {a: 3}}
        self.assertAlmostEqual(supply.node_rate(n, "Mk3"), 1200 + 480)

    def test_well_shares_one_pressurizer(self):
        sats = _ids("Nitrogen_Gas", "pure", 3, well=True)
        n = {"resource": "Nitrogen_Gas", "extractor": "Resource_Well", "nodes": sats, "shards": 2}
        self.assertAlmostEqual(supply.node_rate(n), 3 * 120 * 2.0)

    def test_oil_capped_by_pipe(self):
        n = {"resource": "Crude_Oil", "extractor": "Oil_Extractor", "purity": "pure", "count": 1, "shards": 3}
        self.assertAlmostEqual(supply.node_rate(n), 600)

    def test_available_adds_imports_not_geysers(self):
        g = _ids("Geyser", "pure")
        d = {"resource_nodes": [{"resource": "Water", "extractor": "Water_Extractor", "count": 2, "shards": 0},
                                {"resource": "Geyser", "extractor": supply.GEOTHERMAL, "nodes": g},
                                {"resource": "Quartz_Crystal", "extractor": "fixed", "rate": 50}],
             "from_factories": [{"item": "Plastic", "factory": "x", "rate": 40}, {"item": "Water", "factory": "y", "rate": 10}]}
        self.assertEqual(supply.available(d, "Mk3"), {"Water": 250.0, "Quartz_Crystal": 50.0, "Plastic": 40.0})
        self.assertEqual(supply.geothermal_mw(d), 400)

    def test_legacy_scenarios_unchanged(self):
        self.assertEqual(supply.available({"available_resources": {"Coal": 300}}), {"Coal": 300.0})


class Extractors(unittest.TestCase):
    def test_power_and_build(self):
        sats = _ids("Water", "normal", 2, well=True)
        d = {"resource_nodes": [
            {"resource": "Iron_Ore", "extractor": "Miner", "purity": "pure", "count": 2, "shards": 2},
            {"resource": "Water", "extractor": "Resource_Well", "nodes": sats, "shards": 0}],
            "power_shards_available": 3}
        # miners draw 45 MW at 100%, clock^1.321929 above it; a pressurizer 150
        self.assertAlmostEqual(supply.extractor_power(d, "Mk3"), 2 * 45 * 2 ** 1.321929 + 150, places=2)
        b = supply.extractor_build(d, "Mk3")
        self.assertEqual(b["Miner_Mk3"]["count"], 2)
        self.assertEqual(b["Miner_Mk3"]["cost"]["Portable_Miner"], 6)
        self.assertEqual(b["Resource_Well_Extractor"]["count"], 2)
        self.assertEqual(supply.shards_used(d), 3 + 4)

    def test_progress_is_cleaned(self):
        p = supply._clean_progress({"miner": "Mk9", "belt": "Mk6", "machines": ["B", "A", "A"]})
        self.assertEqual(p, {"miner": "Mk3", "machines": ["A", "B"], "belt": "Mk6", "pipe": "Mk2", "schematics": None})


class Miners(unittest.TestCase):
    """A factory keeps the miners it's built with: its own tier, not the one unlocked."""
    def test_its_own_tier(self):
        ids = _ids("Iron_Ore", "pure", 2)
        d = {"resource_nodes": [{"resource": "Iron_Ore", "extractor": "Miner", "nodes": ids}]}
        mk2, mk3 = supply.available({**d, "miner": "Mk2"}), supply.available({**d, "miner": "Mk3"})
        self.assertAlmostEqual(mk3["Iron_Ore"], 2 * mk2["Iron_Ore"])
        self.assertLess(supply.extractor_power({**d, "miner": "Mk2"}), supply.extractor_power({**d, "miner": "Mk3"}))
        self.assertIn("Miner_Mk2", supply.extractor_build({**d, "miner": "Mk2"}))
        self.assertEqual(supply.miner_count(d), 2)
        self.assertEqual(supply.miner_of({**d, "miner": "nope"}), supply.load_progress()["miner"])   # none of its own: the one unlocked


class Milestones(unittest.TestCase):
    """Tier + sub-tier and MAM research: what each recipe waits on (game_classes.json unlocks)."""
    def test_not_set_locks_nothing(self):
        self.assertEqual(supply.locked_recipes({"schematics": None}), [])

    def test_only_what_is_not_done(self):
        u = supply.UNLOCKS
        self.assertEqual(u["recipes"]["Computer"], "Schematic_5-2")          # Industrial Manufacturing
        self.assertEqual(u["schematics"]["Schematic_5-2"]["tier"], 6)          # 1.0's numbering
        self.assertIn("Computer", supply.locked_recipes({"schematics": ["Schematic_5-1"]}))
        self.assertNotIn("Plastic", supply.locked_recipes({"schematics": ["Schematic_5-1"]}))
        self.assertNotIn("Iron_Plate", supply.locked_recipes({"schematics": []}))   # from the start
        self.assertEqual(supply.UNLOCKS["recipes"]["Quickwire"].split("_")[1], "Caterium")   # MAM

    def test_unknown_ids_are_dropped(self):
        self.assertEqual(supply._clean_progress({"schematics": ["Schematic_5-2", "nope", 3]})["schematics"], ["Schematic_5-2"])

    def test_a_save_says_what_is_done(self):
        import json, savefile
        g = json.loads(open("data/game_classes.json").read())
        done = savefile.schematics_done({g["recipes"]["Computer"], g["machines"]["Refinery"]})
        self.assertEqual(done, ["Schematic_5-1", "Schematic_5-2"])


if __name__ == "__main__":
    unittest.main()
