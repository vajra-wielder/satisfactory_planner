"""
supply.py — a factory's supply, from what it's built on.

A scenario lists its supply three ways:
  resource_nodes  what it mines. A row is either
                    picked from the map:  {resource, extractor, nodes: [node ids], node_shards: {id: n}}
                      (one extractor per node, each with its shards; a well's satellites
                      share one pressurizer, whose shards are the row's)
                    or typed in:          {resource, extractor, purity, count, shards}
                    or a plain rate:      {resource, extractor: fixed, rate}
                  shards = power shards per extractor, 0–3: each takes the clock 50% higher
  from_factories  what it takes from other saved factories: [{item, factory, rate}]
  to_storage      what it sends to storage (a Dimensional Depot…): [{item, rate}] — out
                  of what it makes, so no other factory can take it
Nodes and imports add up into available_resources, which is all the solver
sees. Miners always run at the highest tier unlocked (data/progress.yaml).
Scenarios saved before nodes existed keep their available_resources as they are.
"""
import json
import zlib
import struct
import re
from pathlib import Path
from typing import Dict, List, Optional

import yaml

HERE = Path(__file__).parent
PROGRESS_PATH = HERE / "data" / "progress.yaml"
GAME_PATH = HERE / "data" / "game.json"
# The game's data: the map (every node, satellite and geyser) and its class
# names, with what unlocks each recipe and machine (python supply.py unlocks)
GAME = json.loads(GAME_PATH.read_text(encoding="utf-8"))

PURITY = {"impure": 0.5, "normal": 1.0, "pure": 2.0}
_SOLIDS = ["Iron_Ore", "Copper_Ore", "Limestone", "Coal", "Caterium_Ore", "Raw_Quartz",
           "Sulfur", "Bauxite", "Uranium_Ore", "SAM"]
MINER_TIERS = {"Mk1": 60, "Mk2": 120, "Mk3": 240}

# Rate per node (or satellite) at 100% clock on a normal node; "Miner" is at the unlocked tier
EXTRACTORS = {
    "Miner":           {"display": "Miner", "rate": None, "purity": True, "cap": 1200, "for": _SOLIDS},
    "Oil_Extractor":   {"display": "Oil Extractor", "rate": 120, "purity": True, "cap": 600, "for": ["Crude_Oil"]},
    "Water_Extractor": {"display": "Water Extractor", "rate": 120, "purity": False, "cap": 600, "for": ["Water"]},
    # nodes = the satellites; the pressurizer's clock drives them all
    "Resource_Well":   {"display": "Resource Well", "rate": 60, "purity": True, "cap": None,
                        "for": ["Crude_Oil", "Nitrogen_Gas", "Water"]},
}
_OLD = {"Miner_Mk1": "Miner", "Miner_Mk2": "Miner", "Miner_Mk3": "Miner"}   # always the highest now
MAX_SHARDS = 3

# Geothermal generators on geysers: power, no input. A geyser's output swings
# between half and one and a half times this; the plan counts the average.
GEOTHERMAL_MW = {"impure": 100.0, "normal": 200.0, "pure": 400.0}
GEOTHERMAL = "Geothermal_Generator"

# What each extractor draws (MW at 100%; overclocking raises it by clock^1.321929)
# and what it takes to build — for the power totals and the build list (game data)
POWER_EXP = 1.321929
MINER_POWER = {"Mk1": 5.0, "Mk2": 15.0, "Mk3": 45.0}
EXTRACTOR_POWER = {"Oil_Extractor": 40.0, "Water_Extractor": 20.0, "Resource_Well": 150.0}
MINER_BUILD = {
    "Mk1": {"Portable_Miner": 1, "Iron_Plate": 10, "Concrete": 10},
    "Mk2": {"Portable_Miner": 2, "Encased_Industrial_Beam": 10, "Steel_Pipe": 20, "Modular_Frame": 10},
    "Mk3": {"Portable_Miner": 3, "Steel_Pipe": 50, "Supercomputer": 5, "Fused_Modular_Frame": 10, "Turbo_Motor": 3},
}
BUILD = {
    "Oil_Extractor": {"Motor": 15, "Encased_Industrial_Beam": 20, "Cable": 60},
    "Water_Extractor": {"Copper_Sheet": 20, "Reinforced_Iron_Plate": 10, "Rotor": 10},
    "Resource_Well": {"Lightweight_Frame": 10, "Heavy_Modular_Frame": 25, "Motor": 50,     # the pressurizer
                      "Alclad_Aluminum_Sheet": 50, "Rubber": 100},
    "Resource_Well_Extractor": {"Steel_Beam": 10, "Aluminum_Casing": 10},                 # one per satellite
    GEOTHERMAL: {"Motor": 10, "Modular_Frame": 25, "High_Speed_Connector": 25, "Copper_Sheet": 50, "Wire": 250},
}


