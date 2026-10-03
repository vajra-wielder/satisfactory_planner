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
                                                      "UNLOCKED_PATH", "SAVE_NODES_PATH", "MAP_SETTINGS_PATH",
                                                      "MAP_IMAGE_DIR", "BACKUP_DIR", "GAME_MAP_URL")}
        self._prog = supply.PROGRESS_PATH
        server.SCENARIOS_DIR = self.dir
        server.RESULTS_DIR = self.dir / ".results"
        server.HISTORY_DIR = self.dir / ".history"
        server.BOARD_PATH = self.dir / ".data" / "board.yaml"
        server.UNLOCKED_PATH = self.dir / ".data" / "unlocked_alts.yaml"   # none: not yours
        server.SAVE_NODES_PATH = self.dir / ".data" / "save_nodes.json"
        server.MAP_SETTINGS_PATH = self.dir / ".data" / "map_image.json"
        server.MAP_IMAGE_DIR = self.dir / ".data"
        server.BACKUP_DIR = self.dir / ".backups"
        server.GAME_MAP_URL = None   # never fetched in tests
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


class Spare(_Temp):
    def test_unused_node_supply_can_be_taken_nearby(self):
        ids = [k for k, v in supply.map_nodes().items() if v["r"] == "Iron_Ore" and not v.get("w")][:2]
        src = self.save("src", resource_nodes=[{"resource": "Iron_Ore", "extractor": "fixed", "rate": 300},
                                               {"resource": "Water", "extractor": "fixed", "rate": 500}],
                        unlimited_resources=["Water"], objective={"Iron_Ingot": 1}, max_produce={"Iron_Ingot": 100})
        plan = {"flows": [{"machine": "Smelter", "inputs": {"Iron_Ore": 100.0}, "outputs": {"Iron_Ingot": 100.0}}],
                "sink_nodes": {"Iron_Ingot": 100.0}, "status": "Optimal"}
        self.plan("src", plan, src)
        out = server._factory_outputs()
        f = next(x for x in out["factories"] if x["key"] == "src")
        self.assertEqual(f["spare"], {"Iron_Ore": 200.0})            # water is unlimited: not spare
        self.assertEqual(f["made"]["Iron_Ore"], 200.0)
        # a factory nearby takes it — no more than is spare
        b = {"name": "b", "resource_nodes": [], "from_factories": [{"item": "Iron_Ore", "factory": "src", "rate": 250}]}
        cut = server._hold_claims("b", b)
        self.assertEqual(b["from_factories"][0]["rate"], 200.0)
        self.assertEqual(cut[0]["kind"], "import")
        self.save("b", **{k: v for k, v in b.items() if k != "name"})
        # the source's plan still stands: it uses 100 of the 300 and sends 200 on
        _, res = server._factory_plan("src")
        self.assertIsNotNone(res)
        self.assertEqual(server._owed("src", server._claims(server._scenario_files()), server._build_scenario(src)),
                         {"Iron_Ore": 200.0})
        # where a factory is: the middle of its nodes
        w = self.save("w", resource_nodes=[{"resource": "Iron_Ore", "extractor": "Miner", "nodes": ids}])
        known = supply.map_nodes()
        self.assertEqual(server._where(w), [round((known[ids[0]]["x"] + known[ids[1]]["x"]) / 2),
                                           round((known[ids[0]]["y"] + known[ids[1]]["y"]) / 2)])
        self.assertIsNone(server._where(src))


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


