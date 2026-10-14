"""Build the unlocks in data/game_classes.json — what unlocks each recipe and machine in 1.0 —
from the open SatisfactoryTools game data (github.com/greeny/SatisfactoryTools,
data/data1.0.json):

    python tools/gen_unlocks.py path/to/data1.0.json

  schematics  id → {tier, name, kind}: milestones (Tier 1–9 and their
              sub-tiers), the HUB upgrades (Tier 0) and MAM research (kind
              "mam", with its tree)
  recipes     recipe key → the schematic that unlocks it — only those a
              milestone, HUB upgrade or MAM research unlocks; alternates come
              from hard drives (unlocked_alts) and a recipe no schematic lists
              (unpacking, converter swaps, generators) comes with its machine
  machines    machine → the schematic that unlocks it
"""
import json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
KIND = {"EST_Milestone": "milestone", "EST_Tutorial": "hub", "EST_MAM": "mam"}
TREES = {"AO": "Alien Organisms", "ACarapace": "Alien Organisms", "AOrgans": "Alien Organisms", "Caterium": "Caterium",
         "FlowerPetals": "Flower Petals", "Mycelia": "Mycelia", "Nutrients": "Nutrients", "PowerSlugs": "Power Slugs",
         "Quartz": "Quartz", "Sulfur": "Sulfur", "HardDrive": "Hard Drive", "SAM": "SAM", "Ficsite": "SAM", "Alien": "SAM"}

def main(src):
    d = json.loads(Path(src).read_text(encoding="utf-8"))
    classes = json.loads((HERE / "data" / "game_classes.json").read_text(encoding="utf-8"))
    import yaml
    ours = yaml.safe_load((HERE / "data" / "recipes_complete.yaml").read_text(encoding="utf-8"))["recipes"]
    sch, by = {}, {}
    for sid, s in d["schematics"].items():
        kind = KIND.get(s["type"])
        if not kind:
            continue
        sid = sid[:-2] if sid.endswith("_C") else sid
        e = {"tier": int(s["tier"]), "name": s["name"], "kind": kind}
        if kind == "mam":
            e["tree"] = TREES.get(sid.split("_")[1], sid.split("_")[1])
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
    (HERE / "data" / "game_classes.json").write_text(json.dumps(classes, indent=1) + "\n", encoding="utf-8")
    print(f"{len(out['recipes'])} recipes, {len(machines)} machines, {len(out['schematics'])} schematics")

if __name__ == "__main__":
    main(sys.argv[1])
