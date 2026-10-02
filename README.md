# Satisfactory Factory Planner

A lightweight, standalone production planner for **Satisfactory** built with **Python, OR-Tools, and vanilla JavaScript**.

Unlike most web-based planners, this project uses a real optimization solver to generate factory layouts and production chains subject to resource, power, machine, and recipe constraints.

---

## Features

### Factory Optimization
- Exact mixed-integer solver (OR-Tools + SCIP), proven optimal
- Every plan against its fractional ceiling — the goal with machines, shards and
  somersloops in fractions, which no buildable plan can pass — shown in the
  results bar
- Weighted multi-item objectives
- Resources as nodes: pick the nodes a factory mines on the 1.0 world map (every
  node and resource-well satellite, with its purity), or type them in. Nodes one
  factory mines are crossed out for the others. Power shards on the extractors
  (0–3 each, +50% clock per shard) decide how much comes out; "Spread" puts a
  number of shards where they add the most. Water extractors are pins you drop where there's water. A fixed
  rate covers anything else
- Your save: read a .sav (Machines & Alts, or the map) to mark the nodes your
  game already mines, on the map and on the Blackboard's Map tab, so you can
  plan which to take next — and to see what it has unlocked (alternates,
  machines, miner, belt and pipe tiers) against the planner's; one click makes
  them match. Load a picture of the in-game map to draw the nodes on (nudge it
  to line up)
- Shared unlocks, for every factory: the machines, the miner tier (miners always
  run at it), the best belt and pipe
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
- History: each save that changes a factory keeps the version it replaces —
  the 5 latest changes, plus up to 5 you confirm (kept until you unconfirm
  them). Each version says what restoring it would change (goals, supply,
  imports, storage, alternates, power cap…); restore any from the Saved tab
- Grid alerts: the Saved tab says when the grid is short — on average or with
  every geyser at its low — and which factories draw more than in their plan
  before
- Backups: one zip of everything that's yours (factories, their history and
  plans, the Blackboard, unlocks, your save's nodes, your map picture), kept in
  backups/; restore one from there or from a zip (what's there is backed up
  first)
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
  factory's own generators add to its power cap. Burning fuel rods
  yields Uranium/Plutonium waste, so full Plutonium and Ficsonium chains can be
  planned
- Last solve of each scenario cached and restored when the scenario is reopened

### Blackboard (logistics)
- Between factories: every saved scenario is a black box showing only what it
  imports and exports (from its last plan), where its imports come from and
  how much of each output others take. "From factories" imports are drawn as
  routes on their own — one band per route, a stripe per item in it, each as
  wide as its rate. Join factories with routes (belt,
  train, truck or drone, with trip times) and plan the network: which recipe
  runs where, what crosses each route (items, stacks and cars / drones / lanes),
  what each factory draws, and how much more each goal the leftovers could make.
  Least resources first, then least transport, then least change from each
  factory's own plan, then least space. Click a factory to open it.
- Flows: a Sankey of everything moving between factories and into storage —
  as set in each factory, or as the network plan would send it; one band per
  pair of factories, its items as stripes inside it.
- Storage: every item sent to storage, per minute and per hour, by factory.
- Power: what each factory's machines and extractors draw and its generators
  make, the power grid's geothermal, the grid's balance — on average and with
  every geyser at its low (½×) and its high (1½×) — and which factories their
  cap holds back.
- Build list: the machines (extractors and generators too) and the materials to
  build them, per factory or for any you pick (the grid's geothermal
  generators too) — no belts, pipes or stations.
- Map: whose nodes are whose, what your save already mines, the pure nodes
  still free. ⚡ Geothermal: click geysers to put a geothermal generator on
  them for the power grid (100 / 200 / 400 MW by purity), or add the ones your
  save has. Geysers belong to the grid, not to a factory.
- Who makes: type an item — every factory that makes it, what it sends out,
  who takes it, what's stored, what's still free to import, and what's made
  and used up inside a factory.
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
├── app.py                desktop window (pywebview) around the server
├── server.py             HTTP server and API: scenarios, solves, plan cache, claims,
│                         owed outputs, re-solve chain, history, save files, Blackboard
├── solver.py             the optimiser (OR-Tools: SCIP + GLOP)
├── supply.py             nodes, extractors, shards, imports → supply; shared unlocks
├── network.py            planning several factories together
├── logistics.py          what each factory takes in and sends out
├── savefile.py           what a game save mines and has unlocked
├── index.html            the page (and its styles)
├── frontend/
│   ├── main.js           wiring, solve, save/open
│   ├── sidebar.js        sidebar shell, autocomplete
│   ├── supply-panel.js   resources, imports, storage, sent out
│   ├── kv-panel.js       goals
│   ├── machines-panel.js unlocked machines, miner tier, alternates
│   ├── map-picker.js     the world map: picking nodes, the Blackboard map
│   ├── save-import.js    reading a save
│   ├── graph.js          the production graph
│   ├── analysis.js       factory analysis
│   ├── blackboard.js     logistics between and inside factories
│   ├── bundles.js        bands between factories (geometry)
│   ├── splits.js         belt splits (geometry)
│   ├── chain.js          re-solving factories in order
│   └── ui.js, state.js, api.js, recipe-lookup.js
├── data/
│   ├── recipes_complete.yaml   recipes and machines (1.0)
│   ├── map_nodes.json          every resource node, well satellite and geyser
│   ├── game_classes.json       game class names, for reading saves
│   └── unlocked_alts.yaml      your unlocked alternates
│   (yours, not in git: progress.yaml, blackboard.yaml, save_nodes.json, map_image.*)
├── scenarios/            your factories (.results: cached plans; .history: earlier versions)
├── backups/              your backups (git-ignored)
└── tests/
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
pip install -r requirements.txt     # ortools, PyYAML, pywebview (pywebview only for the desktop window)
```

### Run

```bash
python app.py          # native desktop window (on Windows, Planner.bat does this without a console)
python server.py       # or in your browser, at http://127.0.0.1:5000
```

---

## Tests

```bash
python -m unittest discover -s tests -t .   # supply, claims, owed, chain, Blackboard, API, solver (seconds)
node --test tests/*.test.mjs                # belt splits, Blackboard bands
node tests/sidebar.e2e.mjs                  # every input saved and reloaded, the outputs (browser; needs Playwright)
node tests/blackboard.e2e.mjs               # every Blackboard tab (browser; needs Playwright)
python -m tests.stress                      # every scenario over a sloop/shard grid, a case per core
python -m tests.stress -j 1                 # one at a time, for per-case times
```

The browser tests run the planner on a throwaway folder (tests/serve_temp.py);
your scenarios, plans and unlocks are never touched.

---

## Solver Inputs

A scenario may contain:

- Resource Nodes (picked on the map, typed in, or fixed rates), extractor shards
- Imports From Other Factories
- Items Sent to Storage
- Objective Outputs (weighted; Power in MW for a power plant)
- Exact, Minimum and Maximum Production Targets
- Power Shards and Somersloops for its machines (Dive or Exact placement)
- A Power Cap (its own generators add to it)
- Alternate Recipes (and Min New Alts: the fewest you haven't unlocked)
- Least machine space first instead of least resources (Min Machines)

Unlocked machines, the miner tier and the best belt and pipe are shared by
every factory (Machines & Alts — or read them from a save).

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

- Region names on the map (it has nodes, wells and geysers, and takes your own map picture)
- Station and platform counts per route (needs your trip times)
- Biomass burners

---

## Design Goals

- Lightweight
- No Electron
- No Node.js to run (the browser tests use it)
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