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

import gzip, json, os, re, shutil, sys, tempfile, threading, time
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
import savefile

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
import solver as _solver_mod
_solver_mod.ITEM_NAMES.update(json.loads(_ITEM_DISPLAY_BYTES))   # the diagnosis speaks the game's names

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
        "progress":     _progress(),
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

def key_of(name: str) -> str:
    """The key a factory is saved under (and its plan cached under): its name
    with spaces as _, lower case, ASCII letters, digits, _ and - only, so it's a
    filename on any system. The frontend's keyOf is the same."""
    return "".join(ch for ch in "_".join(str(name).split()).lower()
                   if (ch.isascii() and ch.isalnum()) or ch in "_-") or "factory"

_KEY = re.compile(r"[A-Za-z0-9_-]{1,120}")

def _valid_key(key: str) -> bool:
    """A scenario or version key from a URL: nothing that could leave its folder."""
    return bool(_KEY.fullmatch(key or ""))

_result_key = key_of


class _BadRequest(ValueError):
    """Input the server can't use — answered with 400 and this message."""


def _num(v, default=0.0, lo=None):
    """A finite number from user input, else the default (and never below lo)."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    if x != x or x in (float("inf"), float("-inf")):
        return default
    return max(lo, x) if lo is not None else x


def _clean_scenario(d) -> dict:
    """A scenario from the browser, made safe to save and solve: numbers are
    numbers, rows without an item are dropped, rates and counts never negative,
    lists are lists of strings. Everything else is kept as it came."""
    if not isinstance(d, dict):
        raise _BadRequest("A scenario is a JSON object")
    out = dict(d)
    out["name"] = str(d.get("name") or "Factory").strip()[:120] or "Factory"
    for k in ("description", "notes"):
        if k in d:
            out[k] = str(d.get(k) or "")
    for k in ("available_resources", "must_produce", "min_produce", "max_produce", "objective"):
        v = d.get(k)
        out[k] = {str(i): _num(x) for i, x in v.items() if i} if isinstance(v, dict) else {}
    for k in ("alternate_recipes_enabled", "enabled_machines", "unlimited_resources"):
        v = d.get(k)
        out[k] = [str(x) for x in v if isinstance(x, str)] if isinstance(v, list) else []
    for k in ("power_shards_available", "somersloops_available"):
        if d.get(k) is not None:
            out[k] = int(_num(d.get(k), 0, 0))
    if d.get("max_power_mw") not in (None, ""):
        mw = _num(d.get("max_power_mw"), None)
        out["max_power_mw"] = None if mw is None else max(0.0, mw)
    rows = lambda k: [r for r in d.get(k) if isinstance(r, dict)] if isinstance(d.get(k), list) else None
    if d.get("resource_nodes") is not None:
        nodes = []
        for n in rows("resource_nodes") or []:
            if not isinstance(n.get("resource"), str) or not n["resource"]:
                continue
            n = dict(n)
            for f in ("count", "shards"):
                if f in n:
                    n[f] = int(_num(n[f], 1 if f == "count" else 0, 0))
            if "shards" in n:
                n["shards"] = min(n["shards"], supply.MAX_SHARDS)
            if "rate" in n:
                n["rate"] = _num(n["rate"], 0.0, 0.0)
            if "nodes" in n:
                n["nodes"] = [x for x in (n["nodes"] if isinstance(n["nodes"], list) else []) if isinstance(x, str)]
            if isinstance(n.get("node_shards"), dict):
                n["node_shards"] = {str(i): min(supply.MAX_SHARDS, int(_num(v, 0, 0))) for i, v in n["node_shards"].items()}
            nodes.append(n)
        out["resource_nodes"] = nodes
    if d.get("from_factories") is not None:
        out["from_factories"] = [{"item": r["item"], "factory": r["factory"], "rate": _num(r.get("rate"), 0.0, 0.0)}
                                 for r in rows("from_factories") or []
                                 if isinstance(r.get("item"), str) and r["item"]
                                 and isinstance(r.get("factory"), str) and _valid_key(r["factory"])]
    if d.get("to_storage") is not None:
        out["to_storage"] = [{"item": r["item"], "rate": _num(r.get("rate"), 0.0, 0.0)}
                             for r in rows("to_storage") or [] if isinstance(r.get("item"), str) and r["item"]]
    if out.get("resource_nodes") is not None or out.get("from_factories") is not None:
        out["available_resources"] = supply.available(out)
    return out

# Entries are gzipped compact JSON (≈10× smaller); plain .json files from
# before are still read and replaced on the next write. The folder keeps the
# _RESULTS_KEEP most recently written scenarios.
_RESULTS_KEEP = 64

def _cache_paths(key: str):
    return RESULTS_DIR / f"{key}.json.gz", RESULTS_DIR / f"{key}.json"

_read_memo: dict = {}   # path → (mtime, entry): every Blackboard and list request reads every plan

def _cache_read(key: str):
    gz, plain = _cache_paths(key)
    try:
        for p in (gz, plain):
            if p.exists():
                mt = p.stat().st_mtime_ns
                hit = _read_memo.get(str(p))
                if hit and hit[0] == mt:
                    return hit[1]
                entry = json.loads(gzip.decompress(p.read_bytes()) if p is gz else p.read_text())
                _read_memo[str(p)] = (mt, entry)
                return entry
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

def _cache_lookup(key: str, sig: str, owed: dict, supply: dict):
    """The cache entry for these settings whose plan also serves what's owed now."""
    with _cache_lock:
        hit = _mem_cache.get(sig)
        if hit is not None and _owed_ok(hit, owed, supply):
            _mem_cache.move_to_end(sig)
            return hit
    entry = _cache_read(key)
    if entry and entry.get("result") and entry.get("sig") == sig and _owed_ok(entry, owed, supply):
        return entry
    return None

def _cache_store(key: str, sig: str, base_sig: str, styles, result: dict,
                 owed: dict = None, dropped: bool = False) -> None:
    """sig / base_sig are of the settings as given (styled / before styles),
    without what's owed — owed is kept beside them (see _owed_ok)."""
    entry = {"sig": sig, "base_sig": base_sig, "styles": list(styles), "result": result,
             "owed": owed or {}, **({"owed_dropped": True} if dropped else {})}
    # what its machines drew before, so the grid can say whose draw rose
    old = _cache_read(key)
    if old and old.get("result") and old.get("sig") != sig:
        entry["prev_draw_mw"] = _draw(old["result"])
    elif old and "prev_draw_mw" in old:
        entry["prev_draw_mw"] = old["prev_draw_mw"]
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
        return _clean_board(raw) if isinstance(raw, dict) else {}
    except Exception:
        return {}

def _clean_board(layout) -> dict:
    """Card positions {key: {x, y}} and routes [{a, b, mode, trip_min}], nothing else."""
    layout = layout if isinstance(layout, dict) else {}
    pos = layout.get("positions") if isinstance(layout.get("positions"), dict) else {}
    routes = layout.get("routes") if isinstance(layout.get("routes"), list) else []
    known = supply.map_nodes()
    geysers = layout.get("geysers") if isinstance(layout.get("geysers"), list) else []
    return {
        # geothermal generators on the grid: the geysers they sit on
        "geysers": sorted({g for g in geysers if isinstance(g, str) and known.get(g, {}).get("r") == "Geyser"}),
        "positions": {k: {"x": _num(v.get("x"), 0.0, 0.0), "y": _num(v.get("y"), 0.0, 0.0)}
                      for k, v in pos.items() if _valid_key(str(k)) and isinstance(v, dict)},
        "routes": [{"a": r["a"], "b": r["b"],
                    "mode": r.get("mode") if r.get("mode") in ("belt", "train", "truck", "drone") else "train",
                    "trip_min": _num(r.get("trip_min"), 4.0, 0.1)}
                   for r in routes if isinstance(r, dict) and _valid_key(str(r.get("a", "")))
                   and _valid_key(str(r.get("b", ""))) and r.get("a") != r.get("b")],
    }

