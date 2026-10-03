"""A plan is valid when it keeps every promise its scenario makes."""


def check(sc, r):
    """Problems with plan r for scenario sc (empty when it's sound)."""
    errs = []
    for k, v in r.net_items.items():
        if v < -1e-3 and k not in sc.available_resources:
            errs.append(f"deficit {k}")
    for it in sc.available_resources:
        if r.net_items.get(it, 0) < -1e-3:
            errs.append(f"overuse {it}")
    for it, q in sc.must_produce.items():
        if abs(r.net_items.get(it, 0) - q) > max(0.05, q * 0.01):
            errs.append(f"must {it}")
    for it, q in sc.min_produce.items():
        if r.net_items.get(it, 0) < q - max(0.05, q * 0.01):
            errs.append(f"min {it}")
    if r.sloops_used > sc.somersloops_available:
        errs.append("sloops over")
    if r.shards_used > sc.power_shards_available:
        errs.append("shards over")
    if sc.max_power_mw is not None and r.total_power_mw > sc.max_power_mw + 0.5:
        errs.append("power over")
    for f in r.flows:
        lay = getattr(f, "layout", None)
        if not lay:
            continue
        cap = sum(g["count"] * g["clock_pct"] / 100 for g in lay)
        if abs(cap - f.machines_float) > 1e-3:
            errs.append(f"layout {f.recipe_key} {cap} vs {f.machines_float}")
        if sum(g["count"] for g in lay) != f.machines_final:
            errs.append(f"count {f.recipe_key}")
        if sum(g["count"] * g["shards"] for g in lay) != f.shards_used:
            errs.append(f"shardsum {f.recipe_key}")
        for g in lay:
            if g["clock_pct"] > 100 + 50 * g["shards"] + 1e-6:
                errs.append(f"clock {f.recipe_key}")
            if g.get("sloops", 0) > f.sloop_slots:
                errs.append(f"slots {f.recipe_key}")
        if "sloops" in lay[0] and sum(g["count"] * g["sloops"] for g in lay) != f.sloops_used:
            errs.append(f"sloopsum {f.recipe_key}")
    # no ghost leftovers: a byproduct or surplus shown is never a rounding crumb
    for k, v in {**r.error_sinks, **r.surplus_intermediates}.items():
        if v < 0.005:
            errs.append(f"crumb {k} {v}")
    return errs