# What unlocks each recipe and machine: milestones and MAM research (python supply.py unlocks)
UNLOCKS = GAME["classes"]["unlocks"]

def locked_recipes(progress: dict) -> List[str]:
    """The recipes a milestone or MAM research you haven't done unlocks — none
    while the progress isn't set."""
    done = progress.get("schematics")
    if done is None:
        return []
    done = set(done)
    return sorted(k for k, s in UNLOCKS["recipes"].items() if s not in done)

BELTS = ["Mk1", "Mk2", "Mk3", "Mk4", "Mk5", "Mk6"]
PIPES = ["Mk1", "Mk2"]

def _clean_progress(raw: dict) -> dict:
    """What you've unlocked and own, for every factory:
      miner     the miner tier — every miner runs at it
      machines  the machines unlocked (None: not set yet — every factory's own list)
      belt/pipe the best belt and pipe unlocked (the Blackboard's checks)
      schematics the milestones (tier + sub-tier) and MAM research done
                (data/game.json unlocks ids; None: not set — every recipe allowed)"""
    raw = raw if isinstance(raw, dict) else {}
    sch = raw.get("schematics")
    return {
        "miner": raw.get("miner") if raw.get("miner") in MINER_TIERS else "Mk3",
        "machines": sorted(set(raw["machines"])) if isinstance(raw.get("machines"), list) else None,
        "belt": raw.get("belt") if raw.get("belt") in BELTS else "Mk5",
        "pipe": raw.get("pipe") if raw.get("pipe") in PIPES else "Mk2",
        "schematics": sorted({s for s in sch if isinstance(s, str) and s in UNLOCKS["schematics"]})
                      if isinstance(sch, list) else None,
    }

def load_progress() -> dict:
    try:
        raw = yaml.safe_load(PROGRESS_PATH.read_text(encoding="utf-8")) if PROGRESS_PATH.exists() else None
    except Exception:
        raw = None
    return _clean_progress(raw)


def save_progress(p: dict) -> dict:
    """Merge p into what's saved."""
    out = _clean_progress({**load_progress(), **(p if isinstance(p, dict) else {})})
    PROGRESS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS_PATH.write_text("# progress.yaml — what you've unlocked, for every factory\n"
                             + yaml.safe_dump(out, sort_keys=False), encoding="utf-8")
    return out


_MAP: Optional[dict] = None

def map_nodes() -> Dict[str, dict]:
    """Node id → {r, p, x, y, w?}, from the map in data/game.json."""
    global _MAP
    if _MAP is None:
        _MAP = {n["id"]: n for n in GAME["map"]["nodes"]}
    return _MAP


def _clock(n: dict, shards=None) -> float:
    shards = n.get("shards") if shards is None else shards
    if shards is not None:
        return 100.0 + 50.0 * min(MAX_SHARDS, max(0, int(shards or 0)))
    return min(250.0, max(1.0, float(n.get("clock") or 100)))   # rows saved with a clock


def node_rate(n: dict, miner: str = "Mk3") -> float:
    """Per minute from one resource_nodes row."""
    ex = _OLD.get(n.get("extractor"), n.get("extractor") or "fixed")
    if ex not in EXTRACTORS:
        return max(0.0, float(n.get("rate") or 0))
    e = EXTRACTORS[ex]
    base = MINER_TIERS[miner] if ex == "Miner" else e["rate"]
    clock = _clock(n) / 100
    if n.get("nodes"):
        purities = [map_nodes().get(i, {}).get("p", "normal") for i in n["nodes"]]
        if ex == "Resource_Well":          # one pressurizer: its clock, every satellite's purity
            return sum(base * PURITY.get(p, 1.0) for p in purities) * clock
        per = n.get("node_shards") or {}     # one extractor per node, each with its own shards
        each = [base * PURITY.get(p, 1.0) * _clock(n, per.get(i)) / 100 for i, p in zip(n["nodes"], purities)]
        return sum(min(r, e["cap"]) if e["cap"] else r for r in each)
    each = base * (PURITY.get(n.get("purity") or "normal", 1.0) if e["purity"] else 1.0) * clock
    if e["cap"]:
        each = min(each, e["cap"])
    count = n.get("count")
    return each * max(0, int(1 if count is None or count == "" else count))