def _save_board(layout: dict) -> None:
    BOARD_PATH.parent.mkdir(parents=True, exist_ok=True)
    BOARD_PATH.write_text(yaml.safe_dump(_clean_board(layout), sort_keys=False), encoding="utf-8")

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
    """What's owed out of a factory's own supply (ore, oil, water sent on) comes
    off that supply; anything else it must make, at least that much."""
    if not owed:
        return s
    mins, avail = dict(s.min_produce), dict(s.available_resources)
    for it, r in owed.items():
        if it in avail:
            if it not in s.unlimited_resources:
                avail[it] = max(0.0, avail[it] - r)
        else:
            mins[it] = max(mins.get(it, 0.0), r)
    return _dc_replace(s, min_produce=mins, available_resources=avail)

def _owed_short(result: dict, owed: dict, supply: dict) -> dict:
    """How far a plan falls short of what's owed: made items it makes too few
    of; supplied items it uses too much of to leave what's owed."""
    made, used = logistics.made(result), logistics.drawn(result)
    out = {}
    for k, v in owed.items():
        short = (used.get(k, 0.0) + v - supply[k]) if k in supply else (v - made.get(k, 0.0))
        if short > v * 1e-6 + 1e-3:
            out[k] = round(short, 3)
    return out

def _owed_ok(entry: dict, owed: dict, supply: dict) -> bool:
    was = entry.get("owed") or {}
    if entry.get("owed_dropped"):          # it couldn't make what was owed then: same owed, same answer
        return was == owed
    if any(v > owed.get(k, 0.0) + 1e-6 for k, v in was.items()):
        return False                       # solved owing more than now: there may be a better plan
    return not _owed_short(entry.get("result") or {}, owed, supply)

_save_key = key_of

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
    return _owed_ok(entry, _owed(key, claims, base), base.available_resources)

def _network_sites(keys) -> list:
    """Each factory for network planning: its scenario, what its plan makes (held),
    the recipes it runs, and what it draws from its supply."""
    sites = []
    claims = _claims(_scenario_files())
    for key in keys:
        data, result = _factory_plan(key)
        sc = _build_scenario(data)
        held, own, drawn = {}, {}, {}
        if result:
            held = {k: v for k, v in (result.get("sink_nodes") or {}).items() if v > 1e-6}
            # What the other factories in this network take from it is theirs —
            # the network routes it — so it isn't also held here (its plan's
            # output counts it once already)
            for it, by in (claims.get(key) or {}).items():
                taken = sum(r for who, r in by.items() if who in keys and who != key)
                if taken and it in held:
                    held[it] = max(0.0, held[it] - taken)
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

def _gross(result) -> dict:
    """Everything a plan's machines put out, per minute, before its own use."""
    out: dict = {}
    for f in (result or {}).get("flows", []):
        for it, q in (f.get("outputs") or {}).items():
            if it != "Power":
                out[it] = out.get(it, 0.0) + q
    return {k: round(v, 3) for k, v in out.items() if v > 1e-4}

def _blackboard_factories() -> list:
    saved, claims = _saved_factories()
    out = []
    for key, data, result in saved:
        io = logistics.factory_io(data, result)
        out.append({"key": key, "name": data.get("name", key), **io, "at": _where(data),
                    "sources": [f for f in data.get("from_factories") or [] if f.get("factory")],
                    "storage": {t["item"]: float(t.get("rate") or 0) for t in data.get("to_storage") or [] if t.get("item")},
                    "taken": {it: round(sum(by.values()), 3) for it, by in claims.get(key, {}).items()},
                    "taken_by": claims.get(key, {}),
                    "inside": _gross(result),
                    "power": _power(data, result)})
    return out

def _factory_outputs() -> dict:
    """What each saved factory makes (from its last plan — stale: the scenario
    changed since), who already takes it, which map nodes each mines, and
    alerts: imports or storage more than their source has left."""
    saved, claims = _saved_factories(stale_ok=True)
    facs, made, nodes = [], {}, {}
    for key, data, result in saved:
        io = logistics.factory_io(data, result and {k: v for k, v in result.items() if k != "_stale"})
        # power goes over the grid, not to another factory or into storage
        # what others can take: its goals, its surplus, and what its nodes give that it doesn't use
        made[key] = {it: r for it, r in {**io["spare"], **io["surplus"], **io["exports"]}.items() if r and it != "Power"}
        facs.append({"key": key, "name": data.get("name", key), "solved": io["solved"],
                     "stale": bool(result and result.get("_stale")), "made": made[key],
                     "spare": io["spare"], "at": _where(data),
                     "uses": sorted(k for k in supply.available(data) if k in logistics._NODE)})
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
    pins = [{"x": n["at"][0], "y": n["at"][1], "count": int(n.get("count") or 1), "factory": key}
            for key, data, _ in saved for n in data.get("resource_nodes") or [] if n.get("at")]
    return {"factories": facs, "claims": claims, "nodes": nodes, "alerts": alerts, "pins": pins}

def _where(data: dict):
    """Where a factory is: the middle of the nodes it mines and its pins (m), or None."""
    known = supply.map_nodes()
    pts = [(known[i]["x"], known[i]["y"]) for i in supply.nodes_of(data) if i in known]
    pts += [(float(n["at"][0]), float(n["at"][1])) for n in data.get("resource_nodes") or []
            if isinstance(n.get("at"), (list, tuple)) and len(n["at"]) == 2]
    if not pts:
        return None
    return [round(sum(p[0] for p in pts) / len(pts)), round(sum(p[1] for p in pts) / len(pts))]

def _grid() -> dict:
    """The power grid's own geothermal generators (on the Blackboard's map):
    their average MW, and the range a geyser's swing (½× to 1½×) spans."""
    known = supply.map_nodes()
    gs = [{"id": g, "p": known[g]["p"], "mw": supply.GEOTHERMAL_MW[known[g]["p"]]}
          for g in _load_board().get("geysers", []) if g in known]
    mw = sum(g["mw"] for g in gs)
    cost = {it: a * len(gs) for it, a in supply.BUILD[supply.GEOTHERMAL].items()}
    return {"geysers": gs, "count": len(gs), "mw": mw, "low": mw * 0.5, "high": mw * 1.5, "cost": cost}

def _draw(result) -> float:
    """MW a plan's machines draw (generators not counted)."""
    return round(sum(max(0.0, float(f.get("power_mw") or 0)) for f in (result or {}).get("flows", [])), 1)

def _grid_status() -> dict:
    """The grid's balance as the Power tab has it (factories with a current
    plan, extractors, generators, geothermal) — on average and with every
    geyser at its low — and, when it's short, the factories whose machines
    draw more than in their plan before."""
    saved, _ = _saved_factories()
    grid = _grid()
    used = made = geo = 0.0
    rose = []
    for key, data, result in saved:
        p = _power(data, result)
        used += p["machines"] + p["extractors"]
        made += p["generators"] + p["geothermal"]
        geo += p["geothermal"]
        entry = _cache_read(_result_key(data.get("name", key))) if result else None
        was = (entry or {}).get("prev_draw_mw")
        if was is not None and p["machines"] > was + 0.5:
            rose.append({"key": key, "name": data.get("name", key), "was": was, "now": p["machines"]})
    made += grid["mw"]
    geo += grid["mw"]
    spare = made - used
    low = spare - geo / 2
    short = spare < -1e-6 or low < -1e-6
    return {"made": round(made, 1), "used": round(used, 1), "spare": round(spare, 1),
            "spare_low": round(low, 1), "spare_high": round(spare + geo / 2, 1), "geothermal": round(geo, 1),
            "rose": sorted(rose, key=lambda r: r["was"] - r["now"]) if short else []}

