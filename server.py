"""
Satisfactory Factory Planner — HTTP Server
===========================================
Single-file stdlib HTTP server. No Flask, no Vite, no Node.
Serves index.html + frontend/* statically and handles /api/* in-process.

Intended to be imported and started by app.py.
Can also be run directly for browser-only use:

    python server.py
    python server.py 5001   # custom port
"""

import json, sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import yaml

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from solver import (
    load_recipes, load_machine_meta, load_scenario, solve,
    result_to_dict, list_scenarios, get_all_items, Scenario, SCENARIOS_DIR
)

ALL_RECIPES  = load_recipes()
MACHINE_META = load_machine_meta()

print(f"🏭 Satisfactory Planner — {len(ALL_RECIPES)} recipes "
      f"({sum(1 for r in ALL_RECIPES.values() if r.alternate)} alternates)")


# ── Scenario builder ──────────────────────────────────────────────────────────

def _build_scenario(b: dict) -> Scenario:
    return Scenario(
        name=b.get("name", "Scenario"),
        description=b.get("description", ""),
        alternate_recipes_enabled=b.get("alternate_recipes_enabled", []) or [],
        enabled_machines=b.get("enabled_machines", []) or [],
        available_resources={k: float(v) for k, v in (b.get("available_resources") or {}).items()},
        must_produce={k: float(v) for k, v in (b.get("must_produce") or {}).items()},
        min_produce={k: float(v) for k, v in (b.get("min_produce") or {}).items()},
        max_produce={k: float(v) for k, v in (b.get("max_produce") or {}).items()},
        objective={k: float(v) for k, v in (b.get("objective") or {}).items()},
        power_shards_available=int(b.get("power_shards_available") or 0),
        somersloops_available=int(b.get("somersloops_available") or 0),
        max_power_mw=float(b["max_power_mw"]) if b.get("max_power_mw") else None,
        max_machines=int(b["max_machines"]) if b.get("max_machines") else None,
        notes=b.get("notes", "") or "",
    )


# ── MIME types ────────────────────────────────────────────────────────────────

_MIME = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".yaml": "text/yaml; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}


# ── Request handler ───────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        print(f"  {self.command} {self.path.split('?')[0]} → {args[1]}")

    # ── Send helpers ──────────────────────────────────────────────────────────

    def _send(self, code: int, body: bytes, ctype: str = "application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj, default=str).encode())

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def _scenario_path(self, name: str) -> Path:
        SCENARIOS_DIR.mkdir(exist_ok=True)
        return SCENARIOS_DIR / f"{name}.yaml"

    def _serve_file(self, fpath: Path):
        if not fpath.exists() or not fpath.is_file():
            self._json(404, {"error": f"Not found: {fpath.name}"})
            return
        ctype = _MIME.get(fpath.suffix.lower(), "application/octet-stream")
        self._send(200, fpath.read_bytes(), ctype)

    # ── CORS preflight ────────────────────────────────────────────────────────

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    # ── GET ───────────────────────────────────────────────────────────────────

    def do_GET(self):
        parsed = urlparse(self.path)
        path   = parsed.path.rstrip("/") or "/"
        qs     = parse_qs(parsed.query)

        # ── Static files ──────────────────────────────────────────────────────

        if path in ("/", "/index.html"):
            self._serve_file(HERE / "index.html")
            return

        if path.startswith("/frontend/"):
            self._serve_file(HERE / path.lstrip("/"))
            return

        # ── API routes ────────────────────────────────────────────────────────

        if path == "/api/items":
            q     = qs.get("q", [""])[0].lower().replace(" ", "_")
            all_i = get_all_items(ALL_RECIPES)
            if q:
                matched  = [i for i in all_i if i.lower().startswith(q)]
                matched += [i for i in all_i if q in i.lower() and not i.lower().startswith(q)]
                self._json(200, matched[:14])
            else:
                self._json(200, all_i)
            return

        if path == "/api/recipes":
            self._json(200, {
                k: {"display": r.display, "machine": r.machine,
                    "alternate": r.alternate, "inputs": r.inputs, "outputs": r.outputs}
                for k, r in ALL_RECIPES.items()
            })
            return

        if path == "/api/item-display":
            disp = {key: key.replace("_", " ")
                    for r in ALL_RECIPES.values()
                    for key in list(r.inputs) + list(r.outputs)}
            disp.update({
                "Circuit_Board_HS":  "AI Limiter",
                "Lightweight_Frame": "Radio Control Unit",
                "Screw":             "Screws",
            })
            self._json(200, disp)
            return

        if path == "/api/scenarios":
            out = []
            for name in list_scenarios():
                try:
                    s = load_scenario(self._scenario_path(name))
                    out.append({"key": name, "name": s.name,
                                "description": s.description,
                                "resources": list(s.available_resources.keys()),
                                "objectives": list(s.objective.keys())})
                except Exception as e:
                    out.append({"key": name, "name": name, "error": str(e)})
            self._json(200, out)
            return

        if path.startswith("/api/scenarios/"):
            name = path[len("/api/scenarios/"):]
            p    = self._scenario_path(name)
            if not p.exists():
                self._json(404, {"error": "Not found"})
                return
            with open(p) as f:
                self._json(200, yaml.safe_load(f))
            return

        self._json(404, {"error": "Not found"})

    # ── POST / PUT ────────────────────────────────────────────────────────────

    def do_POST(self): self._handle_write()
    def do_PUT(self):  self._handle_write()

    def _handle_write(self):
        path = urlparse(self.path).path.rstrip("/")

        if path == "/api/solve-inline":
            b = self._read_json()
            if not b:
                self._json(400, {"error": "No data"})
                return
            try:
                s      = _build_scenario(b)
                result = solve(s, ALL_RECIPES)
                self._json(200, result_to_dict(result, s, MACHINE_META))
            except Exception as e:
                import traceback; traceback.print_exc()
                self._json(500, {"error": str(e)})
            return

        if path.startswith("/api/scenarios/"):
            name = path[len("/api/scenarios/"):]
            data = self._read_json()
            p    = self._scenario_path(name)
            with open(p, "w") as f:
                yaml.dump(data, f, default_flow_style=False, sort_keys=False)
            self._json(200, {"status": "saved", "key": name})
            return

        self._json(404, {"error": "Not found"})

    # ── DELETE ────────────────────────────────────────────────────────────────

    def do_DELETE(self):
        path = urlparse(self.path).path.rstrip("/")
        if path.startswith("/api/scenarios/"):
            name = path[len("/api/scenarios/"):]
            p    = self._scenario_path(name)
            if p.exists():
                p.unlink()
                self._json(200, {"status": "deleted"})
            else:
                self._json(404, {"error": "Not found"})
            return
        self._json(404, {"error": "Not found"})


# ── Standalone entry point (browser-only mode) ────────────────────────────────

def run(port: int = 5000):
    httpd = HTTPServer(("127.0.0.1", port), Handler)
    print(f"   http://127.0.0.1:{port}/  —  Ctrl+C to stop\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 Stopped.")


if __name__ == "__main__":
    run(int(sys.argv[1]) if len(sys.argv) > 1 else 5000)