def miner_of(data: dict) -> str:
    """The miners a factory is built with: its own tier, saved with it — or,
    for one that hasn't one yet, the tier unlocked. A factory keeps its tier
    when a better one is unlocked (its supply and power stay what's built);
    it's upgraded when you say so."""
    m = data.get("miner") if isinstance(data, dict) else None
    return m if m in MINER_TIERS else load_progress()["miner"]

def miner_count(data: dict) -> int:
    return sum(c for kind, c, _ in _extractors(data, miner_of(data)) if kind == "Miner")

def available(data: dict, miner: Optional[str] = None) -> Dict[str, float]:
    """available_resources for a scenario dict: nodes + imports from factories."""
    nodes, imports = data.get("resource_nodes"), data.get("from_factories")
    if nodes is None and imports is None:
        return {k: float(v or 0) for k, v in (data.get("available_resources") or {}).items()}
    miner = miner or miner_of(data)
    out: Dict[str, float] = {}
    for n in nodes or []:
        if n.get("resource") and n.get("extractor") != GEOTHERMAL:
            out[n["resource"]] = out.get(n["resource"], 0.0) + node_rate(n, miner)
    for f in imports or []:
        if f.get("item"):
            out[f["item"]] = out.get(f["item"], 0.0) + max(0.0, float(f.get("rate") or 0))
    return {k: round(v, 6) for k, v in out.items()}


def nodes_of(data: dict):
    """Map node ids a scenario mines."""
    return [i for n in data.get("resource_nodes") or [] for i in n.get("nodes") or []]


def geothermal_mw(data: dict) -> float:
    """Average MW from the geysers a scenario has geothermal generators on."""
    return sum(GEOTHERMAL_MW.get(map_nodes().get(i, {}).get("p"), 0.0)
               for n in data.get("resource_nodes") or [] if n.get("extractor") == GEOTHERMAL
               for i in n.get("nodes") or [])


def _extractors(data: dict, miner: str):
    """(kind, count, clock) for every extractor a scenario builds: miners at the
    unlocked tier, oil and water extractors, a well's pressurizer and its
    satellite extractors, geothermal generators."""
    for n in data.get("resource_nodes") or []:
        ex = _OLD.get(n.get("extractor"), n.get("extractor"))
        if ex == GEOTHERMAL:
            yield GEOTHERMAL, len(n.get("nodes") or []), 1.0
        elif ex == "Resource_Well":
            if n.get("nodes"):
                yield "Resource_Well", 1, _clock(n) / 100
                yield "Resource_Well_Extractor", len(n["nodes"]), 1.0
            else:   # typed in: count = satellites, one pressurizer
                yield "Resource_Well", 1, _clock(n) / 100
                yield "Resource_Well_Extractor", max(0, int(n.get("count") or 1)), 1.0
        elif ex in EXTRACTORS:
            if n.get("nodes"):
                per = n.get("node_shards") or {}
                for i in n["nodes"]:
                    yield ex, 1, _clock(n, per.get(i)) / 100
            else:
                count = n.get("count")
                yield ex, max(0, int(1 if count is None or count == "" else count)), _clock(n) / 100


def extractor_power(data: dict, miner: Optional[str] = None) -> float:
    """MW the extractors draw (not part of the solve: they're built whatever the plan)."""
    miner = miner or miner_of(data)
    total = 0.0
    for kind, count, clock in _extractors(data, miner):
        base = MINER_POWER[miner] if kind == "Miner" else EXTRACTOR_POWER.get(kind, 0.0)
        total += base * count * clock ** POWER_EXP
    return round(total, 3)