def _power(data: dict, result) -> dict:
    """A factory's power: what its machines draw and its generators make (from
    its plan), its extractors' draw and its geysers' power (from its nodes)."""
    use = gen = 0.0
    for f in (result or {}).get("flows", []):
        pw = float(f.get("power_mw") or 0)
        if pw >= 0:
            use += pw
        else:
            gen -= pw
    return {"machines": round(use, 1), "generators": round(gen, 1),
            "extractors": supply.extractor_power(data), "geothermal": round(supply.geothermal_mw(data), 1),
            "cap": float(data["max_power_mw"]) if data.get("max_power_mw") else None,
            "solved": result is not None}

def _build_list() -> list:
    """Per saved factory: the machines its plan needs, its extractors, and what
    they take to build (no belts, pipes or stations)."""
    saved, _ = _saved_factories(stale_ok=True)
    out = []
    for key, data, result in saved:
        machines: dict = {}
        for f in (result or {}).get("flows", []):
            machines[f["machine"]] = machines.get(f["machine"], 0) + int(f.get("machines_final") or 0)
        ex = supply.extractor_build(data)
        cost = dict((result or {}).get("build_cost") or {})
        for e in ex.values():
            for it, a in e["cost"].items():
                cost[it] = cost.get(it, 0) + a
        out.append({"key": key, "name": data.get("name", key), "solved": result is not None,
                    "stale": bool(result and result.get("_stale")),
                    "machines": machines, "extractors": {k: v["count"] for k, v in ex.items()},
                    "materials": cost,
                    "shards": int((result or {}).get("build_cost_shards") or 0) + supply.shards_used(data)
                              - int(data.get("power_shards_available") or 0),
                    "sloops": int((result or {}).get("build_cost_sloops") or 0)})
    g = _grid()
    if g["count"]:   # the grid's geothermal generators, as one more thing to build
        out.append({"key": "@grid", "name": "Power grid", "solved": True, "stale": False, "machines": {},
                    "extractors": {supply.GEOTHERMAL: g["count"]}, "materials": g["cost"], "shards": 0, "sloops": 0})
    return out

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
    if (HISTORY_DIR / old).exists() and not (HISTORY_DIR / new).exists():
        os.replace(HISTORY_DIR / old, HISTORY_DIR / new)
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


# ── Re-solve the chain ────────────────────────────────────────────────────────
# Factories that are out of date, and everything that takes from them, solved
# sources first: each importer is first held to what its sources make now,
# then solved. One background job; the steps are reported as they finish.
_chain: dict = {"running": False, "steps": [], "todo": []}
_chain_lock = threading.Lock()

def _chain_order(files, keys=None) -> list:
    """Keys to solve, sources before what takes from them: `keys` (or every
    factory without a current plan) and everything downstream."""
    deps = {k: {f.get("factory") for f in d.get("from_factories") or [] if f.get("factory")} for k, d in files}
    takers = {}
    for k, ds in deps.items():
        for d in ds:
            takers.setdefault(d, set()).add(k)
    if keys is None:
        claims = _claims(files)
        keys = [k for k, d in files if _factory_plan(k, False, claims, d)[1] is None]
    todo, stack = set(), list(keys)
    while stack:
        k = stack.pop()
        if k in todo or k not in deps:
            continue
        todo.add(k)
        stack.extend(takers.get(k, ()))
    order = []
    while todo:   # fewest sources still to solve first (a cycle breaks at its smallest)
        ready = sorted(todo, key=lambda k: (len(deps[k] & todo), k))
        order.append(ready[0])
        todo.discard(ready[0])
    return order

def _chain_run(order) -> None:
    for key in order:
        step = {"key": key, "status": "solving"}
        with _chain_lock:
            _chain["steps"].append(step)
        try:
            p = SCENARIOS_DIR / f"{key}.yaml"
            data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
            step["name"] = data.get("name", key)
            before = (_cache_read(_result_key(data.get("name", key))) or {}).get("result") or {}
            with _save_lock:
                cut = _hold_claims(key, data)
                if cut:
                    _write_yaml(p, data)
            s = _build_scenario(data)
            rkey, sig = _result_key(s.name), _signature(s, [])
            owed = _owed(key, _claims(_scenario_files()), s)
            hit = _cache_lookup(rkey, sig, owed, s.available_resources)
            if hit is None:
                jid = "chain-" + key
                _run_solve_job(jid, s, ALL_RECIPES, MACHINE_META, (rkey, sig, sig, []), owed, data)
                with _jobs_lock:
                    res = _jobs.pop(jid, {}).get("result") or {}
            else:
                _cache_store(rkey, sig, sig, [], hit["result"], hit.get("owed"), hit.get("owed_dropped", False))
                res = _owed_fields(hit["result"], owed, data)
            step.update({"status": res.get("status", "error"), "cut": cut,
                         "before": before.get("objective_value"), "after": res.get("objective_value"),
                         "owed_unmet": res.get("owed_unmet") or {}, "error": res.get("error")})
        except Exception as e:
            import traceback; traceback.print_exc()
            step.update({"status": "error", "error": str(e)})
    with _chain_lock:
        _chain["running"] = False

def _chain_start(keys=None) -> dict:
    with _chain_lock:
        if _chain["running"]:
            return {"error": "Already re-solving"}
        order = _chain_order(_scenario_files(), keys)
        _chain.update({"running": bool(order), "steps": [], "todo": order})
    if order:
        threading.Thread(target=_chain_run, args=(order,), daemon=True).start()
    return {"todo": order}


# ── Apply a network plan ──────────────────────────────────────────────────────
def _apply_network(flows, alts) -> list:
    """Write a network plan into the factories: each factory's imports from the
    others in the plan become what the plan sends it (a typed fixed rate for
    an item it now imports goes), and the alternates the plan has it run are
    switched on. Returns the keys changed — re-solve them next."""
    sites = {f["from"] for f in flows} | {f["to"] for f in flows} | set(alts)
    into: dict = {}
    for f in flows:
        k = (f["from"], f["item"])
        into.setdefault(f["to"], {})[k] = into.setdefault(f["to"], {}).get(k, 0.0) + float(f["rate"])
    changed = []
    with _save_lock:
        for key, data in _scenario_files():
            if key not in sites:
                continue
            before = json.dumps(data, sort_keys=True, default=str)
            touched = False
            if key in into or any(r.get("factory") in sites for r in data.get("from_factories") or []):
                touched = True
                keep = [r for r in data.get("from_factories") or [] if r.get("factory") not in sites]
                new = [{"item": it, "factory": src, "rate": round(r, 3)} for (src, it), r in sorted(into.get(key, {}).items())]
                data["from_factories"] = keep + new
                got = {r["item"] for r in new}
                if data.get("resource_nodes") is not None:
                    data["resource_nodes"] = [n for n in data["resource_nodes"]
                                              if not (n.get("extractor") == "fixed" and n.get("resource") in got
                                                      and n.get("resource") not in logistics._NODE)]
                elif data.get("available_resources"):   # saved before nodes: imports replace the typed rates
                    data["resource_nodes"] = [{"resource": r, "extractor": "fixed", "rate": float(v)}
                                              for r, v in data["available_resources"].items()
                                              if not (r in got and r not in logistics._NODE)]
            if alts.get(key):
                data["alternate_recipes_enabled"] = sorted(set(data.get("alternate_recipes_enabled") or []) | set(alts[key]))
            if touched:
                data["available_resources"] = supply.available(data)
            if json.dumps(data, sort_keys=True, default=str) != before:
                _history_keep(key, data)
                _write_yaml(SCENARIOS_DIR / f"{key}.yaml", data)
                changed.append(key)
    return changed


