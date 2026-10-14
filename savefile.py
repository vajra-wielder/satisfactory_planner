"""
savefile.py — what a Satisfactory save already mines, and what it has unlocked.

A .sav is a header followed by zlib-compressed chunks (each starting with the
Unreal package tag). The machines built (what each runs, where it stands) and
what the storage holds are read object by object — see _objects. Every extractor in the world — miner, oil extractor,
resource-well extractor, geothermal generator — saves an mExtractableResource
property naming the node it sits on, and the game's recipe manager saves
mAvailableRecipes, every recipe you've unlocked. Rather than parse the whole
format (it changes between game versions), this inflates the chunks and reads
just those: the nodes you've built on, and what you've unlocked.
"""
import json
import re
import struct
import zlib
from pathlib import Path
from typing import List

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
    """Node ids (as in data/map_nodes.json) that have an extractor on them."""
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


_CLASSES = Path(__file__).parent / "data" / "game_classes.json"


def unlocks(recipes: List[str]) -> dict:
    """What a save's unlocked recipes mean for the planner: its alternates, the
    machines it can build, the best miner, belt and pipe (None: none found)."""
    g = json.loads(_CLASSES.read_text(encoding="utf-8"))
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
    recipe or machine it has (data/unlocks.json)."""
    g = g or json.loads(_CLASSES.read_text(encoding="utf-8"))
    u = json.loads((Path(__file__).parent / "data" / "unlocks.json").read_text(encoding="utf-8"))
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

    out, starts, i = [], [m.start() for m in _HEAD.finditer(b)], 0
    while i < len(starts):
        t = toc(starts[i])
        got = t and data(t[1], len(t[0]))
        if got:
            out += list(zip(t[0], got[0]))
            while i < len(starts) and starts[i] < got[1]:
                i += 1
            continue
        i += 1
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
    g = json.loads(_CLASSES.read_text(encoding="utf-8"))
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
