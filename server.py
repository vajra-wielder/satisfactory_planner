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

import gzip, json, os, sys, tempfile, threading
from http.server import HTTPServer, BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import yaml

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from solver import (
    load_recipes, load_machine_meta, load_scenario, solve,
    result_to_dict, list_scenarios, get_all_items, Scenario, SCENARIOS_DIR,
    analyse,
)
import logistics

ALL_RECIPES  = load_recipes()
MACHINE_META = load_machine_meta()
ALL_ITEMS    = get_all_items(ALL_RECIPES)   # computed once; never changes at runtime

# ── Unlocked alternates persistence ───────────────────────────────────────────
UNLOCKED_PATH = HERE / "data" / "unlocked_alts.yaml"

def _load_unlocked_alts() -> list:
    """Return the list of unlocked alt recipe keys, or [] if the file is absent/empty."""
    try:
        if not UNLOCKED_PATH.exists():
            return []
        raw = yaml.safe_load(UNLOCKED_PATH.read_text(encoding="utf-8"))
        return list(raw.get("unlocked") or []) if isinstance(raw, dict) else []
    except Exception:
        return []

def _save_unlocked_alts(keys: list) -> None:
    UNLOCKED_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Preserve the header comment by writing YAML manually for the simple list case
    lines = [
        "# unlocked_alts.yaml — Permanent alternate recipe unlocks\n",
        "# Edit this file or use the in-app 'Manage Unlocked Alts' button.\n",
        "unlocked:\n",
    ]
    if keys:
        lines += [f"  - {k}\n" for k in sorted(set(keys))]
    else:
        lines.append("  []\n")
    UNLOCKED_PATH.write_text("".join(lines), encoding="utf-8")

# Pre-serialise static responses to bytes at startup so the handlers can return
# them directly without calling json.dumps on every request.

# /api/boot — single combined payload so the frontend makes one round-trip
# instead of three (/api/items, /api/recipes, /api/item-display) on startup.
_BOOT_BYTES = None   # filled in below after _RECIPES_BYTES / _ITEM_DISPLAY_BYTES are built

_RECIPES_BYTES = json.dumps({
    k: {"display": r.display, "machine": r.machine,
        "alternate": r.alternate, "inputs": r.inputs, "outputs": r.outputs}
    for k, r in ALL_RECIPES.items()
}, default=str).encode()

_ITEM_DISPLAY_BYTES = json.dumps(
    dict(
        sorted({
            **{key: key.replace("_", " ")
               for r in ALL_RECIPES.values()
               for key in list(r.inputs) + list(r.outputs)},
            # Internal names that differ from the in-game ones
            "Circuit_Board_HS":           "AI Limiter",
            "Lightweight_Frame":          "Radio Control Unit",
            "Screw":                      "Screws",
            "Uranium_Ore":                "Uranium",
            "Nuclear_Waste":              "Uranium Waste",
            "Non_Fissible_Uranium":       "Non-Fissile Uranium",
            "SAM_Ingot":                  "Reanimated SAM",
            "High_Speed_Connector":       "High-Speed Connector",
            "Iodine_Infused_Filter":      "Iodine-Infused Filter",
            "Neural_Quantum_Processor":   "Neural-Quantum Processor",
            "Cartridge_Standard":         "Rifle Ammo",
            "Cartridge_Chaos":            "Turbo Rifle Ammo",
            "Cartridge_Smart_Projectile": "Homing Rifle Ammo",
            "Nobelisk_Shockwave":         "Pulse Nobelisk",
            "Spiked_Rebar":               "Iron Rebar",
            "Rebar_Explosive":            "Explosive Rebar",
            "Rebar_Spreadshot":           "Shatter Rebar",
            "Rebar_Stunshot":             "Stun Rebar",
            "Hog_Parts":                  "Hog Remains",
            "Hatcher_Parts":              "Hatcher Remains",
            "Spitter_Parts":              "Spitter Remains",
            "Stinger_Parts":              "Stinger Remains",
        }.items())
    ),
    default=str
).encode()

_BOOT_BYTES = None   # rebuilt after unlocked alts are loaded (done in Handler on first request)

def _build_boot_bytes():
    return json.dumps({
        "items":        ALL_ITEMS,
        "recipes":      {k: {"display": r.display, "machine": r.machine,
                             "alternate": r.alternate, "inputs": r.inputs, "outputs": r.outputs}
                         for k, r in ALL_RECIPES.items()},
        "item_display": json.loads(_ITEM_DISPLAY_BYTES),
        "unlocked_alts": _load_unlocked_alts(),
    }, default=str).encode()