# ── History ───────────────────────────────────────────────────────────────────
# Each save that changes a scenario keeps the version it replaces
# (scenarios/.history/<key>/<time>.yaml): the _HISTORY_KEEP latest, plus up to
# _HISTORY_CONFIRMED you confirm (kept until you unconfirm them), so a change
# can be undone.
HISTORY_DIR = SCENARIOS_DIR / ".history"
_HISTORY_KEEP = 5
_HISTORY_CONFIRMED = 5

def _confirmed(key: str) -> list:
    try:
        v = json.loads((HISTORY_DIR / key / "confirmed.json").read_text())
        return [x for x in v if isinstance(x, str) and _valid_key(x)]
    except Exception:
        return []

def _same(a: dict, b: dict) -> bool:
    return json.dumps(a or {}, sort_keys=True, default=str) == json.dumps(b or {}, sort_keys=True, default=str)

def _history_prune(key: str) -> None:
    d = HISTORY_DIR / key
    keep = set(_confirmed(key))
    for old in [f for f in sorted(d.glob("*.yaml")) if f.stem not in keep][:-_HISTORY_KEEP]:
        old.unlink()

def _history_keep(key: str, new: dict = None) -> str:
    """Keep the saved version of key before it's replaced — unless new is the
    same, or it's already the newest kept. Returns its id (or "")."""
    p = SCENARIOS_DIR / f"{key}.yaml"
    if not p.exists():
        return ""
    raw = p.read_bytes()
    try:
        old = yaml.safe_load(raw) or {}
    except Exception:
        old = None
    if new is not None and old is not None and _same(old, new):
        return ""
    import time as _t
    d = HISTORY_DIR / key
    d.mkdir(parents=True, exist_ok=True)
    kept = sorted(d.glob("*.yaml"))
    if kept and kept[-1].read_bytes() == raw:
        return kept[-1].stem
    stamp = _t.strftime("%Y%m%d-%H%M%S")
    n, dst = 0, d / f"{stamp}.yaml"
    while dst.exists():
        n += 1
        dst = d / f"{stamp}-{n}.yaml"
    dst.write_bytes(raw)
    _history_prune(key)
    return dst.stem

def _history_confirm(key: str, vid: str, on: bool) -> None:
    """Confirm (keep for good) or unconfirm a version; "current" confirms the
    scenario as it is now (kept as a version)."""
    if vid == "current":
        if not on:
            raise _BadRequest("Nothing to unconfirm")
        p = SCENARIOS_DIR / f"{key}.yaml"
        if not p.exists():
            raise _BadRequest("Save it first")
        d = HISTORY_DIR / key
        d.mkdir(parents=True, exist_ok=True)
        kept = sorted(d.glob("*.yaml"))
        if kept and kept[-1].read_bytes() == p.read_bytes():
            vid = kept[-1].stem
        else:
            import time as _t
            stamp = _t.strftime("%Y%m%d-%H%M%S")
            n, dst = 0, d / f"{stamp}.yaml"
            while dst.exists():
                n += 1
                dst = d / f"{stamp}-{n}.yaml"
            dst.write_bytes(p.read_bytes())
            vid = dst.stem
    if not (HISTORY_DIR / key / f"{vid}.yaml").exists():
        raise _BadRequest("No such version")
    c = [x for x in _confirmed(key) if x != vid]
    if on:
        if len(c) >= _HISTORY_CONFIRMED:
            raise _BadRequest(f"{_HISTORY_CONFIRMED} versions are confirmed already — unconfirm one first")
        c.append(vid)
    (HISTORY_DIR / key / "confirmed.json").write_text(json.dumps(sorted(c)))
    _history_prune(key)

def _nice(x) -> str:
    return str(x).replace("_", " ")

def _rate(v) -> str:
    v = float(v or 0)
    return f"{v:g}" if v == int(v) else f"{v:.4g}"

def _diff(cur: dict, old: dict, most: int = 8) -> list:
    """What restoring old over cur changes, a short line each (cur → old)."""
    cur, old = cur or {}, old or {}
    out = []

    def nums(label, a, b, unit=""):
        for k in sorted(set(a) | set(b), key=str):
            x, y = a.get(k), b.get(k)
            if x is None:
                out.append(f"+ {label}{_nice(k)} {_rate(y)}{unit}")
            elif y is None:
                out.append(f"− {label}{_nice(k)}")
            elif abs(float(x) - float(y)) > 1e-6:
                out.append(f"{label}{_nice(k)}: {_rate(x)} → {_rate(y)}{unit}")

    if (cur.get("name") or "") != (old.get("name") or ""):
        out.append(f"name: {cur.get('name')} → {old.get('name')}")
    for k, label in (("objective", "goal "), ("must_produce", "exactly "), ("min_produce", "at least "),
                     ("max_produce", "at most ")):
        nums(label, cur.get(k) or {}, old.get(k) or {}, "" if k == "objective" else "/min")
    bare = lambda d: supply.available({**d, "from_factories": []}) if d.get("resource_nodes") is not None \
        else {k: v for k, v in (d.get("available_resources") or {}).items()
              if k not in {f.get("item") for f in d.get("from_factories") or []}}
    nums("supply ", bare(cur), bare(old), "/min")
    imp = lambda d: {f"{f.get('item')} from {f.get('factory')}": f.get("rate") for f in d.get("from_factories") or []}
    nums("", imp(cur), imp(old), "/min")
    sto = lambda d: {f"{t.get('item')} to storage": t.get("rate") for t in d.get("to_storage") or []}
    nums("", sto(cur), sto(old), "/min")
    for k, label in (("alternate_recipes_enabled", ""), ("enabled_machines", "machine "), ("unlimited_resources", "unlimited ")):
        a, b = set(cur.get(k) or []), set(old.get(k) or [])
        out += [f"+ {label}{_nice(x)}" for x in sorted(b - a)] + [f"− {label}{_nice(x)}" for x in sorted(a - b)]
    for k, label in (("max_power_mw", "power cap"), ("power_shards_available", "shards"),
                     ("somersloops_available", "sloops"), ("minimize_new_alts", "min new alts"),
                     ("machines_first", "min machines"), ("sloop_search", "sloop search")):
        if cur.get(k) != old.get(k) and not (not cur.get(k) and not old.get(k)):
            show = lambda v: "—" if v in (None, "") else ("on" if v is True else "off" if v is False
                                                          else _rate(v) if isinstance(v, (int, float)) else v)
            out.append(f"{label}: {show(cur.get(k))} → {show(old.get(k))}")
    for k in ("description", "notes"):
        if (cur.get(k) or "") != (old.get(k) or ""):
            out.append(f"{k} differ")
    if len(out) > most:
        out = out[:most] + [f"and {len(out) - most} more"]
    return out

