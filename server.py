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
import network
import supply

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
        "extractors":   supply.EXTRACTORS,
        "purity":       supply.PURITY,
        "miner_tiers":  supply.MINER_TIERS,
        "max_shards":   supply.MAX_SHARDS,
        "progress":     supply.load_progress(),
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
from dataclasses import asdict, replace as _dc_replace
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

def _cache_lookup(key: str, sig: str, owed: dict):
    """The cache entry for these settings whose plan also serves what's owed now."""
    with _cache_lock:
        hit = _mem_cache.get(sig)
        if hit is not None and _owed_ok(hit, owed):
            _mem_cache.move_to_end(sig)
            return hit
    entry = _cache_read(key)
    if entry and entry.get("result") and entry.get("sig") == sig and _owed_ok(entry, owed):
        return entry
    return None

def _cache_store(key: str, sig: str, base_sig: str, styles, result: dict,
                 owed: dict = None, dropped: bool = False) -> None:
    """sig / base_sig are of the settings as given (styled / before styles),
    without what's owed — owed is kept beside them (see _owed_ok)."""
    entry = {"sig": sig, "base_sig": base_sig, "styles": list(styles), "result": result,
             "owed": owed or {}, **({"owed_dropped": True} if dropped else {})}
    with _cache_lock:
        _mem_cache[sig] = entry
        _mem_cache.move_to_end(sig)
        while len(_mem_cache) > _MEM_CACHE_SIZE:
            _mem_cache.popitem(last=False)
    _cache_write(key, entry)

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
    keep = {k: layout[k] for k in ("positions", "routes", "belt", "pipe") if k in layout}
    BOARD_PATH.parent.mkdir(parents=True, exist_ok=True)
    BOARD_PATH.write_text(yaml.safe_dump(keep, sort_keys=False), encoding="utf-8")

# What a factory owes: other factories' "From factories" imports from it and its
# own "To storage" are claims on its outputs. Solving it makes at least those
# (min_produce), so what's promised keeps being made. A cached plan stays
# good when it was solved owing no more than now and still makes what's owed —
# so a new claim it already covers needs no re-solve.
STORAGE = "@storage"   # the taker for what a factory sends to storage

def _scenario_files() -> list:
    """[(key, scenario data)] for every saved scenario."""
    out = []
    for p in sorted(SCENARIOS_DIR.glob("*.yaml")):
        try:
            out.append((p.stem, yaml.safe_load(p.read_text(encoding="utf-8")) or {}))
        except Exception:
            continue
    return out

def _claims(files) -> dict:
    """{source factory: {item: {taker: rate}}}: every From factories row, and
    every factory's To storage (taker STORAGE)."""
    out: dict = {}
    def add(src, it, who, r):
        r = max(0.0, float(r or 0))
        if r > 1e-9:
            by = out.setdefault(src, {}).setdefault(it, {})
            by[who] = by.get(who, 0.0) + r
    for key, data in files:
        for f in data.get("from_factories") or []:
            if f.get("factory") and f.get("item"):
                add(f["factory"], f["item"], key, f.get("rate"))
        for t in data.get("to_storage") or []:
            if t.get("item"):
                add(key, t["item"], STORAGE, t.get("rate"))
    return out

def _owed(key: str, claims: dict, s: Scenario, storage=None) -> dict:
    """What factory `key` must make for others, as its solve can hold it:
    an exact (must_produce) amount stays as it is, an at-most caps it.
    storage: its To storage as being solved now, in place of the saved one."""
    owed: dict = {}
    for it, by in (claims.get(key) or {}).items():
        for who, r in by.items():
            if who != key and not (who == STORAGE and storage is not None):
                owed[it] = owed.get(it, 0.0) + r
    for t in storage or []:
        if t.get("item"):
            owed[t["item"]] = owed.get(t["item"], 0.0) + max(0.0, float(t.get("rate") or 0))
    out = {}
    for it, r in owed.items():
        if it in s.must_produce or r <= 1e-6:
            continue
        out[it] = round(min(r, s.max_produce[it]) if it in s.max_produce else r, 6)
    return out