def extractor_build(data: dict, miner: Optional[str] = None) -> Dict[str, dict]:
    """{extractor: {count, cost: {item: amount}}} to build a scenario's extractors."""
    miner = miner or miner_of(data)
    out: Dict[str, dict] = {}
    for kind, count, _ in _extractors(data, miner):
        if not count:
            continue
        name = f"Miner_{miner}" if kind == "Miner" else kind
        cost = MINER_BUILD[miner] if kind == "Miner" else BUILD.get(kind, {})
        e = out.setdefault(name, {"count": 0, "cost": {}})
        e["count"] += count
        for it, a in cost.items():
            e["cost"][it] = e["cost"].get(it, 0) + a * count
    return out


def shards_used(data: dict) -> int:
    """Power shards a scenario holds: its machines' and its extractors'."""
    ex = 0
    for n in data.get("resource_nodes") or []:
        if n.get("extractor") in (GEOTHERMAL, "fixed") or n.get("extractor") not in {**EXTRACTORS, **_OLD}:
            continue
        if n.get("nodes") and n.get("extractor") != "Resource_Well":
            per = n.get("node_shards") or {}
            ex += sum(int(per.get(i, n.get("shards") or 0) or 0) for i in n["nodes"])
        else:
            mult = 1 if n.get("nodes") or n.get("extractor") == "Resource_Well" else int(n.get("count") or 1)
            ex += int(n.get("shards") or 0) * mult
    return int(data.get("power_shards_available") or 0) + ex


# ── A game save ─────────────────────────────────────────────────────────────
# what a Satisfactory save already mines, and what it has unlocked.
# 
# A .sav is a header followed by zlib-compressed chunks (each starting with the
# Unreal package tag). The machines built (what each runs, where it stands) and
# what the storage holds are read object by object — see _objects. Every extractor in the world — miner, oil extractor,
# resource-well extractor, geothermal generator — saves an mExtractableResource
# property naming the node it sits on, and the game's recipe manager saves
# mAvailableRecipes, every recipe you've unlocked. Rather than parse the whole
# format (it changes between game versions), this inflates the chunks and reads
# just those: the nodes you've built on, and what you've unlocked.

_TAG = struct.pack("<I", 0x9E2A83C1)
_ZLIB = (0x01, 0x5E, 0x9C, 0xDA)
_NODE = re.compile(rb"PersistentLevel\.BP_((?:ResourceNode|FrackingSatellite)[A-Za-z0-9_]*)")


def _body(raw: bytes) -> bytes:
    out, i = [], raw.find(_TAG)
    while i != -1:
        data, end = None, i + 4
        for k in range(i + 4, min(i + 96, len(raw) - 2)):   # the zlib stream starts after the chunk header
            if raw[k] == 0x78 and raw[k + 1] in _ZLIB:
                try:
                    d = zlib.decompressobj()
                    data = d.decompress(raw[k:])
                    end = len(raw) - len(d.unused_data)
                    break
                except zlib.error:
                    continue
        if data:
            out.append(data)
        i = raw.find(_TAG, end)
    return b"".join(out)


def used_nodes(raw: bytes) -> List[str]:
    """Node ids (as in the map in data/game.json) that have an extractor on them."""
    return read(raw)["nodes"]


def _object_array(body: bytes, name: bytes) -> List[str]:
    """The class names in an array of object references saved as `name`
    (each entry: a level name, then a path like /Game/…/Recipe_X.Recipe_X_C)."""
    i = body.find(name + b"\x00")
    if i < 0:
        return []
    j = body.find(b"/Game/", i, i + 400)
    if j < 0:
        return []
    p = j - 8                                  # the entry's level name (empty) and the path's length
    count = struct.unpack("<i", body[p - 4:p])[0]
    out = []
    try:
        for _ in range(max(0, min(count, 100000))):
            n = struct.unpack("<i", body[p:p + 4])[0]
            p += 4 + max(n, 0)
            n = struct.unpack("<i", body[p:p + 4])[0]
            path = body[p + 4:p + 3 + n].decode("utf-8", "replace")
            p += 4 + n
            cls = path.rsplit(".", 1)[-1]
            out.append(cls[:-2] if cls.endswith("_C") else cls)
    except (struct.error, ValueError):
        pass
    return out




def unlocks(recipes: List[str]) -> dict:
    """What a save's unlocked recipes mean for the planner: its alternates, the
    machines it can build, the best miner, belt and pipe (None: none found)."""
    g = GAME["classes"]
    have = set(recipes)
    best = lambda tiers: ([t for t, c in tiers.items() if c in have] or [None])[-1]
    return {
        "alts": sorted(k for k, c in g["recipes"].items() if c in have and c.startswith("Recipe_Alternate")),
        "machines": sorted(m for m, c in g["machines"].items() if c in have),
        "miner": best(g["miners"]), "belt": best(g["belts"]), "pipe": best(g["pipes"]),
        "schematics": schematics_done(have, g),
    }


