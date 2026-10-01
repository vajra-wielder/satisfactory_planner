"""
savefile.py — which resource nodes a Satisfactory save already mines.

A .sav is a header followed by zlib-compressed chunks (each starting with the
Unreal package tag). Every extractor in the world — miner, oil extractor,
resource-well extractor, geothermal generator — saves an mExtractableResource
property naming the node it sits on. Rather than parse the whole format (it
changes between game versions), this inflates the chunks and finds each of
those references: enough to mark the nodes you've built on, and nothing else.
"""
import re
import struct
import zlib
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
    body = _body(raw)
    if not body:
        raise ValueError("Not a Satisfactory save (no compressed data found).")
    ids = set()
    for m in re.finditer(rb"mExtractableResource", body):
        r = _NODE.search(body, m.end(), m.end() + 400)
        if r:
            ids.add(r.group(1).decode())
    return sorted(ids)