# Cache the last solved scenario so /api/duals can re-use it without re-solving.
_dual_cache: dict = {}   # {'scenario', 'usable', 'flows', 'analysis' (once computed)}
_dual_lock = threading.Lock()

# Scenario list cache — keyed by (name, mtime) pairs so stale entries auto-invalidate.
_scenario_list_cache: dict = {}   # {frozenset of (name, mtime): list[dict]}

# Per-scenario load cache — keyed by (name, mtime); invalidates on any file change.
_scenario_load_cache: dict = {}   # {(name, mtime): dict}

# ── Solve result cache ────────────────────────────────────────────────────────
# The last solve of each scenario is kept in scenarios/.results/<key>.json with
# a signature of everything that determines it, so reopening a scenario shows
# its last plan at once and re-solving unchanged inputs is instant. The
# signature covers the solver inputs (not name/description/notes), the
# unlocked alts, the solve modifiers, and the recipe data + solver code
# themselves — editing either invalidates every cached plan.
import hashlib
from collections import OrderedDict
from dataclasses import asdict
RESULTS_DIR = SCENARIOS_DIR / ".results"
_CODE_SIG = hashlib.sha256(
    (HERE / "solver.py").read_bytes() + (HERE / "data" / "recipes_complete.yaml").read_bytes()
).hexdigest()[:16]
_mem_cache: "OrderedDict[str, dict]" = OrderedDict()   # signature → result (this session)
_MEM_CACHE_SIZE = 32
_cache_lock = threading.Lock()

def _signature(s: Scenario, styles=()) -> str:
    d = asdict(s)
    for f in ("name", "description", "notes"):
        d.pop(f, None)
    d["unlocked_alt_recipes"] = sorted(d.get("unlocked_alt_recipes") or [])
    blob = json.dumps({"s": d, "styles": sorted(styles), "code": _CODE_SIG},
                      sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()

def _result_key(name: str) -> str:
    # Same key the frontend saves the scenario under (see handleSave)
    return "".join(ch for ch in "_".join(name.split()).lower() if ch.isalnum() or ch in "_-") or "scenario"

# Entries are gzipped compact JSON (≈10× smaller); plain .json files from
# before are still read and replaced on the next write. The folder keeps the
# _RESULTS_KEEP most recently written scenarios.
_RESULTS_KEEP = 64

def _cache_paths(key: str):
    return RESULTS_DIR / f"{key}.json.gz", RESULTS_DIR / f"{key}.json"

def _cache_read(key: str):
    gz, plain = _cache_paths(key)
    try:
        if gz.exists():
            return json.loads(gzip.decompress(gz.read_bytes()))
        if plain.exists():
            return json.loads(plain.read_text())
    except Exception:
        pass
    return None

def _cache_write(key: str, entry: dict) -> None:
    try:
        RESULTS_DIR.mkdir(exist_ok=True)
        gz, plain = _cache_paths(key)
        data = gzip.compress(json.dumps(entry, separators=(",", ":"), default=str).encode(), 6)
        fd, tmp = tempfile.mkstemp(dir=RESULTS_DIR, prefix=f".{key}_", suffix=".tmp")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, gz)
        plain.unlink(missing_ok=True)
        # Keep the folder bounded: the oldest entries go first
        files = sorted((p for p in RESULTS_DIR.iterdir() if p.name.endswith((".json", ".json.gz"))),
                       key=lambda p: p.stat().st_mtime, reverse=True)
        for p in files[_RESULTS_KEEP:]:
            p.unlink(missing_ok=True)
    except Exception:
        import traceback; traceback.print_exc()

def _cache_lookup(key: str, sig: str):
    with _cache_lock:
        if sig in _mem_cache:
            _mem_cache.move_to_end(sig)
            return _mem_cache[sig]
    entry = _cache_read(key)
    if entry and entry.get("sig") == sig:
        return entry.get("result")
    return None

def _cache_store(key: str, sig: str, base_sig: str, styles, result: dict) -> None:
    with _cache_lock:
        _mem_cache[sig] = result
        _mem_cache.move_to_end(sig)
        while len(_mem_cache) > _MEM_CACHE_SIZE:
            _mem_cache.popitem(last=False)
    _cache_write(key, {"sig": sig, "base_sig": base_sig, "styles": list(styles), "result": result})

def _set_dual_cache(s, result_dict: dict, usable=None) -> None:
    new_cache = {
        "scenario": s,
        "usable": usable,
        "flows": result_dict.get("flows", []),
        "goal": result_dict.get("objective_value"),
    }
    with _dual_lock:
        _dual_cache.clear()
        _dual_cache.update(new_cache)


