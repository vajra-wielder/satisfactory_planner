# Satisfactory Factory Planner

A lightweight, standalone production planner for **Satisfactory** built with **Python, OR-Tools, and vanilla JavaScript**.

Unlike most web-based planners, this project uses a real optimization solver to generate factory layouts and production chains subject to resource, power, machine, and recipe constraints.

---

## Features

### Factory Optimization
- Exact mixed-integer solver (OR-Tools + SCIP), proven optimal
- Weighted multi-item objectives
- Resources as nodes: pick the nodes a factory mines on the 1.0 world map (every
  node and resource-well satellite, with its purity), or type them in. Nodes one
  factory mines are crossed out for the others. Power shards on the extractors
  (0–3 each, +50% clock per shard) decide how much comes out; "Spread" puts a
  number of shards where they add the most. Geysers take geothermal
  generators; water extractors are pins you drop where there's water. A fixed
  rate covers anything else
- Your save: load a .sav to mark the nodes your game already mines, on the map
  and on the Blackboard's Map tab, so you can plan which to take next. Load a
  picture of the in-game map to draw the nodes on (nudge it to line up)
- Shared unlocks, for every factory: the machines, the miner tier (miners always
  run at it), the best belt and pipe. Power shards and somersloops are owned
  once — enter how many you have, and each factory takes from that pool (its
  machines' shards and its extractors'); saving holds it to what's free
- From factories: take items another saved factory makes — an import adds to
  what the factory makes of it, it doesn't cap it. Pick the item (from
  everything your other factories' last plans make) and the factory; the rate
  starts at what that factory has left — what it makes less what other
  factories take and store — and can't go above it. Saving checks it again, so
  the same output can't be claimed twice. "All leftovers" imports everything
  the other factories have left over
- To storage: send part of what a factory makes to storage (a Dimensional
  Depot, a stockpile); no other factory can take that share
- Sent out: what other factories and storage take from a factory. Solving it
  makes at least that much (a cached plan that already does is reused); if it
  can't, the plan says how much it falls short
- Alerts: a factory whose imports or storage are now more than their source
  makes is flagged in the saved list, with a one-click fix on the import
- Re-solve the chain: everything out of date, or a factory and what takes from
  it, solved sources first — each importer held to what its sources make now
- Renaming a factory keeps its links: imports from it, its Blackboard place and
  routes, and its plan follow the new name
- History: each save keeps the version it replaces (the last 20); restore any
  from the Saved tab
- Production minimums, maximums, and exact requirements
- Least raw resources first, then least machine space (machines weighed by the
  room they take — w × l × h from `size_m` in the recipe data, in Smelter units:
  a Smelter is 1, a Manufacturer 9), then fewest recipes
- Mark abundant resources (e.g. Water) unlimited: uncapped and free
- Power cap: the plan is built to fit under it, as close as it can get (typically
  99%+ of the cap when power is what limits output)
- Power Shard placement optimised across the whole factory
- Somersloop placement optimised across the whole factory
- Power plants: Coal (coal, compacted coal, petroleum coke) and Fuel generators
  (fuel, turbofuel, rocket, ionized and liquid biofuel) and Nuclear plants make
  Power, in MW — a goal like any item, so a factory can be a power plant. A
  factory's own generators and geysers add to its power cap. Burning fuel rods
  yields Uranium/Plutonium waste, so full Plutonium and Ficsonium chains can be
  planned
- Last solve of each scenario cached and restored when the scenario is reopened

### Blackboard (logistics)
- Between factories: every saved scenario is a black box showing only what it
  imports and exports (from its last plan), where its imports come from and
  how much of each output others take. "From factories" imports are drawn as
  routes on their own. Join factories with routes (belt,
  train, truck or drone, with trip times) and plan the network: which recipe
  runs where, what crosses each route (items, stacks and cars / drones / lanes),
  what each factory draws, and how much more each goal the leftovers could make.
  Least resources first, then least transport, then least change from each
  factory's own plan, then least space. Click a factory to open it.
- Flows: a Sankey of everything moving between factories and into storage —
  as set in each factory, or as the network plan would send it.
