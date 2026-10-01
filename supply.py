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


BELTS = ["Mk1", "Mk2", "Mk3", "Mk4", "Mk5", "Mk6"]
PIPES = ["Mk1", "Mk2"]

def _clean_progress(raw: dict) -> dict:
    """What you've unlocked and own, for every factory:
      miner     the miner tier — every miner runs at it
      machines  the machines unlocked (None: not set yet — every factory's own list)
      belt/pipe the best belt and pipe unlocked (the Blackboard's checks)
      shards / sloops  power shards and somersloops owned (None: not tracked)"""
    raw = raw if isinstance(raw, dict) else {}
    num = lambda v: None if v in (None, "") else max(0, int(float(v)))
    return {
        "miner": raw.get("miner") if raw.get("miner") in MINER_TIERS else "Mk3",
        "machines": sorted(set(raw["machines"])) if isinstance(raw.get("machines"), list) else None,
        "belt": raw.get("belt") if raw.get("belt") in BELTS else "Mk5",
        "pipe": raw.get("pipe") if raw.get("pipe") in PIPES else "Mk2",
        "shards": num(raw.get("shards")),
        "sloops": num(raw.get("sloops")),
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
    PROGRESS_PATH.write_text("# progress.yaml — what you've unlocked and own, for every factory\n"
                             + yaml.safe_dump(out, sort_keys=False), encoding="utf-8")
    return out


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
    miner = miner or load_progress()["miner"]
    total = 0.0
    for kind, count, clock in _extractors(data, miner):
        base = MINER_POWER[miner] if kind == "Miner" else EXTRACTOR_POWER.get(kind, 0.0)
        total += base * count * clock ** POWER_EXP
    return round(total, 3)


def extractor_build(data: dict, miner: Optional[str] = None) -> Dict[str, dict]:
    """{extractor: {count, cost: {item: amount}}} to build a scenario's extractors."""
    miner = miner or load_progress()["miner"]
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