def _with_owed(s: Scenario, owed: dict) -> Scenario:
    if not owed:
        return s
    mins = dict(s.min_produce)
    for it, r in owed.items():
        mins[it] = max(mins.get(it, 0.0), r)
    return _dc_replace(s, min_produce=mins)

def _owed_ok(entry: dict, owed: dict) -> bool:
    was = entry.get("owed") or {}
    if entry.get("owed_dropped"):          # it couldn't make what was owed then: same owed, same answer
        return was == owed
    if any(v > owed.get(k, 0.0) + 1e-6 for k, v in was.items()):
        return False                       # solved owing more than now: there may be a better plan
    made = logistics.made(entry.get("result") or {})
    return all(made.get(k, 0.0) >= v * (1 - 1e-6) - 1e-3 for k, v in owed.items())

def _save_key(name: str) -> str:
    return "_".join(str(name).split()).lower()   # as the frontend saves it (handleSave)

def _factory_plan(key: str, stale_ok: bool = False, claims: dict = None, data: dict = None):
    """(scenario data, its current cached plan or None) for a saved factory.
    stale_ok: fall back to its last plan even when the scenario changed since."""
    if data is None:
        data = yaml.safe_load((SCENARIOS_DIR / f"{key}.yaml").read_text(encoding="utf-8")) or {}
    entry = _cache_read(_result_key(data.get("name", key)))
    if entry and entry.get("result"):
        try:
            if _entry_fresh(entry, key, data, claims):
                return data, entry["result"]
        except Exception:
            pass
        if stale_ok:
            return data, {**entry["result"], "_stale": True}
    return data, None

def _entry_fresh(entry: dict, key: str, data: dict, claims: dict = None) -> bool:
    base = _build_scenario(data)
    if entry.get("base_sig") != _signature(base, entry.get("styles") or []):
        return False
    if claims is None:
        claims = _claims(_scenario_files())
    return _owed_ok(entry, _owed(key, claims, base))

def _network_sites(keys) -> list:
    """Each factory for network planning: its scenario, what its plan makes (held),
    the recipes it runs, and what it draws from its supply."""
    sites = []
    for key in keys:
        data, result = _factory_plan(key)
        sc = _build_scenario(data)
        held, own, drawn = {}, {}, {}
        if result:
            held = {k: v for k, v in (result.get("sink_nodes") or {}).items() if v > 1e-6}
            for t in data.get("to_storage") or []:      # what it stores it must keep making
                if t.get("item"):
                    held[t["item"]] = max(held.get(t["item"], 0.0), float(t.get("rate") or 0))
            for f in result.get("flows", []):
                own[f["recipe_key"]] = own.get(f["recipe_key"], 0.0) + f["machines_float"]
                for it, q in f["inputs"].items():
                    drawn[it] = drawn.get(it, 0.0) + q
                for it, q in f["outputs"].items():
                    drawn[it] = drawn.get(it, 0.0) - q
        else:
            held = {**{k: float(v) for k, v in sc.min_produce.items()},
                    **{k: float(v) for k, v in sc.must_produce.items()}}
        sites.append({"key": key, "name": data.get("name", key), "scenario": sc, "held": held,
                      "own": own, "own_draw": {k: v for k, v in drawn.items() if v > 1e-6},
                      "solved": result is not None})
    return sites

def _saved_factories(stale_ok: bool = False):
    """([(key, scenario data, plan or None)], claims) for every saved scenario."""
    files = _scenario_files()
    claims = _claims(files)
    out = []
    for key, data in files:
        try:
            out.append((key, *_factory_plan(key, stale_ok, claims, data)))
        except Exception:
            continue
    return out, claims

def _blackboard_factories() -> list:
    saved, claims = _saved_factories()
    out = []
    for key, data, result in saved:
        io = logistics.factory_io(data, result)
        out.append({"key": key, "name": data.get("name", key), **io,
                    "sources": [f for f in data.get("from_factories") or [] if f.get("factory")],
                    "storage": {t["item"]: float(t.get("rate") or 0) for t in data.get("to_storage") or [] if t.get("item")},
                    "taken": {it: round(sum(by.values()), 3) for it, by in claims.get(key, {}).items()},
                    "taken_by": claims.get(key, {})})
    return out

