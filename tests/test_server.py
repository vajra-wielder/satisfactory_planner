"""The server side, against a temporary scenarios folder — never your own:
factories together (claims, owed outputs, re-solve order, a network plan,
history, reading a save), the Blackboard's data, the HTTP API with odd and
bad input, and the supply (nodes, shards, wells, geysers, imports)."""
import json
import shutil
import struct
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zlib
from http.server import ThreadingHTTPServer
from pathlib import Path

import yaml

import network
import server
import solver
import supply


# ── Factories together: claims, owed outputs, re-solve order, a network plan, history, a save ──
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
        self.assertEqual(supply.used_nodes(raw), ["FrackingSatellite7", "ResourceNode123"])
        with self.assertRaises(ValueError):
            supply.used_nodes(b"not a save")

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
        got = supply.read(raw)
        self.assertEqual(got["recipes"], names)
        u = supply.unlocks(got["recipes"])
        # the game calls the Foundry's recipe Recipe_SmelterMk1
        self.assertEqual(u, {"alts": ["Alt_Compacted_Coal"], "machines": ["Constructor", "Foundry"],
                             "miner": "Mk2", "belt": "Mk4", "pipe": None,
                             # the milestones those come from: the Foundry's Tier 3, the Constructor's HUB upgrade
                             "schematics": ["Schematic_3-4", "Schematic_Tutorial2"]})

    def test_reads_machines_and_storage(self):
        def fstr(t):
            b = t.encode() + b"\x00"
            return struct.pack("<i", len(b)) + b
        F = "/Game/FactoryGame/Buildable/Factory/"
        smelter, box = "Persistent_Level:PersistentLevel.Build_SmelterMk1_C_1", "Persistent_Level:PersistentLevel.Build_StorageContainerMk1_C_2"
        def actor(cls, name, x, y):
            return (struct.pack("<i", 1) + fstr(cls) + fstr("Persistent_Level") + fstr(name) + struct.pack("<I", 0)
                    + struct.pack("<i", 1) + struct.pack("<10f", 0, 0, 0, 1, x * 100, y * 100, 0, 1, 1, 1) + struct.pack("<i", 0))
        heads = [actor(F + "SmelterMk1/Build_SmelterMk1.Build_SmelterMk1_C", smelter, 120, -40),
                 actor(F + "StorageContainerMk1/Build_StorageContainerMk1.Build_StorageContainerMk1_C", box, 0, 0),
                 struct.pack("<i", 0) + fstr("/Script/FactoryGame.FGInventoryComponent") + fstr("Persistent_Level")
                 + fstr(box + ".StorageInventory") + struct.pack("<I", 0) + fstr(box)]
        stack = (b"/Game/FactoryGame/Resource/Parts/IronPlate/Desc_IronPlate.Desc_IronPlate_C\x00" + b"\x00" * 4
                 + b"\x09\x00\x00\x00NumItems\x00\x0c\x00\x00\x00IntProperty\x00" + b"\x04\x00\x00\x00" + b"\x00" * 5
                 + struct.pack("<i", 250))
        bodies = [b"\x00" * 8 + b"mCurrentRecipe\x00" + b"\x00" * 12 + b"/Game/FactoryGame/Recipes/Smelter/Recipe_IngotIron.Recipe_IngotIron_C\x00",
                  b"\x00" * 16, b"mInventoryStacks\x00" + stack + stack]
        toc = struct.pack("<i", 3) + b"".join(heads)
        data = struct.pack("<i", 3) + b"".join(struct.pack("<iii", 46, 0, len(x)) + x for x in bodies)
        level = (struct.pack("<ii", len(toc), 0) + toc + struct.pack("<ii", len(data), 0) + data)
        raw = struct.pack("<I", 0x9E2A83C1) + b"\x00" * 44 + zlib.compress(b"\x00" * 30 + level + b"\x00" * 30)
        got = supply.read(raw)
        self.assertEqual(got["machines"], [{"c": "Build_SmelterMk1", "r": "Recipe_IngotIron", "x": 120.0, "y": -40.0}])
        self.assertEqual(got["stock"], {"Desc_IronPlate": 500})
        self.assertEqual(supply.recipe_keys()["Recipe_IngotIron"], "Iron_Ingot")
        self.assertEqual(supply.item_key("Desc_IronPlateReinforced", server.ALL_ITEMS), "Reinforced_Iron_Plate")
        self.assertEqual(supply.item_key("Desc_IronPlate", server.ALL_ITEMS), "Iron_Plate")


