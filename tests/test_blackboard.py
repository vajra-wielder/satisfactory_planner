"""The Blackboard's data (server.py, network.py, logistics.py): what each
factory card shows, the declared flows between factories, power, the build
list, and planning a network. Runs on a temporary scenarios folder."""
import solver
import server
import network
from tests.test_factories import _Temp


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

    def test_network(self):
        sites = server._network_sites(["iron", "wires"])
        out = network.plan_network(sites, [{"a": "iron", "b": "wires", "mode": "belt", "trip_min": 1}],
                                   server.ALL_RECIPES)
        self.assertTrue(out["ok"], out)
        rt = out["routes"][0]
        self.assertIn("Iron_Plate", {i["item"] for i in rt["items"] if i["from"] == "iron"})
        # a factory's own goals are never shipped to it
        goals = {"iron": {"Iron_Plate", "Iron_Rod"}, "wires": {"Reinforced_Iron_Plate"}}
        for i in rt["items"]:
            self.assertNotIn(i["item"], goals[i["to"]])
            self.assertGreater(i["rate"], 0)
        self.assertAlmostEqual(rt["throughput"], sum(i["rate"] for i in rt["items"]), places=2)
        self.assertIn("iron", out["headroom"])

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

