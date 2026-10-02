"""The HTTP API with odd and bad input: every answer is JSON with a sensible
status — 400 for input it can't use, never a dropped connection or a write
outside the scenarios folder. A real server on a temporary folder."""
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import server
from tests.test_factories import _Temp


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

    def test_keys_stay_in_their_folder(self):
        for method, path in (("GET", "/api/scenarios/../../x"), ("POST", "/api/scenarios/..%2Fevil"),
                             ("DELETE", "/api/scenarios/../x"), ("GET", "/api/history/../x"),
                             ("POST", "/api/history/../../x/restore")):
            code, _ = self.call(method, path, {"name": "x"} if method == "POST" else None)
            self.assertEqual(code, 400, path)
        code, _ = self.call("GET", "/frontend/../server.py")
        self.assertEqual(code, 404)
        self.assertEqual(sorted(p.name for p in self.dir.glob("*.yaml")), [])

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
        self.assertEqual(self.call("POST", "/api/blackboard", {"routes": "bad", "positions": 3})[0], 200)
        _, b = self.call("GET", "/api/blackboard")
        self.assertEqual(b["layout"], {"positions": {}, "routes": []})

    def test_map_settings_stay_numbers(self):
        _, st = self.call("POST", "/api/map-settings", {"dx": "abc", "scale": -1, "opacity": 7})
        self.assertEqual((st["dx"], st["scale"], st["opacity"]), (0.0, 0.05, 1.0))
        self.assertEqual(self.call("GET", "/api/map-image")[0], 404)   # still answers


if __name__ == "__main__":
    unittest.main()