def schematics_done(have: set, g: dict = None) -> List[str]:
    """The milestones and MAM research a save has done: those that unlock a
    recipe or machine it has (the unlocks in data/game.json)."""
    g = g or GAME["classes"]
    u = g["unlocks"]
    done = {s for k, s in u["recipes"].items() if g["recipes"].get(k) in have}
    done |= {s for m, s in u["machines"].items() if g["machines"].get(m) in have}
    return sorted(done)


# ── Objects ──────────────────────────────────────────────────────────────────
# Each level saves a table of object headers (TOC: class, name, and for an
# actor where it stands) and then, in the same order, each object's data:
#   TOC:  int32 length, int32 0, int32 count, headers…
#   data: int32 length, int32 0, int32 count, per object [int32 version,
#         int32 migrate, int32 size, size bytes]
# A level is found where a TOC's first header follows its count; it holds when
# every header reads and the data's count and sizes add up exactly — so a
# version that lays them out differently is skipped, not misread.
_HEAD = re.compile(rb"[\x00\x01]\x00\x00\x00.\x00\x00\x00/(?:Script|Game)/", re.S)


def _objects(b: bytes):
    """[(header, (start, end) of its data)]; header = (1, class, name, (x, y, z) m)
    for an actor, (0, class, name, owner) for a component."""
    I = lambda p: struct.unpack_from("<i", b, p)[0]

    def text(p):
        n = I(p)
        if n == 0:
            return "", p + 4
        if n < 0:
            return b[p + 4:p + 4 - 2 * n - 2].decode("utf-16-le", "replace"), p + 4 - 2 * n
        if n > 4096:
            raise ValueError
        return b[p + 4:p + 3 + n].decode("utf-8", "replace"), p + 4 + n

    def header(p, flags):
        kind = I(p)
        cls, p = text(p + 4)
        _, p = text(p)
        name, p = text(p)
        p += 4 if flags else 0
        if kind == 1:
            f = struct.unpack_from("<10f", b, p + 4)
            return (1, cls, name, (f[4] / 100, f[5] / 100, f[6] / 100)), p + 48
        if kind == 0:
            owner, p = text(p)
            return (0, cls, name, owner), p
        raise ValueError

    def toc(c):
        if c < 12 or I(c - 8) != 0:
            return None
        L, n = I(c - 12), I(c - 4)
        if not (0 < n < 2_000_000 and 0 < L < len(b) - c):
            return None
        for flags in (True, False):
            try:
                p, hs = c, []
                for _ in range(n):
                    h, p = header(p, flags)
                    hs.append(h)
                if p <= c - 4 + L:
                    return hs, c - 4 + L
            except (ValueError, struct.error):
                continue
        return None

    def data(d, n):
        # newer saves follow each object with a flag for per-object version
        # data: 0 (none) is read past; any other layout doesn't add up
        try:
            if I(d + 4) != 0 or I(d + 8) != n:
                return None
            stop = d + 8 + I(d)
        except struct.error:
            return None
        for flag in (False, True):
            p, spans = d + 12, []
            try:
                for _ in range(n):
                    size = I(p + 8)
                    p += 12
                    if size < 0 or p + size > stop:
                        break
                    spans.append((p, p + size))
                    p += size
                    if flag:
                        if I(p) != 0:
                            break
                        p += 4
                else:
                    if p == stop:
                        return spans, stop
            except struct.error:
                continue
        return None

    # the next level is looked for after the last one found, never inside it
    out, m = [], _HEAD.search(b)
    while m:
        t = toc(m.start())
        got = t and data(t[1], len(t[0]))
        if got:
            out += zip(t[0], got[0])
        m = _HEAD.search(b, got[1] if got else m.start() + 1)
    return out