def _factory_outputs() -> dict:
    """What each saved factory makes (from its last plan — stale: the scenario
    changed since), who already takes it, which map nodes each mines, and
    alerts: imports or storage more than their source has left."""
    saved, claims = _saved_factories(stale_ok=True)
    facs, made, nodes = [], {}, {}
    for key, data, result in saved:
        io = logistics.factory_io(data, result and {k: v for k, v in result.items() if k != "_stale"})
        made[key] = {it: r for it, r in {**io["surplus"], **io["exports"]}.items() if r}
        facs.append({"key": key, "name": data.get("name", key), "solved": io["solved"],
                     "stale": bool(result and result.get("_stale")), "made": made[key]})
        for i in supply.nodes_of(data):
            nodes[i] = key
    alerts: dict = {}
    names = {f["key"]: f["name"] for f in facs}
    for src, items in claims.items():
        for it, by in items.items():
            have = made.get(src, {}).get(it)
            if have is None:
                continue
            for who, r in by.items():
                left = have - sum(v for k, v in by.items() if k != who)
                if r > left + 1e-3:
                    alerts.setdefault(src if who == STORAGE else who, []).append(
                        {"item": it, "factory": src, "factory_name": names.get(src, src), "storage": who == STORAGE,
                         "rate": round(r, 3), "left": round(max(0.0, left), 3)})
    return {"factories": facs, "claims": claims, "nodes": nodes, "alerts": alerts}

_save_lock = threading.Lock()   # claim check + write as one step, so two saves can't both take the same

def _hold_claims(key: str, data: dict) -> list:
    """Hold a scenario to what's free when it's saved: each import at what its
    source has left (what it makes, less what the other saved factories take),
    its storage at what it makes less what others take from it, its map nodes
    to ones no other factory mines. Earlier rows come first. Drops imports from
    itself. Edits data in place; returns [{kind, item|node, factory, asked, rate}]
    for each cut."""
    out = _factory_outputs()
    made = {f["key"]: f["made"] for f in out["factories"]}
    claims = out["claims"]
    cut = []

    def room(src, it, but):
        return made[src][it] - sum(v for k, v in claims.get(src, {}).get(it, {}).items() if k not in but)

    left: dict = {}
    keep = []
    for r in data.get("from_factories") or []:
        if r.get("factory") == key:
            continue
        src, it = r.get("factory"), r.get("item")
        asked = max(0.0, float(r.get("rate") or 0))
        if it in made.get(src, {}):                 # unknown sources (not solved, "max") aren't capped
            k = (src, it)
            free = max(0.0, left.get(k, room(src, it, {key})))
            rate = min(asked, free)
            left[k] = free - rate
            if asked - rate > 1e-6:
                cut.append({"kind": "import", "item": it, "factory": src, "asked": asked, "rate": round(rate, 6)})
            r = {**r, "rate": round(rate, 6)}
        keep.append(r)
    if data.get("from_factories") is not None:
        data["from_factories"] = keep

    keep = []
    for t in data.get("to_storage") or []:
        it, asked = t.get("item"), max(0.0, float(t.get("rate") or 0))
        if it in made.get(key, {}):
            k = (key, it)
            free = max(0.0, left.get(k, room(key, it, {key, STORAGE})))
            rate = min(asked, free)
            left[k] = free - rate
            if asked - rate > 1e-6:
                cut.append({"kind": "storage", "item": it, "factory": key, "asked": asked, "rate": round(rate, 6)})
            t = {**t, "rate": round(rate, 6)}
        keep.append(t)
    if data.get("to_storage") is not None:
        data["to_storage"] = keep

    taken = {i: k for i, k in out["nodes"].items() if k != key}
    rows = []
    for n in data.get("resource_nodes") or []:
        if n.get("nodes"):
            gone = [i for i in n["nodes"] if i in taken]
            for i in gone:
                cut.append({"kind": "node", "node": i, "item": n.get("resource"), "factory": taken[i]})
            n = {**n, "nodes": [i for i in n["nodes"] if i not in taken]}
            if not n["nodes"]:
                continue
        rows.append(n)
    if data.get("resource_nodes") is not None:
        data["resource_nodes"] = rows
    if data.get("resource_nodes") is not None or data.get("from_factories") is not None:
        data["available_resources"] = supply.available(data)
    return cut