def _history(key: str) -> list:
    """Kept versions, newest first: when, confirmed, and what restoring each changes."""
    try:
        cur = yaml.safe_load((SCENARIOS_DIR / f"{key}.yaml").read_text(encoding="utf-8")) or {}
    except Exception:
        cur = {}
    conf = set(_confirmed(key))
    out = []
    for f in sorted((HISTORY_DIR / key).glob("*.yaml"), reverse=True):
        try:
            data = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
        except Exception:
            continue
        out.append({"id": f.stem, "name": data.get("name", key), "confirmed": f.stem in conf,
                    "changes": _diff(cur, data)})
    return out


# ── Backup ────────────────────────────────────────────────────────────────────
# Everything that's yours in one zip: the factories, their history and plans,
# the board, progress, unlocks, your save's nodes and your map picture. Kept in
# backups/ (git-ignored); restoring first backs up what's there now.
BACKUP_DIR = HERE / "backups"
_BACKUP_MAX = 300 * 2**20          # unpacked, at most
_BACKUP_BEFORE_KEEP = 3            # the automatic "before restore" ones kept

def _backup_files() -> list:
    """[(name in the zip, path)] of what's yours now."""
    out = [(f"scenarios/{p.name}", p) for p in sorted(SCENARIOS_DIR.glob("*.yaml"))]
    for base, d in (("scenarios/.history", HISTORY_DIR), ("scenarios/.results", RESULTS_DIR)):
        if d.exists():
            out += [(f"{base}/{p.relative_to(d).as_posix()}", p) for p in sorted(d.rglob("*")) if p.is_file()
                    and not p.name.endswith(".tmp")]
    for name, p in (("data/blackboard.yaml", BOARD_PATH), ("data/progress.yaml", supply.PROGRESS_PATH),
                    ("data/unlocked_alts.yaml", UNLOCKED_PATH), ("data/save_nodes.json", SAVE_NODES_PATH),
                    ("data/map_image.json", MAP_SETTINGS_PATH)):
        if p.exists():
            out.append((name, p))
    out += [(f"data/{p.name}", p) for p in sorted(MAP_IMAGE_DIR.glob("map_image.*"))
            if p.suffix[1:] in _IMAGE_TYPES.values()]
    return out

_BACKUP_NAME = re.compile(r"(scenarios/[A-Za-z0-9_-]{1,120}\.yaml"
                          r"|scenarios/\.history/[A-Za-z0-9_-]{1,120}/([A-Za-z0-9_-]{1,120}\.yaml|confirmed\.json)"
                          r"|scenarios/\.results/[A-Za-z0-9_-]{1,120}\.json(\.gz)?"
                          r"|data/(blackboard\.yaml|progress\.yaml|unlocked_alts\.yaml|save_nodes\.json|map_image\.json"
                          r"|map_image\.(png|jpg|webp)))")

def _backup_target(name: str) -> Path:
    """Where a file in a backup goes (its name already checked)."""
    if name.startswith("scenarios/.history/"):
        return HISTORY_DIR / name[len("scenarios/.history/"):]
    if name.startswith("scenarios/.results/"):
        return RESULTS_DIR / name[len("scenarios/.results/"):]
    if name.startswith("scenarios/"):
        return SCENARIOS_DIR / name[len("scenarios/"):]
    fixed = {"data/blackboard.yaml": BOARD_PATH, "data/progress.yaml": supply.PROGRESS_PATH,
             "data/unlocked_alts.yaml": UNLOCKED_PATH, "data/save_nodes.json": SAVE_NODES_PATH,
             "data/map_image.json": MAP_SETTINGS_PATH}
    return fixed.get(name) or MAP_IMAGE_DIR / name[len("data/"):]