- Storage: every item sent to storage, per minute and per hour, by factory.
- Power: what each factory's machines and extractors draw and its generators
  and geysers make, the grid's balance, and which factories their cap holds back.
- Build list: the machines (extractors and generators too) and the materials to
  build them, per factory or for any you pick — no belts, pipes or stations.
- Map: whose nodes are whose, what your save already mines, the pure nodes
  still free.
- Apply a network plan: what it sends between factories becomes their imports,
  the alternates it uses are switched on, then they're re-solved in order. A
  factory's own goals are always made in it.
- Inside a factory: belt splits with the fewest structures — a manifold for
  outputs that feed machines, an exact splitter tree with loop-back only where
  an output needs an exact rate.

### Recipe Management
- Recipe data checked against the 1.0 game files (rates, machines, build costs,
  per-recipe power for variable-power machines)
- Enable/disable alternate recipes
- Enable/disable machine tiers
- Searchable recipe database
- Scenario-based planning

### Interactive Graph
- Automatic DAG layout generation
- Pan and zoom
- Node dragging
- Expandable recipe details
- Flow-rate visualization
- Source, sink, surplus, and error tracking

### Scenario System
- Save scenarios
- Load scenarios
- Delete scenarios
- Notes and documentation support

---

## Tech Stack

### Backend
- Python 3.11+
- OR-Tools
- PyYAML
- Standard Library HTTP Server

### Frontend
- Vanilla JavaScript (ES Modules)
- HTML5 Canvas
- CSS

### Desktop Wrapper
- PyWebView

---

## Why This Project?

Most factory planners focus on calculators.

This project focuses on **optimization**.

Given:

- Available resources
- Desired outputs
- Machine restrictions
- Power restrictions
- Alternate recipe selections

the solver determines the optimal production plan automatically.

---

## Project Structure

```text
satisfactory-planner/
│
├── app.py
├── server.py
├── solver.py
├── recipes_complete.yaml
│
├── frontend/
│   ├── graph.js
│   ├── sidebar.js
│   ├── state.js
│   ├── api.js
│   └── style.css
│
├── scenarios/
│
└── data/
```

---

## Installation

### Clone

```bash
git clone https://github.com/vajra-wielder/satisfactory-planner.git
cd satisfactory-planner
```

### Install Dependencies

```bash
pip install ortools pyyaml pywebview
```

### Run

```bash
python app.py
```

The application launches as a native desktop window.

---

## Tests

```bash
python -m unittest discover -s tests -t .   # supply, claims, owed, chain, solver (seconds)
node --test tests/splits.test.mjs           # belt splits
python -m tests.stress                      # every scenario over a sloop/shard grid (a minute)
```

---

## Solver Inputs

A scenario may contain:

- Resource Nodes (map nodes, typed nodes or fixed rates) and extractor shards
- Imports From Other Factories
- Items Sent to Storage
- Objective Outputs
- Exact Production Targets
- Minimum Production Targets
- Maximum Production Targets
- Power Limits
- Alternate Recipe Selection
- Machine Availability

---

## Graph Controls

| Action | Control |
|----------|----------|
| Pan | Drag empty canvas |
| Zoom | Mouse wheel |
| Move node | Drag node |
| Expand node | Click node |
| Fit graph | Fit button |

---

## Roadmap

### Graph
- Improved coordinate assignment
- Focus mode
- Search-to-node
- Edge bundling
- Semantic clustering
- Minimap

### Solver
- Constraint-aware pruning
- Dependency closure reduction
- Sensitivity analysis
- Bottleneck diagnostics

### UX
- Scenario diffing
- Factory stages
- Power analysis dashboard
- Constraint conflict reporting

---

## Design Goals

- Lightweight
- No Electron
- No Node.js
- No Build Step
- Fully Local
- Fast Solve Times
- Large Factory Support
- Easy Modding

---

## Contributing

Issues, feature requests, and pull requests are welcome.

Please open an issue before making major architectural changes.

---

## License

MIT License

---

## Disclaimer

Satisfactory is developed by Coffee Stain Studios.

This project is an independent fan-made tool and is not affiliated with or endorsed by Coffee Stain Studios.