class BuildProgress(_Temp):
    def test_machines_count_toward_the_nearest_factory(self):
        import json
        iron = [k for k, v in supply.map_nodes().items() if v["r"] == "Iron_Ore" and not v.get("w")]
        a, b = supply.map_nodes()[iron[0]], None
        far = next(k for k in iron if abs(supply.map_nodes()[k]["x"] - a["x"]) > 1500)
        b = supply.map_nodes()[far]
        for key, node in (("west", iron[0]), ("east", far)):
            _solved(self, key, resource_nodes=[{"resource": "Iron_Ore", "extractor": "Miner", "nodes": [node]}],
                    objective={"Iron_Ingot": 1})
        need = server._factory_plan("west")[1]["flows"][0]["machines_final"]
        # all the smelters stand by the west factory's node, and its miner is placed; one more by the east
        machines = [["Smelter", "Iron_Ingot", a["x"] + 20, a["y"]] for _ in range(need + 1)]
        machines.append({"m": "Smelter", "r": "Iron_Ingot", "x": b["x"], "y": b["y"] + 10})   # a row as saved before
        server.SAVE_NODES_PATH.write_text(json.dumps({"file": "x.sav", "nodes": [iron[0]], "machines": machines,
                                                      "stock": {"Iron_Rod": 5}}))
        p = server._build_progress()
        west, east = p["factories"]["west"], p["factories"]["east"]
        self.assertEqual(west["lines"]["Iron_Ingot"], [need, need])
        self.assertEqual(west["machines_left"], {})
        self.assertEqual(west["extractors_left"], {})
        # the spare one by the west goes to the east, past its own: 2 of them
        self.assertEqual(east["lines"]["Iron_Ingot"][1], 2)
        self.assertEqual(east["machines_left"]["Smelter"], server._factory_plan("east")[1]["flows"][0]["machines_final"] - 2)
        self.assertEqual(sum(east["extractors_left"].values()), 1)       # its node isn't mined
        self.assertGreater(east["materials_left"]["Iron_Rod"], 0)
        self.assertEqual(p["stock"], {"Iron_Rod": 5})
        self.assertEqual(p["spare"], 0)
        server.SAVE_NODES_PATH.write_text(json.dumps({"nodes": []}))      # a save from before: nothing to say
        self.assertFalse(server._build_progress()["read"])


# ── The Blackboard's data: cards, flows, power, the build list, planning a network ──
def _solved(t, key, **data):
    """Save a factory and cache a real plan for it, as solving it would."""
    d = t.save(key, **data)
    s = server._build_scenario(d)
    r = solver.solve(s, server.ALL_RECIPES, server.MACHINE_META)
    res = solver.result_to_dict(r, s, server.MACHINE_META)
    sig = server._signature(s, [])
    server._cache_store(server._result_key(d["name"]), sig, sig, [], res)
    return d, res


MACHINES = ["Smelter", "Constructor", "Assembler", "Coal_Generator"]