def _rename(old: str, new: str, new_name: str) -> None:
    """Saving a factory under a new name: its links follow it — other factories'
    imports from it, its place and routes on the Blackboard, its cached plan."""
    old_p = SCENARIOS_DIR / f"{old}.yaml"
    try:
        old_name = (yaml.safe_load(old_p.read_text(encoding="utf-8")) or {}).get("name", old)
    except Exception:
        return
    for key, data in _scenario_files():
        rows = data.get("from_factories") or []
        if key not in (old, new) and any(r.get("factory") == old for r in rows):
            data["from_factories"] = [{**r, "factory": new} if r.get("factory") == old else r for r in rows]
            _write_yaml(SCENARIOS_DIR / f"{key}.yaml", data)
    board = _load_board()
    if board:
        pos = board.get("positions") or {}
        if old in pos:
            pos[new] = pos.pop(old)
        for r in board.get("routes") or []:
            for end in ("a", "b"):
                if r.get(end) == old:
                    r[end] = new
        _save_board(board)
    for src, dst in zip(_cache_paths(_result_key(old_name)), _cache_paths(_result_key(new_name))):
        if src.exists() and not dst.exists():
            os.replace(src, dst)
    old_p.unlink(missing_ok=True)
    for k in [k for k in _scenario_load_cache if k[0] == old]:
        del _scenario_load_cache[k]