_RECIPE = re.compile(rb"/(Recipe_[A-Za-z0-9_]+)\.Recipe_")
_STACK = re.compile(rb"/((?:Desc|BP)_[A-Za-z0-9_]+)\.[A-Za-z0-9_]+_C\x00.{0,40}?NumItems\x00\x0c\x00\x00\x00IntProperty\x00.{9}(.{4})", re.S)
_AMOUNT = re.compile(rb"/((?:Desc|BP)_[A-Za-z0-9_]+)\.[A-Za-z0-9_]+_C\x00\x07\x00\x00\x00Amount\x00\x0c\x00\x00\x00IntProperty\x00.{9}(.{4})", re.S)


def built(b: bytes, objs=None) -> dict:
    """{machines: [{c: Build_ class, r: Recipe_ class or None, x, y}], stock:
    {Desc_ class: count}} — every production building and generator, and what
    the storage containers and the dimensional depot hold."""
    objs = _objects(b) if objs is None else objs
    machines, stock = [], {}
    owner = {h[2]: h[1] for h, _ in objs if h[0] == 1}
    for h, (s, e) in objs:
        if h[0] == 1 and ("/Buildable/Factory/" in h[1] or "/Buildable/Factory/Generator" in h[1]):
            cls = h[1].rsplit(".", 1)[-1][:-2]
            i = b.find(b"mCurrentRecipe\x00", s, e)
            r = _RECIPE.search(b, i, min(e, i + 300)) if i >= 0 else None
            if r or cls.startswith("Build_Generator"):
                machines.append({"c": cls, "r": r.group(1).decode() if r else None,
                                 "x": round(h[3][0], 1), "y": round(h[3][1], 1)})
        elif h[0] == 0 and "FGInventoryComponent" in h[1] and "Storage" in owner.get(h[3], ""):
            for m in _STACK.finditer(b, s, e):
                k = m.group(1).decode()
                stock[k] = stock.get(k, 0) + max(0, struct.unpack("<i", m.group(2))[0])
        elif h[1].endswith("FGCentralStorageSubsystem"):
            for m in _AMOUNT.finditer(b, s, e):
                k = m.group(1).decode()
                stock[k] = stock.get(k, 0) + max(0, struct.unpack("<i", m.group(2))[0])
    return {"machines": machines, "stock": stock}


# What the save's classes are in the planner
MACHINES = {"Build_SmelterMk1": "Smelter", "Build_ConstructorMk1": "Constructor", "Build_AssemblerMk1": "Assembler",
            "Build_FoundryMk1": "Foundry", "Build_ManufacturerMk1": "Manufacturer", "Build_OilRefinery": "Refinery",
            "Build_Packager": "Packager", "Build_Blender": "Blender", "Build_HadronCollider": "Particle_Accelerator",
            "Build_QuantumEncoder": "Quantum_Encoder", "Build_Converter": "Converter",
            "Build_GeneratorNuclear": "Nuclear_Power_Plant", "Build_GeneratorCoal": "Coal_Generator",
            "Build_GeneratorFuel": "Fuel_Generator"}
_ITEMS = {"IronPlateReinforced": "Reinforced_Iron_Plate", "SteelPlate": "Steel_Beam", "Cement": "Concrete",
          "ModularFrameHeavy": "Heavy_Modular_Frame", "ModularFrameFused": "Fused_Modular_Frame",
          "ModularFrameLightweight": "Lightweight_Frame", "MotorLightweight": "Turbo_Motor",
          "HighSpeedWire": "Quickwire", "ComputerSuper": "Supercomputer", "SteelPlateReinforced": "Encased_Industrial_Beam",
          "AluminumPlate": "Alclad_Aluminum_Sheet", "AluminumCasing": "Aluminum_Casing", "FicsiteMesh": "Ficsite_Trigon",
          "IronScrew": "Screw", "CircuitBoard": "Circuit_Board", "CircuitBoardHighSpeed": "AI_Limiter",
          "HighSpeedConnector": "High-Speed_Connector", "SAMFluctuator": "SAM_Fluctuator", "TimeCrystal": "Time_Crystal",
          "CoolingSystem": "Cooling_System"}


def recipe_keys() -> dict:
    """Recipe_ class → the planner's recipe key."""
    g = GAME["classes"]
    return {c: k for k, c in g["recipes"].items()}


def item_key(desc: str, items) -> str:
    """Desc_ class → the planner's item (its name squeezed, else as known), or None."""
    name = desc[5:] if desc.startswith("Desc_") else desc
    if name in _ITEMS:
        return _ITEMS[name]
    sq = {k.replace("_", "").replace("-", "").lower(): k for k in items}
    return sq.get(name.replace("_", "").lower())