class Cards(_Temp):
    def setUp(self):
        super().setUp()
        import supply
        supply.save_progress({"machines": MACHINES})
        # iron makes plates and rods; frames (no iron ore) builds reinforced plates
        # from iron's plates and rods; the depot stores rods
        _solved(self, "iron", resource_nodes=[{"resource": "Iron_Ore", "extractor": "fixed", "rate": 240}],
                objective={"Iron_Plate": 1}, must_produce={"Iron_Rod": 15},
                to_storage=[{"item": "Iron_Rod", "rate": 10}])
        _solved(self, "wires", resource_nodes=[{"resource": "Copper_Ore", "extractor": "fixed", "rate": 120}],
                from_factories=[{"item": "Iron_Plate", "factory": "iron", "rate": 30},
                                {"item": "Iron_Rod", "factory": "iron", "rate": 5}],
                objective={"Reinforced_Iron_Plate": 1})

    def test_cards(self):
        cards = {c["key"]: c for c in server._blackboard_factories()}
        self.assertEqual(set(cards), {"iron", "wires"})
        iron, wires = cards["iron"], cards["wires"]
        self.assertTrue(iron["solved"] and wires["solved"])
        self.assertGreater(iron["exports"]["Iron_Plate"], 30)
        # who takes what from iron, storage included
        self.assertEqual(iron["taken_by"]["Iron_Plate"], {"wires": 30.0})
        self.assertEqual(iron["taken_by"]["Iron_Rod"], {"wires": 5.0, server.STORAGE: 10.0})
        self.assertEqual(iron["storage"], {"Iron_Rod": 10.0})
        # what wires imports, and from where (the flows the bands draw)
        self.assertEqual(sorted((s["item"], s["factory"], s["rate"]) for s in wires["sources"]),
                         [("Iron_Plate", "iron", 30), ("Iron_Rod", "iron", 5)])
        # the card shows what its plan draws: all 5 rods (they cap its screws), so
        # only the plates those screws can go with — at most the 30 it takes
        self.assertAlmostEqual(wires["imports"]["Iron_Rod"], 5.0, places=3)
        self.assertLessEqual(wires["imports"]["Iron_Plate"], 30.0 + 1e-6)
        # power: machines draw, nothing generates
        p = iron["power"]
        self.assertGreater(p["machines"], 0)
        self.assertEqual(p["generators"], 0)

    def test_import_past_free_comes_out_of_storage(self):
        # iron makes 15 rods: 5 to wires, 10 stored — none free. Importing 8 more
        # takes them out of iron's storage, and iron is saved so
        import yaml
        data = {"name": "frames", "from_factories": [{"item": "Iron_Rod", "factory": "iron", "rate": 8}]}
        moved = server._draw_storage("frames", data)
        self.assertEqual([(m["item"], m["factory"], m["rate"]) for m in moved], [("Iron_Rod", "iron", 8)])
        iron = yaml.safe_load((self.dir / "iron.yaml").read_text())
        self.assertEqual(iron["to_storage"], [{"item": "Iron_Rod", "rate": 2}])
        self.assertEqual(server._hold_claims("frames", data), [])        # it fits now: nothing cut
        self.assertEqual(data["from_factories"][0]["rate"], 8)
        # no more than is stored: the rest is cut as before
        data = {"name": "more", "from_factories": [{"item": "Iron_Rod", "factory": "iron", "rate": 5}]}
        self.save("frames", **{"from_factories": [{"item": "Iron_Rod", "factory": "iron", "rate": 8}]})
        self.assertEqual(server._draw_storage("more", data)[0]["rate"], 2)
        self.assertEqual(server._hold_claims("more", data)[0]["rate"], 2)

    def test_owed_rod_is_made(self):
        # iron must keep making the rods others take and it stores (15 exact covers 15 owed)
        _, res = server._factory_plan("iron")
        self.assertGreaterEqual(res["sink_nodes"]["Iron_Rod"], 15 - 1e-6)

    def test_build_list(self):
        rows = {r["key"]: r for r in server._build_list()}
        self.assertGreater(rows["iron"]["machines"].get("Smelter", 0), 0)
        self.assertGreater(rows["iron"]["materials"].get("Iron_Rod", 0), 0)   # constructors cost rods

    def test_outputs_offer_what_is_left(self):
        o = server._factory_outputs()
        iron = next(f for f in o["factories"] if f["key"] == "iron")
        self.assertIn("Iron_Plate", iron["made"])
        self.assertNotIn("Power", iron["made"])
        self.assertEqual(o["alerts"], {})

    def test_network_counts_what_is_sent_once(self):
        # iron's plan makes 150 plates, 30 of them for frames: the network holds
        # 120 at iron and routes the 30 — not 150 and 30 more
        held = {s["key"]: s["held"] for s in server._network_sites(["iron", "wires"])}
        made = server._factory_plan("iron")[1]["sink_nodes"]["Iron_Plate"]
        self.assertAlmostEqual(held["iron"]["Iron_Plate"], made - 30, places=3)

    def test_routes_are_vehicles(self):
        # belts and pipes stay inside factories: an old belt route is a train now
        b = server._clean_board({"routes": [{"a": "iron", "b": "wires", "mode": "belt"},
                                            {"a": "iron", "b": "wires", "mode": "tractor", "trip_min": 6}]})
        self.assertEqual([r["mode"] for r in b["routes"]], ["train", "tractor"])
        # what 1/min keeps busy: a round trip's worth of loads
        plate = network.STACK.get("Iron_Plate", 100)
        for mode, stacks in (("train", 32), ("truck", 48), ("tractor", 25), ("drone", 9)):
            self.assertAlmostEqual(network._unit_cost("Iron_Plate", {"mode": mode, "trip_min": 6}), 6 / (stacks * plate))
        self.assertAlmostEqual(network._unit_cost("Water", {"mode": "train", "trip_min": 4}), 4 / 1600)
        self.assertIsNone(network._unit_cost("Water", {"mode": "tractor", "trip_min": 4}))

    def test_paths(self):
        # a line runs out and back; a loop goes round; any stop loads for any other
        line, loop = {"stops": ["a", "b", "c"]}, {"stops": ["a", "b", "c", "d"], "loop": True}
        self.assertEqual(network.legs(line), [("a", "b"), ("b", "c"), ("c", "b"), ("b", "a")])
        self.assertEqual(network.legs(loop), [("a", "b"), ("b", "c"), ("c", "d"), ("d", "a")])
        self.assertEqual(network._hops(line, "a", "c"), [0, 1])
        self.assertEqual(network._hops(line, "c", "a"), [2, 3])
        self.assertEqual(network._hops(line, "b", "a"), [3])
        self.assertEqual(network._hops(loop, "c", "b"), [2, 3, 0])     # C loads for B: round by D and A
        self.assertEqual(network._hops(loop, "d", "a"), [3])
        # cleaned: a plain {a, b} is a path of two; repeats and unknown stops go; a loop needs three
        self.assertEqual(server._paths([{"a": "x", "b": "y"}, {"stops": ["x", "y", "x", "zz"], "loop": True, "mode": "drone"},
                                        {"stops": ["x"]}, "junk"], have={"x", "y"}),
                         [{"stops": ["x", "y"], "loop": False, "mode": "train", "trip_min": 4.0},
                          {"stops": ["x", "y"], "loop": False, "mode": "drone", "trip_min": 4.0}])

    def test_network_on_a_loop(self):
        # a loop of three: what one stop sends another rides every leg between
        # them, and the vehicles busy are the heaviest leg's
        _solved(self, "mine", resource_nodes=[{"resource": "Iron_Ore", "extractor": "fixed", "rate": 600}],
                must_produce={"Iron_Plate": 100})
        sites = server._network_sites(["iron", "wires", "mine"])
        rt = {"stops": ["iron", "wires", "mine"], "loop": True, "mode": "train", "trip_min": 3}
        out = network.plan_network(sites, [rt], server.ALL_RECIPES)
        self.assertTrue(out["ok"], out)
        p = out["routes"][0]
        self.assertEqual(len(p["legs"]), 3)
        per = [0.0, 0.0, 0.0]
        for i in p["items"]:
            for h in network._hops(rt, i["from"], i["to"]):
                per[h] += i["load"]
        for l, v in zip(p["legs"], per):
            self.assertAlmostEqual(l["load"], v, places=3)
        self.assertAlmostEqual(p["load"], max(per), places=3)

    def test_network(self):
        sites = server._network_sites(["iron", "wires"])
        out = network.plan_network(sites, [{"a": "iron", "b": "wires", "mode": "train", "trip_min": 1}],
                                   server.ALL_RECIPES)
        self.assertTrue(out["ok"], out)
        rt = out["routes"][0]
        self.assertIn("Iron_Plate", {i["item"] for i in rt["items"] if i["from"] == "iron"})
        # vehicles busy: the heavier way (what comes back rides along)
        self.assertAlmostEqual(rt["load"], max(l["load"] for l in rt["legs"]), places=3)
        self.assertEqual([(l["from"], l["to"]) for l in rt["legs"]], [("iron", "wires"), ("wires", "iron")])
        self.assertAlmostEqual(rt["cars"]["solid"] + rt["cars"]["fluid"], rt["load"], places=3)
        # a factory's own goals are never shipped to it
        goals = {"iron": {"Iron_Plate", "Iron_Rod"}, "wires": {"Reinforced_Iron_Plate"}}
        for i in rt["items"]:
            self.assertNotIn(i["item"], goals[i["to"]])
            self.assertGreater(i["rate"], 0)
        self.assertAlmostEqual(rt["throughput"], sum(i["rate"] for i in rt["items"]), places=2)
        self.assertIn("iron", out["headroom"])

    def test_network_grows_every_goal_together(self):
        sites = server._network_sites(["iron", "wires"])
        rt = [{"a": "iron", "b": "wires", "mode": "train", "trip_min": 1}]
        out = network.plan_network(sites, rt, server.ALL_RECIPES, grow=True)
        self.assertTrue(out["ok"], out)
        t = out["grow"]
        self.assertGreaterEqual(t, 1 - 1e-6)            # never less than now
        for f in out["factories"]:
            for it, g in (f["goal"] or {}).items():     # each at least t × now: none traded for another
                self.assertGreaterEqual(g["then"], g["now"] * t * (1 - 1e-4) - 1e-3, (f["key"], it, g))
        self.assertIsNone(network.plan_network(sites, rt, server.ALL_RECIPES)["grow"])

    def test_compare_trades(self):
        # a mine with iron to spare beside a rod factory short of it: shipping it the
        # ore (or ingots) raises its rods, and no goal anywhere goes down for it
        _solved(self, "mine", resource_nodes=[{"resource": "Iron_Ore", "extractor": "fixed", "rate": 600}],
                must_produce={"Iron_Plate": 100})
        _solved(self, "rods", resource_nodes=[{"resource": "Iron_Ore", "extractor": "fixed", "rate": 60}],
                objective={"Iron_Rod": 1})
        sites = server._network_sites(["mine", "rods"])
        rt = [{"a": "mine", "b": "rods", "mode": "train", "trip_min": 4}]
        out = network.compare_trades(sites, rt, server.ALL_RECIPES, [])
        top = out["trades"][0]
        self.assertEqual((top["from"], top["to"]), ("mine", "rods"))
        self.assertIn(top["item"], {"Iron_Ore", "Iron_Ingot"})
        self.assertGreater(top["gain"]["rods"]["Iron_Rod"], 100)                # more than double
        for t in out["trades"]:                       # nothing bought by cutting a goal
            for k, gs in t["goals"].items():
                for it, g in gs.items():
                    self.assertGreaterEqual(g["then"], out["now"]["goals"][k][it]["then"] - 1e-3)
        self.assertGreaterEqual(out["all"]["score"], top["score"] - 1e-6)      # all together: at least the best one
        self.assertTrue(top["flows"] and top["routes"][0]["cars"]["solid"] > 0)
        # a factory's own goal is made in it, never shipped to it
        self.assertFalse(any(t["to"] == "rods" and t["item"] == "Iron_Rod" for t in out["trades"]))

    def test_a_goal_is_made_to_be_shipped(self):
        # modular: plates maximises plates to send them on; frames makes reinforced
        # plates from them. Shipping plates over raises frames' goal — and plates'
        # goal still counts every plate it makes, kept or sent
        _solved(self, "plates", resource_nodes=[{"resource": "Iron_Ore", "extractor": "fixed", "rate": 480}],
                objective={"Iron_Plate": 1})
        _solved(self, "frames", resource_nodes=[{"resource": "Iron_Ore", "extractor": "fixed", "rate": 60}],
                objective={"Reinforced_Iron_Plate": 1})
        sites = server._network_sites(["plates", "frames"])
        rt = [{"a": "plates", "b": "frames", "mode": "train", "trip_min": 4}]
        out = network.compare_trades(sites, rt, server.ALL_RECIPES, [])
        plate = next(t for t in out["trades"] if (t["from"], t["to"], t["item"]) == ("plates", "frames", "Iron_Plate"))
        self.assertGreater(plate["gain"]["frames"]["Reinforced_Iron_Plate"], 50)
        made = plate["goals"]["plates"]["Iron_Plate"]
        self.assertGreaterEqual(made["then"], out["now"]["goals"]["plates"]["Iron_Plate"]["then"] - 1e-3)
        sent = sum(f["rate"] for f in plate["flows"] if f["item"] == "Iron_Plate")
        self.assertGreater(sent, 10)                                   # and they really go over
        # growing every goal: plates' shipped plates count toward its own
        g = network.plan_network(sites, rt, server.ALL_RECIPES, grow=True)
        self.assertGreaterEqual(g["grow"], 1 - 1e-6)

    def test_grid_geothermal(self):
        import supply
        m = supply.map_nodes()
        pure = [k for k, v in m.items() if v["r"] == "Geyser" and v["p"] == "pure"][:2]
        ore = next(k for k, v in m.items() if v["r"] == "Iron_Ore")
        # only geysers are kept, once each
        server._save_board({"geysers": pure + [pure[0], ore, "nope", 5]})
        self.assertEqual(server._load_board()["geysers"], sorted(pure))
        g = server._grid()
        self.assertEqual((g["count"], g["mw"], g["low"], g["high"]), (2, 800.0, 400.0, 1200.0))
        self.assertEqual(g["cost"]["Wire"], 500)
        grid = next(r for r in server._build_list() if r["key"] == "@grid")
        self.assertEqual(grid["extractors"], {supply.GEOTHERMAL: 2})