def _write_yaml(p, data) -> None:
    """Write to a temp file beside the target, then atomically rename —
    no truncated file if the process is killed mid-write."""
    tmp_fd, tmp_path = tempfile.mkstemp(dir=p.parent, prefix=f".{p.stem}_", suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w") as f:
            yaml.dump(data, f, default_flow_style=False, sort_keys=False)
        os.replace(tmp_path, p)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ── Async solve job store ─────────────────────────────────────────────────────
import uuid as _uuid
_jobs: dict = {}   # {job_id: {"status": "pending"|"done"|"error", "result": dict|None}}
_jobs_lock = threading.Lock()

def _owed_fields(d: dict, owed: dict) -> dict:
    """The plan with what's owed now beside it, and any it falls short of."""
    d = {k: v for k, v in d.items() if k not in ("owed", "owed_unmet")}
    if owed:
        have = logistics.made(d)
        d["owed"] = owed
        d["owed_unmet"] = {k: round(v - have.get(k, 0.0), 3) for k, v in owed.items()
                           if have.get(k, 0.0) < v * (1 - 1e-6) - 1e-3}
    return d

def _run_solve_job(job_id: str, s, all_recipes, machine_meta, cache=None, owed=None):
    """Runs in a background thread; writes result into _jobs when done.
    cache = (key, sig, base_sig, styles) to store the result under.
    owed: what other factories and storage take from it — made at least,
    unless it can't be, then solved without and reported as owed_unmet."""
    try:
        owed = owed or {}
        run = _with_owed(s, owed)
        result = solve(run, all_recipes, machine_meta)
        d = result_to_dict(result, run, machine_meta)
        dropped = False
        if owed and not d.get("status", "").startswith("Optimal"):
            result = solve(s, all_recipes, machine_meta)
            d = result_to_dict(result, s, machine_meta)
            run, dropped = s, True
        d = _owed_fields(d, owed)
        _set_dual_cache(run, d, getattr(result, "usable", None))
        if cache is not None and d.get("status", "").startswith("Optimal"):
            _cache_store(*cache, d, owed, dropped)
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
        available_resources=supply.available(b),
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
                self._json(200, self._with_alerts(_scenario_list_cache[fingerprint]))
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
            self._json(200, self._with_alerts(out))
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
                    if _entry_fresh(entry, name, data):
                        owed = _owed(name, _claims(_scenario_files()), _build_scenario(data))
                        out["_last_solve"] = {"result": _owed_fields(entry["result"], owed),
                                              "styles": entry.get("styles") or []}
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

        if path == "/api/progress":
            self._json(200, supply.load_progress())
            return

        if path == "/api/map-nodes":
            body = supply.MAP_PATH.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/factory-outputs":
            self._json(200, _factory_outputs())
            return

        if path == "/api/blackboard":
            self._json(200, {"factories": _blackboard_factories(), "layout": _load_board(),
                             "fluids": logistics.META["fluids"],
                             "transport": logistics.META["transport"]})
            return

        self._json(404, {"error": "Not found"})

    @staticmethod
    def _with_alerts(rows):
        """Each saved factory with its alerts: imports or storage more than
        their source has left (it changed since)."""
        try:
            alerts = _factory_outputs()["alerts"]
        except Exception:
            alerts = {}
        return [{**r, "alerts": alerts.get(r["key"], [])} for r in rows]

    # ── POST / PUT ────────────────────────────────────────────────────────────

    def do_POST(self): self._handle_write()
    def do_PUT(self):  self._handle_write()

    def _handle_write(self):
        path = urlparse(self.path).path.rstrip("/")

        if path == "/api/network":
            b = self._read_json() or {}
            routes = [r for r in (b.get("routes") or []) if r.get("a") and r.get("b")]
            keys = sorted({k for r in routes for k in (r["a"], r["b"])})
            try:
                sites = _network_sites(keys)
                out = network.plan_network(sites, routes, ALL_RECIPES,
                                           b.get("belt") or "Mk5", b.get("pipe") or "Mk2")
                out["unsolved"] = [s["name"] for s in sites if not s["solved"]]
                self._json(200, out)
            except Exception as e:
                import traceback; traceback.print_exc()
                self._json(500, {"error": str(e)})
            return

        if path == "/api/progress":
            data = self._read_json()
            self._json(200, supply.save_progress(data if isinstance(data, dict) else {}))
            return

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
            # What other factories take from this one, and what it stores (as sent now)
            owed = _owed(_save_key(s.name), _claims(_scenario_files()), base,
                         storage=(b.get("base_scenario") or b).get("to_storage") or [])
            job_id = _uuid.uuid4().hex
            hit = _cache_lookup(key, sig, owed)
            if hit is not None:
                # Unchanged inputs: answer at once from the cache, and record it
                # as this scenario's last solve (it may have come from another
                # scenario with the same settings)
                if _cache_read(key) != hit:
                    _cache_store(key, sig, base_sig, styles, hit["result"], hit.get("owed"), hit.get("owed_dropped", False))
                cached = _owed_fields(hit["result"], owed)
                _set_dual_cache(s, cached)
                with _jobs_lock:
                    _jobs[job_id] = {"status": "done", "result": cached}
                self._json(202, {"job_id": job_id})
                return
            with _jobs_lock:
                _jobs[job_id] = {"status": "pending", "result": None}
            t = threading.Thread(
                target=_run_solve_job,
                args=(job_id, s, ALL_RECIPES, MACHINE_META, (key, sig, base_sig, styles), owed),
                daemon=True,
            )
            t.start()
            self._json(202, {"job_id": job_id})
            return

        if path.startswith("/api/scenarios/"):
            name = path[len("/api/scenarios/"):]
            data = self._read_json()
            p    = self._scenario_path(name)
            if not isinstance(data, dict):
                self._json(400, {"error": "No data"})
                return
            renamed = data.pop("_renamed_from", None)
            with _save_lock:
                cut = _hold_claims(name, data)
                _write_yaml(p, data)
                for k in [k for k in _scenario_load_cache if k[0] == name]:
                    del _scenario_load_cache[k]
                if renamed and renamed != name and self._scenario_path(renamed).exists():
                    _rename(renamed, name, data.get("name", name))
            self._json(200, {"status": "saved", "key": name, "cut": cut,
                             **{k: data.get(k) for k in ("from_factories", "to_storage", "resource_nodes")}})
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
