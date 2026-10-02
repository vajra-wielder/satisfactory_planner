"""
savefile.py — what a Satisfactory save already mines, and what it has unlocked.

A .sav is a header followed by zlib-compressed chunks (each starting with the
Unreal package tag). Every extractor in the world — miner, oil extractor,
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
    }


def read(raw: bytes) -> dict:
    """{nodes, recipes}: the nodes a save mines and the recipes it has unlocked."""
    body = _body(raw)
    if not body:
        raise ValueError("Not a Satisfactory save (no compressed data found).")
    ids = set()
    for m in re.finditer(rb"mExtractableResource", body):
        r = _NODE.search(body, m.end(), m.end() + 400)
        if r:
            ids.add(r.group(1).decode())
    return {"nodes": sorted(ids), "recipes": _object_array(body, b"mAvailableRecipes")}