# ── The HTTP API: every answer JSON with a sensible status, 400 for input it can't use ──
class Picks(unittest.TestCase):
    """Recipes picked on the goal tree are offered to the solver (allowed, not forced)."""
    def test_picked_alternate_is_allowed(self):
        sc = server._build_scenario(server._clean_scenario({"name": "p", "alternate_recipes_enabled": [],
            "recipe_picks": {"Iron_Ingot": "Alt_Iron_Alloy_Ingot", "Screw": "nope"}}))
        self.assertIn("Alt_Iron_Alloy_Ingot", sc.alternate_recipes_enabled)
        self.assertEqual(server._clean_scenario({"recipe_picks": {"Screw": "nope", "Wire": 3}})["recipe_picks"], {})


class API(_Temp):
    def setUp(self):
        super().setUp()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def call(self, method, path, body=None, raw=None, ctype="application/json"):
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": ctype})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def test_unchanged_files_answer_304(self):
        import gzip
        for path in ("/frontend/main.js", "/api/boot"):
            req = urllib.request.Request(self.base + path, headers={"Accept-Encoding": "gzip"})
            with urllib.request.urlopen(req) as r:
                tag, body = r.headers["ETag"], gzip.decompress(r.read())
            self.assertTrue(tag and body)
            req = urllib.request.Request(self.base + path, headers={"If-None-Match": tag})
            with self.assertRaises(urllib.error.HTTPError) as e:   # urllib raises on a 304
                urllib.request.urlopen(req)
            self.assertEqual(e.exception.code, 304)

    def test_solve_answers_when_done(self):
        sc = {"name": "w", "available_resources": {"Iron_Ore": 60}, "objective": {"Iron_Ingot": 1}}
        code, d = self.call("POST", "/api/solve", {**sc, "solve_styles": [], "base_scenario": sc})
        code, r = self.call("GET", f"/api/solve/{d['job_id']}?wait=1")      # no polling: the plan itself
        self.assertEqual((code, r["status"]), (200, "done"))
        self.assertAlmostEqual(r["result"]["objective_value"], 60, places=3)

    def test_an_out_of_date_plan_still_comes_along(self):
        # a plan made before a change opens with the factory, to be solved afresh
        d, res = _solved(self, "old", resource_nodes=[{"resource": "Iron_Ore", "extractor": "fixed", "rate": 60}],
                         objective={"Iron_Ingot": 1})
        got = self.call("GET", "/api/scenarios/old")[1]
        self.assertIn("_last_solve", got)
        self.assertNotIn("_stale_solve", got)
        key = server._result_key("old")
        entry = server._cache_read(key)
        server._cache_write(key, {**entry, "base_sig": "made-by-an-older-planner", "sig": "x"})
        server._mem_cache.clear()
        got = self.call("GET", "/api/scenarios/old")[1]
        self.assertNotIn("_last_solve", got)
        self.assertAlmostEqual(got["_stale_solve"]["result"]["objective_value"], res["objective_value"])

    def test_storage_set_from_elsewhere(self):
        self.save("depot", to_storage=[{"item": "Iron_Plate", "rate": 5}, {"item": "Wire", "rate": 3}])
        code, d = self.call("POST", "/api/storage", {"key": "depot", "item": "Iron_Plate", "rate": 9})
        self.assertEqual((code, d["rate"]), (200, 9))
        got = self.call("GET", "/api/scenarios/depot")[1]["to_storage"]
        self.assertEqual(sorted((t["item"], t["rate"]) for t in got), [("Iron_Plate", 9), ("Wire", 3)])
        self.call("POST", "/api/storage", {"key": "depot", "item": "Wire", "rate": 0})
        self.assertEqual([t["item"] for t in self.call("GET", "/api/scenarios/depot")[1]["to_storage"]], ["Iron_Plate"])
        for bad in ({"key": "../x", "item": "Wire"}, {"key": "nope", "item": "Wire"}, {"key": "depot", "item": "Nope"}):
            self.assertEqual(self.call("POST", "/api/storage", bad)[0], 400)

    def test_keys_stay_in_their_folder(self):
        for method, path in (("GET", "/api/scenarios/../../x"), ("POST", "/api/scenarios/..%2Fevil"),
                             ("DELETE", "/api/scenarios/../x"), ("GET", "/api/history/../x"),
                             ("POST", "/api/history/../../x/restore")):
            code, _ = self.call(method, path, {"name": "x"} if method == "POST" else None)
            self.assertEqual(code, 400, path)
        code, _ = self.call("GET", "/frontend/../server.py")
        self.assertEqual(code, 404)
        self.assertEqual(sorted(p.name for p in self.dir.glob("*.yaml")), [])

    def test_forgetting_save_nodes(self):
        # unmark nodes the save mines (no factory has them); its machines and storage stay
        server.SAVE_NODES_PATH.parent.mkdir(parents=True, exist_ok=True)
        server.SAVE_NODES_PATH.write_text(json.dumps({"file": "x.sav", "nodes": ["n1", "n2", "n3"],
                                                      "machines": [["Smelter", None, 0, 0]], "stock": {"Iron_Plate": 5}}))
        code, out = self.call("DELETE", "/api/save-nodes", {"ids": ["n1", "n3"]})
        self.assertEqual((code, out["nodes"], out["forgot"]), (200, ["n2"], 2))
        sv = json.loads(server.SAVE_NODES_PATH.read_text())
        self.assertEqual((sv["nodes"], sv["stock"], len(sv["machines"])), (["n2"], {"Iron_Plate": 5}, 1))
        self.assertEqual(self.call("DELETE", "/api/save-nodes", {})[1]["nodes"], [])      # no ids: every one

    def test_bad_bodies_are_400(self):
        for path in ("/api/scenarios/a", "/api/solve", "/api/progress", "/api/blackboard", "/api/network"):
            self.assertEqual(self.call("POST", path, raw=b"{not json")[0], 400, path)
        self.assertEqual(self.call("POST", "/api/scenarios/a", raw=b"[1, 2]")[0], 400)
        self.assertEqual(self.call("POST", "/api/unlocked-alts", {"unlocked": "x"})[0], 400)
        self.assertEqual(self.call("POST", "/api/resolve-chain", {"keys": "x"})[0], 400)
        self.assertEqual(self.call("POST", "/api/save-file", raw=b"nope", ctype="application/octet-stream")[0], 400)
        self.assertEqual(self.call("POST", "/api/map-image", raw=b"xx", ctype="text/plain")[0], 400)

    def test_scenarios_are_cleaned(self):
        code, out = self.call("POST", "/api/scenarios/t", {
            "name": "  T  ", "power_shards_available": "-3", "max_power_mw": "abc",
            "resource_nodes": [{"resource": "Iron_Ore", "extractor": "Miner", "count": "x", "shards": 9},
                               {"extractor": "fixed", "rate": 5}],
            "from_factories": [{"item": "Plastic", "factory": "oil", "rate": "lots"}, {"item": None}],
            "to_storage": [{"item": "Wire", "rate": -5}, {"rate": 3}]})
        self.assertEqual(code, 200)
        _, d = self.call("GET", "/api/scenarios/t")
        self.assertEqual(d["name"], "T")
        self.assertEqual(d["power_shards_available"], 0)
        self.assertIsNone(d.get("max_power_mw"))
        self.assertEqual(d["resource_nodes"], [{"resource": "Iron_Ore", "extractor": "Miner", "count": 1, "shards": 3}])
        self.assertEqual(d["from_factories"], [{"item": "Plastic", "factory": "oil", "rate": 0.0}])
        self.assertEqual(d["to_storage"], [{"item": "Wire", "rate": 0.0}])

    def test_unknown_factories_are_skipped(self):
        code, out = self.call("POST", "/api/network", {"routes": [{"a": "nope", "b": "gone"}, "x"]})
        self.assertEqual(code, 200)
        self.assertEqual(out["routes"], [])
        code, out = self.call("POST", "/api/apply-network", {"flows": [{"from": "a"}, 5], "alts": "x"})
        self.assertEqual((code, out["changed"]), (200, []))
        self.assertEqual(self.call("POST", "/api/blackboard", {"routes": "bad", "positions": 3, "geysers": ["nope", 4]})[0], 200)
        _, b = self.call("GET", "/api/blackboard")
        self.assertEqual(b["layout"], {"positions": {}, "routes": [], "geysers": []})

    def test_backups_and_history_refuse_bad_input(self):
        self.assertEqual(self.call("POST", "/api/restore", raw=b"not a zip", ctype="application/zip")[0], 400)
        self.assertEqual(self.call("POST", "/api/restore", {"file": "../server.py"})[0], 400)
        self.assertEqual(self.call("GET", "/api/backup/..%2Fserver.py")[0], 404)
        self.assertEqual(self.call("POST", "/api/history/x/../confirm", {"on": True})[0], 400)
        self.assertEqual(self.call("POST", "/api/history/nope/v1/confirm", {"on": True})[0], 400)
        code, b = self.call("POST", "/api/backup", {})
        self.assertEqual((code, len(b["backups"])), (200, 1))
        self.assertEqual(self.call("GET", "/api/grid-status")[0], 200)

    def test_map_picture_game_then_yours_then_game(self):
        import server
        self.assertEqual(self.call("GET", "/api/map-settings")[1]["source"], None)       # no game map in tests
        (server.MAP_IMAGE_DIR / "map_game.avif").write_bytes(b"avif")
        st = self.call("GET", "/api/map-settings")[1]
        self.assertEqual((st["source"], st["ext"], st["dx"], st["scale"]), ("game", "avif", 0.0, 1.0))
        self.call("POST", "/api/map-settings", {"dx": 30, "opacity": 0.4})              # nudges are yours only
        st = self.call("GET", "/api/map-settings")[1]
        self.assertEqual((st["dx"], st["opacity"]), (0.0, 0.4))
        code, st = self.call("POST", "/api/map-image", raw=b"png", ctype="image/png")
        self.assertEqual((code, st["source"], st["ext"], st["dx"]), (200, "own", "png", 30.0))
        code, st = self.call("DELETE", "/api/map-image")
        self.assertEqual((code, st["source"]), (200, "game"))
        with urllib.request.urlopen(self.base + "/api/map-image") as r:
            self.assertEqual((r.headers["Content-Type"], r.read()), ("image/avif", b"avif"))

    def test_map_tiles(self):
        # the picture as tiles, cut in the browser: kept, counted level by level, and
        # stale once the picture is newer
        import os
        import server
        pic = server.MAP_IMAGE_DIR / "map_game.avif"
        pic.write_bytes(b"avif")
        self.assertEqual(self.call("GET", "/api/map-settings")[1]["tiles"], 0)
        post = lambda z, x, y, ctype="image/webp": self.call("POST", f"/api/map-tile?z={z}&x={x}&y={y}", raw=b"w%d%d%d" % (z, x, y), ctype=ctype)
        self.assertEqual(post(0, 0, 0)[0], 200)
        self.assertEqual(self.call("GET", "/api/map-settings")[1]["tiles"], 1)
        for x in range(2):
            for y in range(2):
                post(1, x, y)
        self.assertEqual(self.call("GET", "/api/map-settings")[1]["tiles"], 2)
        with urllib.request.urlopen(self.base + "/api/map-tile?z=1&x=1&y=0") as r:
            self.assertEqual((r.headers["Content-Type"], r.read()), ("image/webp", b"w110"))
            tag = r.headers["ETag"]
        with self.assertRaises(urllib.error.HTTPError) as e:     # unchanged: a 304, nothing sent
            urllib.request.urlopen(urllib.request.Request(self.base + "/api/map-tile?z=1&x=1&y=0", headers={"If-None-Match": tag}))
        self.assertEqual(e.exception.code, 304)
        # out of range, or not a picture: refused
        self.assertEqual(post(3, 0, 0)[0], 400)
        self.assertEqual(post(1, 2, 0)[0], 400)
        self.assertEqual(post(0, 0, 0, "text/plain")[0], 400)
        self.assertEqual(self.call("GET", "/api/map-tile?z=2&x=0&y=0")[0], 404)
        # a newer picture: its old tiles don't count
        t = pic.stat().st_mtime_ns + 10 ** 9
        os.utime(pic, ns=(t, t))
        self.assertEqual(self.call("GET", "/api/map-settings")[1]["tiles"], 0)
        # your own picture: its tiles go with it
        self.call("POST", "/api/map-image", raw=b"png", ctype="image/png")
        post(0, 0, 0)
        self.assertTrue((server.MAP_IMAGE_DIR / "map_tiles" / "map_image").exists())
        self.call("DELETE", "/api/map-image")
        self.assertFalse((server.MAP_IMAGE_DIR / "map_tiles" / "map_image").exists())

    def test_map_settings_stay_numbers(self):
        _, st = self.call("POST", "/api/map-settings", {"dx": "abc", "scale": -1, "opacity": 7})
        self.assertEqual((st["dx"], st["scale"], st["opacity"]), (0.0, 0.05, 1.0))
        self.assertEqual(self.call("GET", "/api/map-image")[0], 404)   # still answers


# ── Supply: nodes, shards, wells, geysers and imports (supply.py) ──
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
    """Tier + sub-tier and MAM research: what each recipe waits on (the unlocks in data/game.json)."""
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
        import json
        g = supply.GAME["classes"]
        done = supply.schematics_done({g["recipes"]["Computer"], g["machines"]["Refinery"]})
        self.assertEqual(done, ["Schematic_5-1", "Schematic_5-2"])


if __name__ == "__main__":
    unittest.main()