class History(_Temp):
    def test_keeps_confirmed_and_latest_changes(self):
        d = self.save("h", objective={"Plastic": 1}, from_factories=[{"item": "Fuel", "factory": "oil", "rate": 10}])
        self.assertEqual(server._history_keep("h", dict(d)), "")            # unchanged: nothing kept
        first = server._history_keep("h", {**d, "objective": {"Plastic": 2}})
        self.assertTrue(first)
        server._history_confirm("h", first, True)
        for i in range(8):
            server._history_keep("h", {**d, "notes": str(i)})
            self.save("h", **{**d, "notes": str(i)})
        ids = [v["id"] for v in server._history("h")]
        self.assertEqual(len(ids), 6)                                       # 5 latest + the confirmed one
        self.assertIn(first, ids)
        server._history_confirm("h", "current", True)
        self.assertEqual(sum(v["confirmed"] for v in server._history("h")), 2)
        for _ in range(3):
            server._history_confirm("h", ids[1 + _], True)
        with self.assertRaises(server._BadRequest):                        # 5 at most
            server._history_confirm("h", ids[-2], True)
        server._history_confirm("h", first, False)
        self.assertNotIn(first, [v["id"] for v in server._history("h") if v["confirmed"]])

    def test_says_what_restoring_changes(self):
        cur = {"name": "a", "objective": {"Plastic": 1}, "alternate_recipes_enabled": ["Alt_Recycled_Rubber"],
               "from_factories": [{"item": "Fuel", "factory": "oil", "rate": 25}],
               "resource_nodes": [{"resource": "Coal", "extractor": "fixed", "rate": 60}], "max_power_mw": 300}
        old = {"name": "a", "objective": {"Plastic": 1, "Rubber": 2}, "alternate_recipes_enabled": [],
               "from_factories": [{"item": "Fuel", "factory": "oil", "rate": 40}],
               "resource_nodes": [{"resource": "Coal", "extractor": "fixed", "rate": 120}]}
        self.assertEqual(server._diff(cur, old), [
            "+ goal Rubber 2", "supply Coal: 60 → 120/min", "Fuel from oil: 25 → 40/min",
            "− Alt Recycled Rubber", "power cap: 300 → —"])
        self.assertEqual(server._diff(cur, cur), [])


class Grid(_Temp):
    def test_short_grid_names_whose_draw_rose(self):
        flows = lambda mw: {"flows": [{"machine": "Smelter", "power_mw": mw, "inputs": {}, "outputs": {}}]}
        a = self.save("a", resource_nodes=[], objective={"Iron_Ingot": 1})
        self.plan("a", flows(100.0), a)
        p = self.save("p", resource_nodes=[], objective={"Power": 1})
        self.plan("p", flows(-150.0), p)
        g = server._grid_status()
        self.assertEqual((g["spare"], g["rose"]), (50.0, []))
        a = self.save("a", resource_nodes=[], objective={"Iron_Ingot": 2})   # changed and re-solved: draws more
        self.plan("a", flows(400.0), a)
        g = server._grid_status()
        self.assertEqual(g["spare"], -250.0)
        self.assertEqual(g["rose"], [{"key": "a", "name": "a", "was": 100.0, "now": 400.0}])


class Backup(_Temp):
    def test_round_trip(self):
        import zipfile, io
        a = self.save("a", objective={"Plastic": 1})
        server._history_keep("a", {**a, "notes": "x"})
        server._save_board({"positions": {"a": {"x": 1, "y": 2}}, "routes": [], "geysers": []})
        (server.MAP_IMAGE_DIR / "map_image.png").write_bytes(b"png")
        made = server._backup_make()
        self.assertEqual([b["file"] for b in server._backups()], [made.name])
        # things change, then the backup goes back
        self.save("b")
        (self.dir / "a.yaml").unlink()
        was = supply.load_progress()
        supply.save_progress({"machines": ["Smelter"]})
        out = server._backup_restore(made.read_bytes())
        self.assertEqual(out["factories"], 1)
        self.assertEqual(sorted(p.stem for p in self.dir.glob("*.yaml")), ["a"])
        self.assertEqual(len(server._history("a")), 1)
        self.assertEqual(server._load_board()["positions"], {"a": {"x": 1.0, "y": 2.0}})
        self.assertEqual(supply.load_progress(), was)
        self.assertEqual((server.MAP_IMAGE_DIR / "map_image.png").read_bytes(), b"png")
        self.assertTrue((server.BACKUP_DIR / out["before"]).exists())          # what was there is kept too
        # anything else in a zip is refused
        for names in (["../evil.yaml"], ["scenarios/../../x.yaml"], ["solver.py"], []):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as z:
                for n in names:
                    z.writestr(n, "x")
            with self.assertRaises(server._BadRequest):
                server._backup_restore(buf.getvalue())
        with self.assertRaises(server._BadRequest):
            server._backup_restore(b"not a zip")
        self.assertEqual(sorted(p.stem for p in self.dir.glob("*.yaml")), ["a"])


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