# ── Blackboard ────────────────────────────────────────────────────────────────
# Every saved scenario is a whole factory, a black box on the board showing
# only what it imports and exports (logistics.factory_io), from its last plan
# when that plan still matches the scenario. The board's layout — card
# positions, links between factories, belt and pipe tiers — is one file.
BOARD_PATH = HERE / "data" / "blackboard.yaml"

def _load_board() -> dict:
    try:
        raw = yaml.safe_load(BOARD_PATH.read_text(encoding="utf-8")) if BOARD_PATH.exists() else None
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}

def _save_board(layout: dict) -> None:
    keep = {k: layout[k] for k in ("positions", "links", "belt", "pipe") if k in layout}
    BOARD_PATH.parent.mkdir(parents=True, exist_ok=True)
    BOARD_PATH.write_text(yaml.safe_dump(keep, sort_keys=False), encoding="utf-8")

def _blackboard_factories() -> list:
    out = []
    for p in sorted(SCENARIOS_DIR.glob("*.yaml")):
        try:
            data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        except Exception:
            continue
        result = None
        entry = _cache_read(_result_key(data.get("name", p.stem)))
        if entry and entry.get("result"):
            try:
                if entry.get("base_sig") == _signature(_build_scenario(data), entry.get("styles") or []):
                    result = entry["result"]
            except Exception:
                pass
        io = logistics.factory_io(data, result)
        out.append({"key": p.stem, "name": data.get("name", p.stem), **io})
    return out


# ── Async solve job store ─────────────────────────────────────────────────────
import uuid as _uuid
_jobs: dict = {}   # {job_id: {"status": "pending"|"done"|"error", "result": dict|None}}
_jobs_lock = threading.Lock()

def _run_solve_job(job_id: str, s, all_recipes, machine_meta, cache=None):
    """Runs in a background thread; writes result into _jobs when done.
    cache = (key, sig, base_sig, styles) to store the result under."""
    try:
        result = solve(s, all_recipes, machine_meta)
        d      = result_to_dict(result, s, machine_meta)
        _set_dual_cache(s, d, getattr(result, "usable", None))
        if cache is not None and d.get("status", "").startswith("Optimal"):
            _cache_store(*cache, d)
        with _jobs_lock:
            _jobs[job_id] = {"status": "done", "result": d}
    except Exception as e:
        import traceback; traceback.print_exc()
        with _jobs_lock:
            _jobs[job_id] = {"status": "error", "result": {"error": str(e)}}

print(f"🏭 Satisfactory Planner — {len(ALL_RECIPES)} recipes "
      f"({sum(1 for r in ALL_RECIPES.values() if r.alternate)} alternates)")


# ── Scenario builder ──────────────────────────────────────────────────────────

