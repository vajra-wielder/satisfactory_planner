"""
logistics.py — what each saved factory takes in and sends out, for the
Blackboard's factory planner.

A saved scenario is a whole factory. Seen from outside it is a black box:
  imports  parts and fluids it is supplied with that aren't mined from nodes
           (at the rate its last plan actually draws them)
  exports  its goal items, and surplus byproducts another factory could use
           (at the rates its last plan makes them)
Node resources (ore, crude, water…) are the factory's own supply and stay
inside the box.
"""
from typing import Dict, Optional


from solver import _load_raw_yaml
import supply


def _load_meta() -> dict:
    raw = _load_raw_yaml()
    return {
        "fluids": list(raw.get("fluids") or []),
        "node_resources": list(raw.get("node_resources") or []),
        "transport": raw.get("transport") or {},
    }


META = _load_meta()
_NODE = set(META["node_resources"])


def factory_io(scenario: dict, result: Optional[dict]) -> dict:
    """{imports, exports, surplus, spare, solved}: item → rate per minute
    (spare: what its own nodes give that its plan doesn't use).
    Without a plan, the scenario's own declared numbers stand in."""
    supplied = {k: v for k, v in supply.available(scenario).items() if v > 0}
    goals = (set(scenario.get("objective") or {}) | set(scenario.get("must_produce") or {})
             | set(scenario.get("min_produce") or {}))
    if result is None or not str(result.get("status", "")).startswith("Optimal"):
        return {
            "solved": False,
            "imports": {k: round(v, 3) for k, v in supplied.items() if k not in _NODE},
            # objective items have no rate until solved ("max")
            "exports": {**{k: None for k in (scenario.get("objective") or {})},
                        **{k: round(float(v), 3) for k, v in
                           {**(scenario.get("min_produce") or {}), **(scenario.get("must_produce") or {})}.items()}},
            "surplus": {},
            "spare": {},
        }
    drawn: Dict[str, float] = {}
    for f in result.get("flows", []):
        for it, q in (f.get("inputs") or {}).items():
            drawn[it] = drawn.get(it, 0.0) + q
        for it, q in (f.get("outputs") or {}).items():
            drawn[it] = drawn.get(it, 0.0) - q
    imports = {k: round(drawn[k], 3) for k in supplied
               if k not in _NODE and drawn.get(k, 0.0) > 1e-4}
    spare = spare_supply(scenario, result)
    exports = {k: round(v, 3) for k, v in (result.get("sink_nodes") or {}).items()
               if k in goals and v > 1e-4}
    surplus = {k: round(v, 3) for k, v in {**(result.get("surplus_intermediates") or {}),
                                           **(result.get("error_sinks") or {})}.items()
               if v > 1e-4 and k not in exports}
    return {"solved": True, "imports": imports, "exports": exports, "surplus": surplus, "spare": spare}


def spare_supply(scenario: dict, result: dict) -> Dict[str, float]:
    """What a factory's own nodes give that its plan doesn't use, per minute —
    free for a factory nearby to take. Imports and unlimited resources aren't
    counted (an import left over goes back to where it came from)."""
    own = supply.available({**scenario, "from_factories": []}) if scenario.get("resource_nodes") is not None \
        else {k: float(v or 0) for k, v in (scenario.get("available_resources") or {}).items()
              if k not in {f.get("item") for f in scenario.get("from_factories") or []}}
    unlimited = set(scenario.get("unlimited_resources") or [])
    used = drawn(result)
    out = {}
    for k, v in own.items():
        if k not in _NODE or k in unlimited or v <= 0:   # only what's mined or pumped
            continue
        left = v - used.get(k, 0.0)
        if left > max(1e-3, v * 1e-6):
            out[k] = round(left, 3)
    return out


def made(result: dict) -> Dict[str, float]:
    """Everything a plan puts out, per minute: its goal outputs and its surplus."""
    out = {k: v for k, v in (result.get("sink_nodes") or {}).items() if v > 1e-4}
    for k, v in {**(result.get("surplus_intermediates") or {}), **(result.get("error_sinks") or {})}.items():
        if v > 1e-4 and k not in out:
            out[k] = v
    return out


def drawn(result: dict) -> Dict[str, float]:
    """What a plan uses of each item net of what it makes, per minute (> 0 only)."""
    out: Dict[str, float] = {}
    for f in result.get("flows", []):
        for it, q in (f.get("inputs") or {}).items():
            out[it] = out.get(it, 0.0) + q
        for it, q in (f.get("outputs") or {}).items():
            out[it] = out.get(it, 0.0) - q
    return {k: v for k, v in out.items() if v > 1e-6}