def _backup_make(prefix: str = "planner") -> Path:
    import time as _t
    import zipfile
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = _t.strftime("%Y%m%d-%H%M%S")
    n, dst = 0, BACKUP_DIR / f"{prefix}-{stamp}.zip"
    while dst.exists():
        n += 1
        dst = BACKUP_DIR / f"{prefix}-{stamp}-{n}.zip"
    tmp = dst.with_suffix(".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name, p in _backup_files():
            z.write(p, name)
    os.replace(tmp, dst)
    if prefix == "before-restore":
        for old in sorted(BACKUP_DIR.glob("before-restore-*.zip"))[:-_BACKUP_BEFORE_KEEP]:
            old.unlink()
    return dst

def _backups() -> list:
    if not BACKUP_DIR.exists():
        return []
    out = []
    for p in sorted(BACKUP_DIR.glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            import zipfile
            with zipfile.ZipFile(p) as z:
                n = sum(1 for i in z.namelist() if re.fullmatch(r"scenarios/[^/]+\.yaml", i))
        except Exception:
            continue
        out.append({"file": p.name, "factories": n, "size": p.stat().st_size,
                    "auto": p.name.startswith("before-restore-")})
    return out

def _backup_restore(raw: bytes) -> dict:
    """Put a backup back: what's yours now is replaced by what's in it (and
    first backed up itself). Anything in the zip that isn't a planner file is
    refused, not skipped."""
    import io
    import zipfile
    try:
        z = zipfile.ZipFile(io.BytesIO(raw))
        infos = [i for i in z.infolist() if not i.is_dir()]
    except Exception:
        raise _BadRequest("That isn't a zip file")
    bad = [i.filename for i in infos if not _BACKUP_NAME.fullmatch(i.filename)]
    if bad:
        raise _BadRequest(f"Not a planner backup — it has {bad[0]}")
    if not any(i.filename.startswith("scenarios/") or i.filename.startswith("data/") for i in infos):
        raise _BadRequest("That backup is empty")
    if sum(i.file_size for i in infos) > _BACKUP_MAX:
        raise _BadRequest("That backup is too big")
    files = {i.filename: z.read(i) for i in infos}
    before = _backup_make("before-restore")
    for _, p in _backup_files():
        p.unlink(missing_ok=True)
    for d in (HISTORY_DIR, RESULTS_DIR):
        shutil.rmtree(d, ignore_errors=True)
    for name, data in files.items():
        t = _backup_target(name)
        t.parent.mkdir(parents=True, exist_ok=True)
        t.write_bytes(data)
    for c in (_mem_cache, _read_memo, _scenario_list_cache, _scenario_load_cache):
        c.clear()
    return {"factories": sum(1 for n in files if re.fullmatch(r"scenarios/[^/]+\.yaml", n)),
            "files": len(files), "before": before.name}


# ── Your save and your map ───────────────────────────────────────────────────
# Nodes a game save already mines (savefile.py) and a map picture to draw the
# nodes on — both yours, kept in data/ (git-ignored).
SAVE_NODES_PATH = HERE / "data" / "save_nodes.json"
MAP_IMAGE_DIR = HERE / "data"
MAP_SETTINGS_PATH = HERE / "data" / "map_image.json"
_IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
_IMAGE_CTYPE = {**{v: k for k, v in _IMAGE_TYPES.items()}, "avif": "image/avif"}

def _save_nodes() -> dict:
    try:
        return json.loads(SAVE_NODES_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"nodes": []}

def _unlock_changes(u) -> dict:
    """How a save's unlocks differ from the planner's: {alts: {add, drop},
    machines: {add, drop}, miner|belt|pipe: [planner, save]} (only what differs)."""
    if not u:
        return {}
    prog, have = _progress(), set(_load_unlocked_alts())
    out = {}
    a = {"add": sorted(set(u["alts"]) - have), "drop": sorted(have - set(u["alts"]))}
    if a["add"] or a["drop"]:
        out["alts"] = a
    ms = set(prog["machines"] or [])
    m = {"add": sorted(set(u["machines"]) - ms), "drop": sorted(ms - set(u["machines"]))}
    if m["add"] or m["drop"]:
        out["machines"] = m
    for k in ("miner", "belt", "pipe"):
        if u.get(k) and u[k] != prog[k]:
            out[k] = [prog[k], u[k]]
    return out

# The game's own map, drawn under the nodes unless you add your own picture:
# fetched once into data/ (it's the in-game map, from the open-source
# satisfactorymap project; lined up with the map's edges as it is).
GAME_MAP_URL = ("https://raw.githubusercontent.com/Tjark-Kuehl/satisfactorymap/"
                "44bfb29f85b998c36740cdbbafe13d76db8d1d41/public/assets/Map-HQ.avif")
GAME_MAP_SHA256 = "204a3735a6b134a4bcef9c4a30f75b7012f72e19613cd75518cc8558209057ba"
_game_map = {"state": "idle", "error": None}
_game_map_lock = threading.Lock()

def _game_map_path() -> Path:
    return MAP_IMAGE_DIR / "map_game.avif"

def _fetch_game_map() -> None:
    import urllib.request
    dst = _game_map_path()
    try:
        with urllib.request.urlopen(GAME_MAP_URL, timeout=60) as r:
            body = r.read()
        import hashlib as _h
        if _h.sha256(body).hexdigest() != GAME_MAP_SHA256:
            raise ValueError("the downloaded map isn't the expected picture")
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_suffix(".tmp")
        tmp.write_bytes(body)
        os.replace(tmp, dst)
        _game_map.update(state="ready", error=None)
    except Exception as e:
        _game_map.update(state="failed", error=str(e)[:200])

def _ensure_game_map() -> str:
    """The game map's state: ready, downloading, failed or off; starts the
    download the first time it's wanted."""
    if _game_map_path().exists():
        return "ready"
    if not GAME_MAP_URL:
        return "off"
    with _game_map_lock:
        if _game_map["state"] in ("idle", "ready"):
            _game_map.update(state="downloading", error=None)
            threading.Thread(target=_fetch_game_map, daemon=True).start()
    return _game_map["state"]

def _own_map() -> dict:
    """Your own map picture's settings (what's saved)."""
    try:
        d = json.loads(MAP_SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        d = {}
    ext = d.get("ext") if d.get("ext") in _IMAGE_TYPES.values() else None
    if ext and not (MAP_IMAGE_DIR / f"map_image.{ext}").exists():
        ext = None
    return {"ext": ext, "dx": _num(d.get("dx"), 0.0), "dy": _num(d.get("dy"), 0.0),
            "scale": _num(d.get("scale"), 1.0, 0.05), "opacity": min(1.0, _num(d.get("opacity"), 0.7, 0.0))}

def _map_settings() -> dict:
    """The picture under the map: yours (nudged as you set it) or else the
    game's (exactly on the map's edges)."""
    own = _own_map()
    if own["ext"]:
        return {**own, "source": "own", "game": _game_map_path().exists() and "ready" or _game_map["state"]}
    game = _ensure_game_map()
    if game != "ready":
        return {**own, "source": None, "game": game, "game_error": _game_map["error"]}
    return {**own, "ext": "avif", "dx": 0.0, "dy": 0.0, "scale": 1.0, "source": "game", "game": game}


# ── Async solve job store ─────────────────────────────────────────────────────
import uuid as _uuid
_jobs: dict = {}   # {job_id: {"status": "pending"|"done"|"error", "result": dict|None}}
_jobs_lock = threading.Lock()

def _owed_fields(d: dict, owed: dict, data: dict = None) -> dict:
    """The plan with what's owed now beside it, and any it falls short of —
    and, from the scenario, its extractors (power, build) and geysers' power."""
    d = {k: v for k, v in d.items() if k not in ("owed", "owed_unmet")}
    if data is not None:
        d.update(_extras(data))
    if owed:
        d["owed"] = owed
        d["owed_unmet"] = _owed_short(d, owed, supply.available(data) if data is not None else {})
    return d

def _extras(data: dict) -> dict:
    """What a plan doesn't cover but its scenario does: extractors and geysers."""
    return {"extractor_power_mw": supply.extractor_power(data),
            "geothermal_mw": round(supply.geothermal_mw(data), 3),
            "extractor_build": supply.extractor_build(data)}

def _run_solve_job(job_id: str, s, all_recipes, machine_meta, cache=None, owed=None, data=None):
    """Runs in a background thread; writes result into _jobs when done.
    cache = (key, sig, base_sig, styles) to store the result under.
    owed: what other factories and storage take from it — made at least,
    unless it can't be, then solved without and reported as owed_unmet."""
    try:
        owed = owed or {}
        run = _with_owed(s, owed)
        t0 = time.perf_counter()
        result = solve(run, all_recipes, machine_meta)
        d = result_to_dict(result, run, machine_meta)
        dropped = False
        if owed and not d.get("status", "").startswith("Optimal"):
            retry = solve(s, all_recipes, machine_meta)
            rd = result_to_dict(retry, s, machine_meta)
            # without what's owed it works: that plan, with what it falls short of;
            # if not, the first answer says why — it has every goal in it
            if rd.get("status", "").startswith("Optimal"):
                result, d, run, dropped = retry, rd, s, True
        d = _owed_fields(d, owed, data)
        d["solve_s"] = round(time.perf_counter() - t0, 3)
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

def _progress() -> dict:
    """The shared unlocks (supply.load_progress). The first time, the machines
    every saved factory had switched on become the shared list."""
    p = supply.load_progress()
    if p["machines"] is None:
        ms, every = set(), False
        for _, d in _scenario_files():
            em = d.get("enabled_machines") or []
            every = every or not em
            ms |= set(em)
        if every or not ms:
            ms = set(MACHINE_META) | {r.machine for r in ALL_RECIPES.values()}
        p = supply.save_progress({"machines": sorted(ms)})
    return p

def _build_scenario(b: dict) -> Scenario:
    # Inject unlocked alts from disk so they're always available to the solver
    # without the frontend needing to send them in every request. Machines are
    # the shared unlocked list; geysers' geothermal power adds to a power cap.
    unlocked = _load_unlocked_alts()
    prog = _progress()
    cap = float(b["max_power_mw"]) + supply.geothermal_mw(b) if b.get("max_power_mw") else None
    return Scenario(
        name=b.get("name", "Scenario"),
        description=b.get("description", ""),
        alternate_recipes_enabled=b.get("alternate_recipes_enabled", []) or [],
        enabled_machines=list(prog["machines"] or []),
        available_resources=supply.available(b),
        unlimited_resources=list(b.get("unlimited_resources") or []),
        must_produce={k: float(v) for k, v in (b.get("must_produce") or {}).items()},
        min_produce={k: float(v) for k, v in (b.get("min_produce") or {}).items()},
        max_produce={k: float(v) for k, v in (b.get("max_produce") or {}).items()},
        objective={k: float(v) for k, v in (b.get("objective") or {}).items()},
        power_shards_available=int(b.get("power_shards_available") or 0),
        somersloops_available=int(b.get("somersloops_available") or 0),
        max_power_mw=cap,
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
        length = int(self.headers.get("Content-Length", 0) or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            raise _BadRequest("The request body isn't valid JSON")

    def _read_obj(self) -> dict:
        d = self._read_json()
        if not isinstance(d, dict):
            raise _BadRequest("Expected a JSON object")
        return d

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

    def _guard(self, fn):
        """Every request answers: bad input with 400 and what was wrong, anything
        else that fails with 500 (and the traceback in the log) — never a
        dropped connection."""
        try:
            fn()
        except _BadRequest as e:
            self._json(400, {"error": str(e)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            import traceback; traceback.print_exc()
            try:
                self._json(500, {"error": f"{type(e).__name__}: {e}"})
            except Exception:
                pass

    def do_GET(self): self._guard(self._get)

    def _get(self):
        parsed = urlparse(self.path)
        path   = parsed.path.rstrip("/") or "/"
        qs     = parse_qs(parsed.query)

        # ── Static files ──────────────────────────────────────────────────────

        if path in ("/", "/index.html"):
            self._serve_file(HERE / "index.html")
            return

        if path.startswith("/frontend/"):
            f = (HERE / path.lstrip("/")).resolve()
            if (HERE / "frontend").resolve() not in f.parents:   # nothing outside frontend/
                self._json(404, {"error": "Not found"})
                return
            self._serve_file(f)
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
            if not _valid_key(name):
                self._json(400, {"error": "A factory key is letters, digits, _ and - only"})
                return
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
                        out["_last_solve"] = {"result": _owed_fields(entry["result"], owed, data),
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

        if path == "/api/suggest-alts":
            # Alternates worth unlocking for the last solve (computed once per solve)
            with _dual_lock:
                cache = dict(_dual_cache)
            if not cache:
                self._json(200, {"all": None, "steps": [], "on": []})
                return
            if "suggest" not in cache:
                cache["suggest"] = _solver_mod.suggest_alts(cache["scenario"], ALL_RECIPES)
                with _dual_lock:
                    if _dual_cache.get("flows") is cache.get("flows"):
                        _dual_cache["suggest"] = cache["suggest"]
            self._json(200, cache["suggest"])
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
            self._json(200, _progress())
            return

        if path == "/api/resolve-chain":
            with _chain_lock:
                self._json(200, {"running": _chain["running"], "todo": _chain["todo"], "steps": list(_chain["steps"])})
            return

        if path == "/api/backups":
            self._json(200, {"backups": _backups(), "folder": str(BACKUP_DIR)})
            return

        if path.startswith("/api/backup/"):
            name = path[len("/api/backup/"):]
            f = BACKUP_DIR / name
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,120}\.zip", name) or not f.exists():
                self._json(404, {"error": "No such backup"})
                return
            body = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", f'attachment; filename="{name}"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/grid-status":
            self._json(200, _grid_status())
            return

        if path.startswith("/api/history/"):
            key = path[len("/api/history/"):]
            if not _valid_key(key):
                self._json(400, {"error": "Bad key"})
                return
            self._json(200, {"versions": _history(key)})
            return

        if path == "/api/save-nodes":
            sv = _save_nodes()
            self._json(200, {**sv, "changes": _unlock_changes(sv.get("unlocks"))})
            return

        if path == "/api/map-settings":
            self._json(200, _map_settings())
            return

        if path == "/api/map-image":
            st = _map_settings()
            f = (MAP_IMAGE_DIR / f"map_image.{st['ext']}" if st["source"] == "own"
                 else _game_map_path() if st["source"] == "game" else None)
            if not f or not f.exists():
                self._json(404, {"error": "No map image"})
                return
            body = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", _IMAGE_CTYPE[st["ext"]])
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/build-list":
            self._json(200, {"factories": _build_list()})
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
            self._json(200, {"factories": _blackboard_factories(), "layout": _load_board(), "grid": _grid(),
                             "fluids": logistics.META["fluids"],
                             "transport": logistics.META["transport"]})
            return

        self._json(404, {"error": "Not found"})

    @staticmethod
    def _with_alerts(rows):
        """Each saved factory with its alerts: imports or storage more than
        their source has left (it changed since)."""
        try:
            out = _factory_outputs()
            alerts = out["alerts"]
            fresh = {f["key"]: f["solved"] and not f["stale"] for f in out["factories"]}
        except Exception:
            alerts, fresh = {}, {}
        return [{**r, "alerts": alerts.get(r["key"], []), "fresh": fresh.get(r["key"], False)} for r in rows]

    # ── POST / PUT ────────────────────────────────────────────────────────────

    def do_POST(self): self._guard(self._handle_write)
    def do_PUT(self):  self._guard(self._handle_write)

    def _handle_write(self):
        path = urlparse(self.path).path.rstrip("/")

        if path == "/api/network":
            b = self._read_obj()
            have = {k for k, _ in _scenario_files()}
            routes = [{"a": r["a"], "b": r["b"], "mode": r.get("mode") if r.get("mode") in ("belt", "train", "truck", "drone") else "belt",
                       "trip_min": _num(r.get("trip_min"), 4.0, 0.1)}
                      for r in (b.get("routes") if isinstance(b.get("routes"), list) else [])
                      if isinstance(r, dict) and r.get("a") in have and r.get("b") in have and r["a"] != r["b"]]
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

        if path == "/api/resolve-chain":
            b = self._read_obj()
            keys = b.get("keys")
            if keys is not None:
                if not isinstance(keys, list):
                    raise _BadRequest("keys is a list of factory keys")
                keys = [k for k in keys if isinstance(k, str) and _valid_key(k)]
            self._json(200, _chain_start(keys))
            return

        if path == "/api/apply-network":
            b = self._read_obj()
            flows = [{"from": f["from"], "to": f["to"], "item": f["item"], "rate": _num(f.get("rate"), 0.0, 0.0)}
                     for f in (b.get("flows") if isinstance(b.get("flows"), list) else [])
                     if isinstance(f, dict) and all(isinstance(f.get(k), str) and f[k] for k in ("from", "to", "item"))
                     and _valid_key(f["from"]) and _valid_key(f["to"])]
            flows = [f for f in flows if f["rate"] > 0]
            alts = {k: [a for a in v if isinstance(a, str)] for k, v in
                    (b.get("alts").items() if isinstance(b.get("alts"), dict) else []) if _valid_key(k) and isinstance(v, list)}
            try:
                changed = _apply_network(flows, alts)
                self._json(200, {"changed": changed, **(_chain_start(changed) if changed else {"todo": []})})
            except Exception as e:
                import traceback; traceback.print_exc()
                self._json(500, {"error": str(e)})
            return

        if path.startswith("/api/history/") and path.endswith("/confirm"):
            parts = path[len("/api/history/"):-len("/confirm")].split("/")
            if len(parts) != 2 or not all(_valid_key(x) for x in parts):
                self._json(400, {"error": "Bad key"})
                return
            body = self._read_obj()
            with _save_lock:
                _history_confirm(parts[0], parts[1], bool(body.get("on", True)))
            self._json(200, {"versions": _history(parts[0])})
            return

        if path.startswith("/api/history/") and path.endswith("/restore"):
            parts = path[len("/api/history/"):-len("/restore")].split("/")
            if len(parts) != 2 or not all(_valid_key(x) for x in parts):
                self._json(400, {"error": "Bad key"})
                return
            key, vid = parts
            src = HISTORY_DIR / key / f"{vid}.yaml"
            if not src.exists():
                self._json(404, {"error": "No such version"})
                return
            with _save_lock:
                raw = src.read_bytes()   # before keeping the current one can prune it
                _history_keep(key, yaml.safe_load(raw) or {})
                (SCENARIOS_DIR / f"{key}.yaml").write_bytes(raw)
                for k in [k for k in _scenario_load_cache if k[0] == key]:
                    del _scenario_load_cache[k]
            self._json(200, {"restored": vid})
            return

        if path == "/api/backup":
            with _save_lock:
                f = _backup_make()
            self._json(200, {"file": f.name, "backups": _backups(), "folder": str(BACKUP_DIR)})
            return

        if path == "/api/restore":
            # a backup: one from backups/ by name ({"file"}), or the zip itself
            if (self.headers.get("Content-Type") or "").startswith("application/json"):
                name = self._read_obj().get("file")
                f = BACKUP_DIR / str(name)
                if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,120}\.zip", name) or not f.exists():
                    raise _BadRequest("No such backup")
                raw = f.read_bytes()
            else:
                length = int(self.headers.get("Content-Length", 0) or 0)
                if not length or length > _BACKUP_MAX:
                    raise _BadRequest("No backup sent" if not length else "That backup is too big")
                raw = self.rfile.read(length)
            with _save_lock:
                out = _backup_restore(raw)
            self._json(200, {**out, "backups": _backups()})
            return

        if path == "/api/save-file":
            # The raw .sav: mark the nodes it already mines
            length = int(self.headers.get("Content-Length", 0))
            try:
                sv = savefile.read(self.rfile.read(length))
            except Exception as e:
                self._json(400, {"error": str(e)})
                return
            known = supply.map_nodes()
            import time as _t
            out = {"file": self.headers.get("X-File-Name", ""), "when": int(_t.time()),
                   "nodes": [i for i in sv["nodes"] if i in known],
                   "unknown": len([i for i in sv["nodes"] if i not in known]),
                   "unlocks": savefile.unlocks(sv["recipes"]) if sv["recipes"] else None}
            SAVE_NODES_PATH.write_text(json.dumps(out), encoding="utf-8")
            self._json(200, {**out, "changes": _unlock_changes(out["unlocks"])})
            return

        if path == "/api/save-unlocks":
            # Make the planner's shared unlocks match the last save read
            u = _save_nodes().get("unlocks")
            if not u:
                self._json(400, {"error": "No save with unlocks read yet"})
                return
            supply.save_progress({"machines": u["machines"], **{k: u[k] for k in ("miner", "belt", "pipe") if u.get(k)}})
            _save_unlocked_alts(u["alts"])
            self._json(200, {"progress": _progress(), "unlocked": _load_unlocked_alts()})
            return

        if path == "/api/map-image":
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip()
            if ctype not in _IMAGE_TYPES:
                self._json(400, {"error": "PNG, JPEG or WebP only"})
                return
            length = int(self.headers.get("Content-Length", 0))
            for old in MAP_IMAGE_DIR.glob("map_image.*"):
                if old.suffix != ".json":
                    old.unlink()
            (MAP_IMAGE_DIR / f"map_image.{_IMAGE_TYPES[ctype]}").write_bytes(self.rfile.read(length))
            MAP_SETTINGS_PATH.write_text(json.dumps({**_own_map(), "ext": _IMAGE_TYPES[ctype]}), encoding="utf-8")
            self._json(200, _map_settings())
            return

        if path == "/api/map-game":   # try fetching the game's map again
            with _game_map_lock:
                if _game_map["state"] == "failed":
                    _game_map.update(state="idle", error=None)
            self._json(200, _map_settings())
            return

        if path == "/api/map-settings":
            data = self._read_obj()
            st = {**_own_map(), **{k: _num(data[k], None) for k in ("dx", "dy", "scale", "opacity")
                                   if k in data and _num(data[k], None) is not None}}
            MAP_SETTINGS_PATH.write_text(json.dumps(st), encoding="utf-8")
            self._json(200, _map_settings())
            return

        if path == "/api/progress":
            self._json(200, supply.save_progress(self._read_obj()))
            return

        if path == "/api/blackboard":
            data = self._read_obj()
            try:
                _save_board(data)
                self._json(200, {"ok": True})
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path == "/api/unlocked-alts":
            data = self._read_obj()
            if not isinstance(data.get("unlocked", []), list):
                raise _BadRequest("unlocked is a list of recipe keys")
            keys = [k for k in data.get("unlocked") or [] if isinstance(k, str) and k in ALL_RECIPES]
            try:
                _save_unlocked_alts(keys)
                self._json(200, {"unlocked": _load_unlocked_alts()})
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path == "/api/solve":
            # Async endpoint: dispatches solve to a background thread immediately
            # and returns a job ID. Client polls GET /api/solve/<id>.
            b = self._read_obj()
            if not b:
                self._json(400, {"error": "No data"})
                return
            b = _clean_scenario(b)
            if b.get("base_scenario") is not None:
                b["base_scenario"] = _clean_scenario(b["base_scenario"])
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
            hit = _cache_lookup(key, sig, owed, base.available_resources)
            if hit is not None:
                # Unchanged inputs: answer at once from the cache, and record it
                # as this scenario's last solve (it may have come from another
                # scenario with the same settings)
                if _cache_read(key) != hit:
                    _cache_store(key, sig, base_sig, styles, hit["result"], hit.get("owed"), hit.get("owed_dropped", False))
                cached = _owed_fields(hit["result"], owed, b.get("base_scenario") or b)
                _set_dual_cache(s, cached)
                with _jobs_lock:
                    _jobs[job_id] = {"status": "done", "result": cached}
                self._json(202, {"job_id": job_id})
                return
            with _jobs_lock:
                _jobs[job_id] = {"status": "pending", "result": None}
            t = threading.Thread(
                target=_run_solve_job,
                args=(job_id, s, ALL_RECIPES, MACHINE_META, (key, sig, base_sig, styles), owed,
                      b.get("base_scenario") or b),
                daemon=True,
            )
            t.start()
            self._json(202, {"job_id": job_id})
            return

        if path.startswith("/api/scenarios/"):
            name = path[len("/api/scenarios/"):]
            if not _valid_key(name):
                self._json(400, {"error": "A factory key is letters, digits, _ and - only"})
                return
            data = self._read_obj()
            p    = self._scenario_path(name)
            if not data:
                self._json(400, {"error": "No data"})
                return
            renamed_raw = data.get("_renamed_from")
            data = _clean_scenario(data)
            if renamed_raw is not None:
                data["_renamed_from"] = renamed_raw
            renamed = data.pop("_renamed_from", None)
            if renamed is not None and not _valid_key(str(renamed)):
                renamed = None
            with _save_lock:
                cut = _hold_claims(name, data)
                _history_keep(name, data)
                _write_yaml(p, data)
                for k in [k for k in _scenario_load_cache if k[0] == name]:
                    del _scenario_load_cache[k]
                if renamed and renamed != name and self._scenario_path(renamed).exists():
                    _rename(renamed, name, data.get("name", name))
            self._json(200, {"status": "saved", "key": name, "cut": cut,
                             **{k: data.get(k) for k in ("from_factories", "to_storage", "resource_nodes",
                                                         "power_shards_available", "somersloops_available")}})
            return

        self._json(404, {"error": "Not found"})

    # ── DELETE ────────────────────────────────────────────────────────────────

    def do_DELETE(self): self._guard(self._delete)

    def _delete(self):
        path = urlparse(self.path).path.rstrip("/")
        if path == "/api/map-image":   # your own picture goes: back to the game's map
            for old in MAP_IMAGE_DIR.glob("map_image.*"):
                if old.suffix != ".json":
                    old.unlink()
            self._json(200, _map_settings())
            return
        if path.startswith("/api/scenarios/"):
            name = path[len("/api/scenarios/"):]
            if not _valid_key(name):
                self._json(400, {"error": "A factory key is letters, digits, _ and - only"})
                return
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
