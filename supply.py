"""
supply.py — a factory's supply, from what it's built on.

A scenario lists its supply two ways:
  resource_nodes  the nodes it mines: [{resource, extractor, purity, clock, count}]
                  (extractor "fixed" = a plain rate: [{resource, extractor: fixed, rate}])
  from_factories  what it takes from other saved factories: [{item, factory, rate}]
Both add up into available_resources, which is all the solver sees. Scenarios
saved before nodes existed keep their available_resources as they are.
"""
from typing import Dict

PURITY = {"impure": 0.5, "normal": 1.0, "pure": 2.0}
_SOLIDS = ["Iron_Ore", "Copper_Ore", "Limestone", "Coal", "Caterium_Ore", "Raw_Quartz",
           "Sulfur", "Bauxite", "Uranium_Ore", "SAM"]

# Rate per node (or satellite) at 100% clock on a normal node; clock to 250%
EXTRACTORS = {
    "Miner_Mk1":       {"display": "Miner Mk.1", "rate": 60, "purity": True, "cap": 1200, "for": _SOLIDS},
    "Miner_Mk2":       {"display": "Miner Mk.2", "rate": 120, "purity": True, "cap": 1200, "for": _SOLIDS},
    "Miner_Mk3":       {"display": "Miner Mk.3", "rate": 240, "purity": True, "cap": 1200, "for": _SOLIDS},
    "Oil_Extractor":   {"display": "Oil Extractor", "rate": 120, "purity": True, "cap": 600, "for": ["Crude_Oil"]},
    "Water_Extractor": {"display": "Water Extractor", "rate": 120, "purity": False, "cap": 600, "for": ["Water"]},
    # count = satellite nodes on the well; the pressurizer's clock drives them all
    "Resource_Well":   {"display": "Resource Well", "rate": 60, "purity": True, "cap": None,
                        "for": ["Crude_Oil", "Nitrogen_Gas", "Water"]},
}
MAX_CLOCK = 250.0


def node_rate(n: dict) -> float:
    """Per minute from one resource_nodes entry."""
    ex = n.get("extractor") or "fixed"
    if ex == "fixed" or ex not in EXTRACTORS:
        return max(0.0, float(n.get("rate") or 0))
    e = EXTRACTORS[ex]
    clock = min(MAX_CLOCK, max(1.0, float(n.get("clock") or 100)))
    each = e["rate"] * (PURITY.get(n.get("purity") or "normal", 1.0) if e["purity"] else 1.0) * clock / 100
    if e["cap"]:
        each = min(each, e["cap"])
    count = n.get("count")
    return each * max(0, int(1 if count is None or count == "" else count))


def available(data: dict) -> Dict[str, float]:
    """available_resources for a scenario dict: nodes + imports from factories."""
    nodes, imports = data.get("resource_nodes"), data.get("from_factories")
    if nodes is None and imports is None:
        return {k: float(v or 0) for k, v in (data.get("available_resources") or {}).items()}
    out: Dict[str, float] = {}
    for n in nodes or []:
        if n.get("resource"):
            out[n["resource"]] = out.get(n["resource"], 0.0) + node_rate(n)
    for f in imports or []:
        if f.get("item"):
            out[f["item"]] = out.get(f["item"], 0.0) + max(0.0, float(f.get("rate") or 0))
    return {k: round(v, 6) for k, v in out.items()}