def _build_scenario(b: dict) -> Scenario:
    # Inject unlocked alts from disk so they're always available to the solver
    # without the frontend needing to send them in every request.
    unlocked = _load_unlocked_alts()
    return Scenario(
        name=b.get("name", "Scenario"),
        description=b.get("description", ""),
        alternate_recipes_enabled=b.get("alternate_recipes_enabled", []) or [],
        enabled_machines=b.get("enabled_machines", []) or [],
        available_resources={k: float(v) for k, v in (b.get("available_resources") or {}).items()},
        unlimited_resources=list(b.get("unlimited_resources") or []),
        must_produce={k: float(v) for k, v in (b.get("must_produce") or {}).items()},
        min_produce={k: float(v) for k, v in (b.get("min_produce") or {}).items()},
        max_produce={k: float(v) for k, v in (b.get("max_produce") or {}).items()},
        objective={k: float(v) for k, v in (b.get("objective") or {}).items()},
        power_shards_available=int(b.get("power_shards_available") or 0),
        somersloops_available=int(b.get("somersloops_available") or 0),
        max_power_mw=float(b["max_power_mw"]) if b.get("max_power_mw") else None,
        notes=b.get("notes", "") or "",
        unlocked_alt_recipes=unlocked,
        minimize_new_alts=bool(b.get("minimize_new_alts", False)),
        sloop_search="exact" if b.get("sloop_search") == "exact" else "dive",
        machines_first=bool(b.get("machines_first", False)),
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
        accept_enc = self.headers.get("Accept-Encoding", "")
        # Gzip when client supports it and payload is worth compressing (>512 bytes)
        if "gzip" in accept_enc and len(body) > 512:
            body = gzip.compress(body, compresslevel=1)  # level 1 = fast
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        else:
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

        if path == "/api/boot":
            self._send(200, _build_boot_bytes())
            return

        if path == "/api/items":
            q     = qs.get("q", [""])[0].lower().replace(" ", "_")
            all_i = ALL_ITEMS
            if q:
                matched  = [i for i in all_i if i.lower().startswith(q)]
                matched += [i for i in all_i if q in i.lower() and not i.lower().startswith(q)]
                self._json(200, matched[:14])
            else:
                self._json(200, all_i)
            return

        if path == "/api/recipes":
            self._send(200, _RECIPES_BYTES)
            return

        if path == "/api/item-display":
            self._send(200, _ITEM_DISPLAY_BYTES)
            return

        if path == "/api/scenarios":
            # Build a fingerprint from (name, mtime) for every scenario file.
            # If it matches the cached fingerprint the YAML has not changed.
            names = list_scenarios()
            fingerprint = frozenset(
                (n, self._scenario_path(n).stat().st_mtime)
                for n in names
                if self._scenario_path(n).exists()
            )
            if fingerprint in _scenario_list_cache:
                self._json(200, _scenario_list_cache[fingerprint])
                return
            out = []
            for name in names:
                try:
                    s = load_scenario(self._scenario_path(name))
                    out.append({"key": name, "name": s.name,
                                "description": s.description,
                                "resources": list(s.available_resources.keys()),
                                "objectives": list(s.objective.keys())})
                except Exception as e:
                    out.append({"key": name, "name": name, "error": str(e)})
            _scenario_list_cache.clear()   # only keep the latest fingerprint
            _scenario_list_cache[fingerprint] = out
            self._json(200, out)
            return

        if path.startswith("/api/scenarios/"):
            name = path[len("/api/scenarios/"):]
            p    = self._scenario_path(name)
            if not p.exists():
                self._json(404, {"error": "Not found"})
                return
            mtime = p.stat().st_mtime
            cache_key = (name, mtime)
            if cache_key in _scenario_load_cache:
                data = _scenario_load_cache[cache_key]
            else:
                with open(p) as f:
                    data = yaml.safe_load(f)
                # Keep cache bounded: one entry per scenario name (drop stale mtime)
                _scenario_load_cache.clear() if len(_scenario_load_cache) > 50 else None
                _scenario_load_cache[cache_key] = data
            out = dict(data)
            # The last solve comes along when it was made from these exact settings
            entry = _cache_read(_result_key(data.get("name", name)))
            if entry and entry.get("result"):
                try:
                    if entry.get("base_sig") == _signature(_build_scenario(data), entry.get("styles") or []):
                        out["_last_solve"] = {"result": entry["result"], "styles": entry.get("styles") or []}
                        _set_dual_cache(_build_scenario(data), entry["result"])
                except Exception:
                    pass
            self._json(200, out)
            return

        if path.startswith("/api/solve/"):
            job_id = path[len("/api/solve/"):]
            with _jobs_lock:
                job = _jobs.get(job_id)
            if job is None:
                self._json(404, {"error": "Unknown job"})
                return
            if job["status"] == "pending":
                self._json(200, {"status": "pending"})
                return
            if job["status"] == "error":
                with _jobs_lock:
                    _jobs.pop(job_id, None)
                self._json(500, job["result"])
                return
            # Done — return result and clean up
            result = job["result"]
            with _jobs_lock:
                _jobs.pop(job_id, None)
            self._json(200, {"status": "done", "result": result})
            return

        if path == "/api/duals":
            with _dual_lock:
                cache = dict(_dual_cache)
            if not cache:
                self._json(200, {"shadow_prices": {}, "saturation_points": {},
                                 "note": "No solve result cached yet."})
                return
            try:
                # Computed once per solve (the cache is replaced on each solve)
                if "analysis" not in cache:
                    cache["analysis"] = analyse(cache["scenario"], ALL_RECIPES,
                                                cache.get("flows", []), cache.get("usable"),
                                                cache.get("goal"))
                    with _dual_lock:
                        if _dual_cache.get("flows") is cache.get("flows"):
                            _dual_cache["analysis"] = cache["analysis"]
                self._json(200, cache["analysis"])
            except Exception as e:
                import traceback; traceback.print_exc()
                self._json(500, {"error": str(e)})
            return

        if path == "/api/log":
            log_path = HERE / "planner.log"
            try:
                text = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
            except Exception as e:
                text = f"Could not read log: {e}"
            body = text.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        if path == "/api/unlocked-alts":
            self._json(200, {"unlocked": _load_unlocked_alts()})
            return

        if path == "/api/blackboard":
            self._json(200, {"factories": _blackboard_factories(), "layout": _load_board(),
                             "fluids": logistics.META["fluids"],
                             "transport": logistics.META["transport"]})
            return

        self._json(404, {"error": "Not found"})

    # ── POST / PUT ────────────────────────────────────────────────────────────

    def do_POST(self): self._handle_write()
    def do_PUT(self):  self._handle_write()

    def _handle_write(self):
        path = urlparse(self.path).path.rstrip("/")

        if path == "/api/blackboard":
            data = self._read_json()
            try:
                _save_board(data if isinstance(data, dict) else {})
                self._json(200, {"ok": True})
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path == "/api/unlocked-alts":
            data = self._read_json()
            keys = list(data.get("unlocked") or []) if isinstance(data, dict) else []
            try:
                _save_unlocked_alts(keys)
                self._json(200, {"unlocked": _load_unlocked_alts()})
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path == "/api/solve-inline":
            # Legacy synchronous endpoint — kept for backwards compatibility
            b = self._read_json()
            if not b:
                self._json(400, {"error": "No data"})
                return
            try:
                s      = _build_scenario(b)
                result = solve(s, ALL_RECIPES, MACHINE_META)
                d      = result_to_dict(result, s, MACHINE_META)
                _set_dual_cache(s, d, getattr(result, "usable", None))
                self._json(200, d)
            except Exception as e:
                import traceback; traceback.print_exc()
                self._json(500, {"error": str(e)})
            return

        if path == "/api/solve":
            # Async endpoint: dispatches solve to a background thread immediately
            # and returns a job ID. Client polls GET /api/solve/<id>.
            b = self._read_json()
            if not b:
                self._json(400, {"error": "No data"})
                return
            try:
                s = _build_scenario(b)
                styles = list(b.get("solve_styles") or [])
                base = _build_scenario(b["base_scenario"]) if b.get("base_scenario") else s
            except Exception as e:
                self._json(400, {"error": str(e)})
                return
            key, sig = _result_key(s.name), _signature(s, styles)
            base_sig = _signature(base, styles)
            job_id = _uuid.uuid4().hex
            cached = _cache_lookup(key, sig)
            if cached is not None:
                # Unchanged inputs: answer at once from the cache, and record it
                # as this scenario's last solve (it may have come from another
                # scenario with the same settings)
                entry = _cache_read(key)
                if not entry or entry.get("sig") != sig:
                    _cache_store(key, sig, base_sig, styles, cached)
                _set_dual_cache(s, cached)
                with _jobs_lock:
                    _jobs[job_id] = {"status": "done", "result": cached}
                self._json(202, {"job_id": job_id})
                return
            with _jobs_lock:
                _jobs[job_id] = {"status": "pending", "result": None}
            t = threading.Thread(
                target=_run_solve_job,
                args=(job_id, s, ALL_RECIPES, MACHINE_META, (key, sig, base_sig, styles)),
                daemon=True,
            )
            t.start()
            self._json(202, {"job_id": job_id})
            return

        if path.startswith("/api/scenarios/"):
            name = path[len("/api/scenarios/"):]
            data = self._read_json()
            p    = self._scenario_path(name)
            # Write to a temp file beside the target, then atomically rename.
            # Prevents a truncated file if the process is killed mid-write.
            tmp_fd, tmp_path = tempfile.mkstemp(
                dir=p.parent, prefix=f".{p.stem}_", suffix=".tmp"
            )
            try:
                with os.fdopen(tmp_fd, "w") as f:
                    yaml.dump(data, f, default_flow_style=False, sort_keys=False)
                os.replace(tmp_path, p)  # atomic on POSIX; near-atomic on Windows
            except Exception:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
            # Invalidate per-scenario cache so next load re-reads the file
            stale = [k for k in _scenario_load_cache if k[0] == name]
            for k in stale:
                del _scenario_load_cache[k]
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
                try:
                    with open(p) as f:
                        rk = _result_key((yaml.safe_load(f) or {}).get("name", name))
                    for cp in _cache_paths(rk):                         # its cached plan
                        cp.unlink(missing_ok=True)
                except Exception:
                    pass
                p.unlink()
                stale = [k for k in _scenario_load_cache if k[0] == name]
                for k in stale:
                    del _scenario_load_cache[k]
                self._json(200, {"status": "deleted"})
            else:
                self._json(404, {"error": "Not found"})
            return
        self._json(404, {"error": "Not found"})


# ── Standalone entry point (browser-only mode) ────────────────────────────────

def run(port: int = 5000):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"   http://127.0.0.1:{port}/  —  Ctrl+C to stop\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 Stopped.")


if __name__ == "__main__":
    run(int(sys.argv[1]) if len(sys.argv) > 1 else 5000)