def read(raw: bytes) -> dict:
    """{nodes, recipes, machines, stock}: the nodes a save mines, the recipes it
    has unlocked, the machines built and what the storage holds (built)."""
    body = _body(raw)
    if not body:
        raise ValueError("Not a Satisfactory save (no compressed data found).")
    ids = set()
    for m in re.finditer(rb"mExtractableResource", body):
        r = _NODE.search(body, m.end(), m.end() + 400)
        if r:
            ids.add(r.group(1).decode())
    try:
        b = built(body)
    except Exception:          # a layout it doesn't know: the nodes and unlocks still count
        b = {"machines": [], "stock": {}}
    return {"nodes": sorted(ids), "recipes": _object_array(body, b"mAvailableRecipes"), **b}


# ── Building the unlocks ─────────────────────────────────────────────────────
# The unlocks in data/game.json — what unlocks each recipe and machine in 1.0 —
# from the open SatisfactoryTools game data (github.com/greeny/SatisfactoryTools,
# data/data1.0.json):
# 
#     python supply.py unlocks path/to/data1.0.json
# 
#   schematics  id → {tier, name, kind}: milestones (Tier 1–9 and their
#               sub-tiers), the HUB upgrades (Tier 0) and MAM research (kind
#               "mam", with its tree)
#   recipes     recipe key → the schematic that unlocks it — only those a
#               milestone, HUB upgrade or MAM research unlocks; alternates come
#               from hard drives (unlocked_alts) and a recipe no schematic lists
#               (unpacking, converter swaps, generators) comes with its machine
#   machines    machine → the schematic that unlocks it

_KIND = {"EST_Milestone": "milestone", "EST_Tutorial": "hub", "EST_MAM": "mam"}
_TREES = {"AO": "Alien Organisms", "ACarapace": "Alien Organisms", "AOrgans": "Alien Organisms", "Caterium": "Caterium",
         "FlowerPetals": "Flower Petals", "Mycelia": "Mycelia", "Nutrients": "Nutrients", "PowerSlugs": "Power Slugs",
         "Quartz": "Quartz", "Sulfur": "Sulfur", "HardDrive": "Hard Drive", "SAM": "SAM", "Ficsite": "SAM", "Alien": "SAM"}

def build_unlocks(src):
    d = json.loads(Path(src).read_text(encoding="utf-8"))
    classes = GAME["classes"]
    ours = yaml.safe_load((HERE / "data" / "recipes_complete.yaml").read_text(encoding="utf-8"))["recipes"]
    sch, by = {}, {}
    for sid, s in d["schematics"].items():
        kind = _KIND.get(s["type"])
        if not kind:
            continue
        sid = sid[:-2] if sid.endswith("_C") else sid
        e = {"tier": int(s["tier"]), "name": s["name"], "kind": kind}
        if kind == "mam":
            e["tree"] = _TREES.get(sid.split("_")[1], sid.split("_")[1])
        sch[sid] = e
        for r in s["unlock"].get("recipes", []):
            by.setdefault(r[:-2] if r.endswith("_C") else r, []).append(sid)
    first = lambda ids: min(ids, key=lambda i: (sch[i]["tier"], sch[i]["kind"] != "milestone", i))
    recipes = {k: first(by[classes["recipes"][k]]) for k, r in ours.items()
               if not r.get("alternate") and classes["recipes"].get(k) in by}
    machines = {m: first(by[c]) for m, c in classes["machines"].items() if c in by}
    used = set(recipes.values()) | set(machines.values())
    out = {"schematics": {k: v for k, v in sorted(sch.items(), key=lambda kv: (kv[1]["kind"] == "mam", kv[1]["tier"], kv[0]))
                          if k in used or v["kind"] in ("milestone", "hub")},
           "recipes": dict(sorted(recipes.items())), "machines": dict(sorted(machines.items()))}
    classes["unlocks"] = out
    GAME_PATH.write_text(json.dumps(GAME, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(out['recipes'])} recipes, {len(machines)} machines, {len(out['schematics'])} schematics")


if __name__ == "__main__":
    import sys
    if sys.argv[1:2] == ["unlocks"] and len(sys.argv) == 3:
        build_unlocks(sys.argv[2])
    else:
        print("python supply.py unlocks path/to/data1.0.json")
