"""Factories together (server.py): claims, owed outputs,
re-solve order, applying a network plan, history, reading a save.
Runs against a temporary scenarios folder, never your own."""
import json
import shutil
import struct
import tempfile
import unittest
import zlib
from pathlib import Path

import yaml

import savefile
import server
import supply


class _Temp(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        (self.dir / ".data").mkdir()
        self._keep = {k: getattr(server, k) for k in ("SCENARIOS_DIR", "RESULTS_DIR", "HISTORY_DIR", "BOARD_PATH",
                                                      "UNLOCKED_PATH", "SAVE_NODES_PATH")}
        self._prog = supply.PROGRESS_PATH
        server.SCENARIOS_DIR = self.dir
        server.RESULTS_DIR = self.dir / ".results"
        server.HISTORY_DIR = self.dir / ".history"
        server.BOARD_PATH = self.dir / ".data" / "board.yaml"
        server.UNLOCKED_PATH = self.dir / ".data" / "unlocked_alts.yaml"   # none: not yours
        server.SAVE_NODES_PATH = self.dir / ".data" / "save_nodes.json"
        supply.PROGRESS_PATH = self.dir / ".data" / "progress.yaml"   # not among the scenarios
        server._mem_cache.clear()
        supply.save_progress({"machines": ["Smelter", "Constructor", "Assembler", "Foundry", "Refinery"]})

    def tearDown(self):
        for k, v in self._keep.items():
            setattr(server, k, v)
        supply.PROGRESS_PATH = self._prog
        server._mem_cache.clear()
        shutil.rmtree(self.dir)

    def save(self, key, **data):
        data.setdefault("name", key)
        (self.dir / f"{key}.yaml").write_text(yaml.safe_dump(data), encoding="utf-8")
        return data

    def plan(self, key, result, data):
        """Cache a plan for a saved factory as if it had been solved."""
        s = server._build_scenario(data)
        sig = server._signature(s, [])
        server._cache_store(server._result_key(data["name"]), sig, sig, [], {"status": "Optimal", **result})


class Claims(_Temp):
    def test_imports_and_storage_share_what_is_made(self):
        src = self.save("src", resource_nodes=[], objective={"Plastic": 1}, to_storage=[{"item": "Plastic", "rate": 10}])
        self.plan("src", {"sink_nodes": {"Plastic": 40.0}}, src)
        self.save("a", resource_nodes=[], from_factories=[{"item": "Plastic", "factory": "src", "rate": 25}])
        b = {"name": "b", "resource_nodes": [],
             "from_factories": [{"item": "Plastic", "factory": "src", "rate": 20},
                                {"item": "Plastic", "factory": "b", "rate": 5}]}   # from itself: dropped
        cut = server._hold_claims("b", b)
        self.assertEqual(b["from_factories"], [{"item": "Plastic", "factory": "src", "rate": 5.0}])
        self.assertEqual(cut[0]["kind"], "import")
        self.assertEqual(b["available_resources"], {"Plastic": 5.0})
        # storage can't take what others import
        s2 = {**src, "to_storage": [{"item": "Plastic", "rate": 30}]}
        cut = server._hold_claims("src", s2)
        self.assertEqual(s2["to_storage"][0]["rate"], 15.0)

    def test_nodes_mined_once(self):
        a, b = [k for k, v in supply.map_nodes().items() if v["r"] == "Coal"][:2]
        self.save("x", resource_nodes=[{"resource": "Coal", "extractor": "Miner", "nodes": [a]}])
        y = {"name": "y", "resource_nodes": [{"resource": "Coal", "extractor": "Miner", "nodes": [a, b]}]}
        cut = server._hold_claims("y", y)
        self.assertEqual(y["resource_nodes"][0]["nodes"], [b])
        self.assertEqual([c["kind"] for c in cut], ["node"])

    def test_owed_and_reuse(self):
        src = self.save("src", resource_nodes=[], max_produce={"Rubber": 15}, must_produce={"Fuel": 5},
                        to_storage=[{"item": "Plastic", "rate": 10}])
        self.save("a", from_factories=[{"item": "Plastic", "factory": "src", "rate": 25},
                                       {"item": "Rubber", "factory": "src", "rate": 30},
                                       {"item": "Fuel", "factory": "src", "rate": 2}])
        claims = server._claims(server._scenario_files())
        owed = server._owed("src", claims, server._build_scenario(src))
        # an exact amount stays exact; an at-most caps what's owed
        self.assertEqual(owed, {"Plastic": 35.0, "Rubber": 15.0})
        ok = {"result": {"sink_nodes": {"Plastic": 40, "Rubber": 15}}, "owed": {"Plastic": 35.0}}
        self.assertTrue(server._owed_ok(ok, owed, {}))                 # solved owing less, makes enough
        self.assertFalse(server._owed_ok({**ok, "owed": {"Plastic": 50.0}}, owed, {}))   # solved owing more
        self.assertFalse(server._owed_ok({"result": {"sink_nodes": {"Plastic": 20}}}, owed, {}))

    def test_owed_from_supply_comes_off_it(self):
        # sending on raw ore: less ore for itself, not ore it must "make"
        s = server._build_scenario({"name": "m", "available_resources": {"Iron_Ore": 300, "Water": 100},
                                    "unlimited_resources": ["Water"], "objective": {"Iron_Plate": 1}})
        run = server._with_owed(s, {"Iron_Ore": 120.0, "Water": 50.0, "Iron_Rod": 5.0})
        self.assertEqual(run.available_resources["Iron_Ore"], 180.0)
        self.assertEqual(run.available_resources["Water"], 100)          # unlimited stays so
        self.assertEqual(run.min_produce, {"Iron_Rod": 5.0})
        plan = {"flows": [{"inputs": {"Iron_Ore": 200}, "outputs": {"Iron_Ingot": 200}}]}
        self.assertEqual(server._owed_short(plan, {"Iron_Ore": 120.0}, {"Iron_Ore": 300}), {"Iron_Ore": 20.0})


class Chain(_Temp):
    def test_sources_first(self):
        self.save("c", from_factories=[{"item": "X", "factory": "b", "rate": 1}])
        self.save("b", from_factories=[{"item": "X", "factory": "a", "rate": 1}])
        self.save("a")
        self.save("other")
        files = server._scenario_files()
        self.assertEqual(server._chain_order(files, ["a"]), ["a", "b", "c"])
        self.assertEqual(server._chain_order(files, ["b"]), ["b", "c"])

    def test_apply_network(self):
        self.save("src", resource_nodes=[])
        self.save("dst", resource_nodes=[{"resource": "Plastic", "extractor": "fixed", "rate": 99},
                                         {"resource": "Coal", "extractor": "fixed", "rate": 50}],
                  from_factories=[{"item": "Rubber", "factory": "src", "rate": 9},
                                  {"item": "Wire", "factory": "elsewhere", "rate": 3}])
        changed = server._apply_network([{"from": "src", "to": "dst", "item": "Plastic", "rate": 40}],
                                        {"dst": ["Alt_Recycled_Rubber"]})
        self.assertEqual(changed, ["dst"])
        d = yaml.safe_load((self.dir / "dst.yaml").read_text())
        self.assertEqual(d["from_factories"], [{"item": "Wire", "factory": "elsewhere", "rate": 3},
                                               {"item": "Plastic", "factory": "src", "rate": 40}])
        self.assertEqual([n["resource"] for n in d["resource_nodes"]], ["Coal"])     # the typed Plastic went
        self.assertEqual(d["alternate_recipes_enabled"], ["Alt_Recycled_Rubber"])
        self.assertEqual(len(server._history("dst")), 1)                             # the old one is kept


class Save(unittest.TestCase):
    def test_reads_extractor_nodes(self):
        body = (b"\x00" * 50 + b"mExtractableResource\x00ObjectProperty\x00\x10Persistent_Level\x00"
                b"Persistent_Level:PersistentLevel.BP_ResourceNode123\x00" + b"\x00" * 20
                + b"mExtractableResource\x00..Persistent_Level:PersistentLevel.BP_FrackingSatellite7\x00")
        chunk = zlib.compress(body)
        raw = b"HEADER" * 10 + struct.pack("<I", 0x9E2A83C1) + b"\x00" * 44 + chunk
        self.assertEqual(savefile.used_nodes(raw), ["FrackingSatellite7", "ResourceNode123"])
        with self.assertRaises(ValueError):
            savefile.used_nodes(b"not a save")

    def test_reads_unlocks(self):
        def fstr(t):
            b = t.encode() + b"\x00"
            return struct.pack("<i", len(b)) + b
        names = ["Recipe_MinerMk1", "Recipe_MinerMk2", "Recipe_ConveyorBeltMk4", "Recipe_ConstructorMk1",
                 "Recipe_SmelterMk1", "Recipe_Alternate_EnrichedCoal"]   # Compacted Coal, to the game
        arr = b"".join(struct.pack("<i", 0) + fstr(f"/Game/FactoryGame/Recipes/X/{n}.{n}_C") for n in names)
        body = (b"mAvailableRecipes\x00\x0e\x00\x00\x00ArrayProperty\x00" + b"\x00" * 12
                + struct.pack("<i", len(names)) + arr + b"\x00" * 16)
        raw = struct.pack("<I", 0x9E2A83C1) + b"\x00" * 44 + zlib.compress(body)
        got = savefile.read(raw)
        self.assertEqual(got["recipes"], names)
        u = savefile.unlocks(got["recipes"])
        # the game calls the Foundry's recipe Recipe_SmelterMk1
        self.assertEqual(u, {"alts": ["Alt_Compacted_Coal"], "machines": ["Constructor", "Foundry"],
                             "miner": "Mk2", "belt": "Mk4", "pipe": None})


if __name__ == "__main__":
    unittest.main()
