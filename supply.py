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
from pathlib import Path
from typing import Dict, Optional

import yaml

HERE = Path(__file__).parent
PROGRESS_PATH = HERE / "data" / "progress.yaml"
MAP_PATH = HERE / "data" / "map_nodes.json"

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


def load_progress() -> dict:
    try:
        raw = yaml.safe_load(PROGRESS_PATH.read_text(encoding="utf-8")) if PROGRESS_PATH.exists() else None
    except Exception:
        raw = None
    raw = raw if isinstance(raw, dict) else {}
    return {"miner": raw.get("miner") if raw.get("miner") in MINER_TIERS else "Mk3"}


def save_progress(p: dict) -> dict:
    tier = p.get("miner") if p.get("miner") in MINER_TIERS else "Mk3"
    PROGRESS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS_PATH.write_text("# progress.yaml — what you've unlocked, for every factory\n"
                             f"miner: {tier}\n", encoding="utf-8")
    return {"miner": tier}


_MAP: Optional[dict] = None

def map_nodes() -> Dict[str, dict]:
    """Node id → {r, p, x, y, w?} from data/map_nodes.json."""
    global _MAP
    if _MAP is None:
        try:
            _MAP = {n["id"]: n for n in json.loads(MAP_PATH.read_text(encoding="utf-8"))["nodes"]}
        except Exception:
            _MAP = {}
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


def available(data: dict, miner: Optional[str] = None) -> Dict[str, float]:
    """available_resources for a scenario dict: nodes + imports from factories."""
    nodes, imports = data.get("resource_nodes"), data.get("from_factories")
    if nodes is None and imports is None:
        return {k: float(v or 0) for k, v in (data.get("available_resources") or {}).items()}
    miner = miner or load_progress()["miner"]
    out: Dict[str, float] = {}
    for n in nodes or []:
        if n.get("resource"):
            out[n["resource"]] = out.get(n["resource"], 0.0) + node_rate(n, miner)
    for f in imports or []:
        if f.get("item"):
            out[f["item"]] = out.get(f["item"], 0.0) + max(0.0, float(f.get("rate") or 0))
    return {k: round(v, 6) for k, v in out.items()}


def nodes_of(data: dict):
    """Map node ids a scenario mines."""
    return [i for n in data.get("resource_nodes") or [] for i in n.get("nodes") or []]
