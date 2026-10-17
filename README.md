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
- When the goals can't all be met, it says why and what would work: what's
  short (e.g. "Not enough Caterium Ore: about 86/min more"), how much of each
  goal fits with the rest met, and alternates you haven't unlocked that would
  close the gap — each a one-click Apply that re-solves
- New alternates (the right panel's Alternates tab, after every solve): the best plan
  with every alternate you haven't unlocked, and the ones it uses in the
  order to unlock them — each with what solving with it changes on top of
  those above: output, and the resources and machine space of the plan a
  solve then makes (more output can take more space: shown as a cost). Tick the ones to use
  in this factory (untick the ones you don't want), then Solve with these —
  or Unlock ticked once you've found their hard drives: every factory has
  them, and it re-solves. Every alternate you've unlocked is in every solve
- Across all factories (under them): every alternate you haven't unlocked,
  ranked by what it adds to all your saved factories as they are, each on its
  own — more output (% of now), or fewer resources for the same. The first is
  the hard drive worth most across the lot
- Solver pruning (under the suggestions): how far the recipes are narrowed
  before solving — every recipe, allowed by your unlocks, makeable from your
  resources, on a path to your goals, into the solver (pointless loops
  dropped), in the plan — and how long the solve took
- Folded sidebar sections say what's in them (9 resources · 33 extractors;
  2 max · 4 exact · 5 at least · 5 stored)
- Weighted multi-item objectives
- Resources as nodes: pick the nodes a factory mines on the 1.0 world map (every
  node and resource-well satellite, with its purity), or type them in. Nodes one
  factory mines are crossed out for the others. Power shards on the extractors
  (0–3 each, +50% clock per shard) decide how much comes out; "Spread" puts a
  number of shards where they add the most. Water extractors are pins you drop where there's water. A fixed
  rate covers anything else
- Unused node supply: what a factory's own nodes give that its plan doesn't
  use is offered to the others. On the maps those nodes have a green ring;
  Leftover (beside the resources) shows every one of them, and zoomed in each
  says how much is left ("+230 unused"). Picking nodes, click the tag (or set
  an amount in "Unused nearby", nearest first) to bring some of it over as an
  import — the rest stays theirs. Its plan holds: what's sent on comes off
  its own supply
- Your save: read a .sav (Unlocks, or the map) to mark the nodes your
  game already mines (a yellow ring), on the map and on the Blackboard's Map
  tab, so you can plan which to take next. In your save (beside the
  resources) shows the ones no factory has yet — to rebuild factories planned
  before you used the map: picking nodes, "+ Add the N on screen" adds the
  ones in view (zoom to one site), or drag a box — and to see what it has unlocked (alternates,
  machines, miner and belt tiers) against the planner's; one click makes
  them match
- Picking nodes for a regional factory: drag a box round the region and every
  node shown inside it is picked (only the resources you've filtered to, when
  you have; none another factory mines); Shift+drag a box takes them out; a
  click picks one. Pan with the right button, Space+drag or the arrows
- The map is drawn on the game's own map picture (fetched once into data/ the
  first time you open a map — the in-game map from the open-source
  satisfactorymap project, lined up with the map's edges), or on your own
  picture (nudge it to line up). The picture is shown as tiles, like an online
  map — the whole map in one, then 2 × 2 and 4 × 4 — only those in view, at
  the sharpness the zoom needs, so it's there in a fraction of a second (the
  full 8192 × 8192 picture takes seconds to decode). The browser cuts them in
  the background the first time, level by level as each is ready, and they're
  kept in data/map_tiles/. From afar the nodes are dots; zoom in, or
  pick one or two resources, and each shows its purity (P / N / I); zoom in
  further for its name and who mines it. A factory that has nodes opens
  the map on them. Zoom with the wheel, + / −,
  double-click or the buttons; 0 shows the whole map; arrows pan
- Shared unlocks, for every factory: the machines, the miner tier, the best
  belt (for splits inside a factory), the tier and milestones reached
- Miners: a new factory uses the best unlocked; a saved one keeps the tier it's
  built with, so its supply and power stay true. When a better one's unlocked
  it says so — "26 miners are Mk.2 — Mk.3 gives +2,880 Iron Ore" in its
  resources, ⛏ Mk.2 in Your factories — and Upgrade rebuilds them
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
  imports, storage, alternates, power cap…); restore any from Your factories
- Grid alerts: Your factories says when the grid is short — on average or with
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
- Machine cap: the most it makes with at most so many machines (extractors
  aside) — the most on a budget; shards stretch it. Too few for an exact
  amount: it says so. Both caps get a What if slider
- Auto (by ▶ Solve, on unless you turn it off): a change that matters to the
  plan solves by itself a moment after you stop — not its name or notes; a
  change while one solves waits for it, then solves once more. It stays on
  the view you're in
- Power Shard placement optimised across the whole factory
- Somersloop placement optimised across the whole factory
- Power plants: Coal (coal, compacted coal, petroleum coke) and Fuel generators
  (fuel, turbofuel, rocket, ionized and liquid biofuel) and Nuclear plants make
  Power, in MW — a goal like any item, so a factory can be a power plant. A
  factory's own generators add to its power cap. Burning fuel rods
  yields Uranium/Plutonium waste, so full Plutonium and Ficsonium chains can be
  planned
- Last solve of each scenario cached and restored when the scenario is reopened

### Goal tree — what your resources can become
- Pick resources (on the map or typed in) and the Tree view in the middle
  (🌳 Goal tree in Goals, or T; ✕ Plan or Esc goes back) grows from them: each resource a root
  on the left, each step of processing a column to the right — branches meet
  where a recipe takes two of them and split where one part feeds many.
  Packing fluids is for moving them, so unpacking never shows and a packaged
  item only where a recipe takes it (Packaged Water for Diluted Packaged
  Fuel), a step after its fluid. A
  factory with no plan yet opens on it; solving switches to the plan
- ⟳ on a tile cycles its alternates (1/4 … 4/4, then none): the pick is
  offered to the solver — it uses it if it's better — and saved with the
  factory. Its popover lists every recipe that makes it (pick one there too)
  at the plan's rate, else its goal's, else one machine each — machines and
  parts, a part clicked goes to it — what it's used in, and your other
  factories with some free (or stored): Import
- After a solve the tree shows the plan: the rate each part's made at, the
  recipe the solver chose (✓ plan), the plan's links lit; parts it doesn't
  make fade. Alternates worth unlocking show as ✨ on the parts they'd change —
  click one to pick it
- Click a tile to set its goals — several at once: maximize it (with a
  weight) and keep at least some (a floor, so the weights can't trade it away
  to nothing) or at most some; or exactly so much, on its own — and how much
  of it to store; the goals and storage
  on the left fill in, and the tile wears a badge (max ×2, ≥10, 5–20, 📦2)
- The tree's bar counts what you can make and how many more alternates would
  bring in reach (click it: they show, faded)
- What's next adds, faded, what you can't make yet — from resources you
  don't have, or a milestone not done. Hover one to see it; it stays out of
  the fit. Click it: the alternates that get it from what you have ("Use
  them"), and what to bring in for the amount in its goal (one machine's
  until you set one) — the solver's answer: the
  parts you can't make and resources you're short of, never what's only found
  — with where to get each (a saved factory with some left, nodes on the map,
  or a fixed supply), and the milestone or machine it waits on ("I've done it"). Accept one and it's in your
  resources; the tree grows, and once the part is in reach its goal editor
  opens. Hovering a tile lights up what it's made from and what it makes

### Progress — tier, sub-tiers and MAM research
- In Unlocks: the tier you've reached (0–9), its sub-tiers (milestones) to
  tick (each named for the machine it gives you, or what it makes: Refinery,
  Manufacturer, Motor · Stator +2), and MAM research by tree, each chip saying what it lets you make
  (Quickwire, Silica, Hog Protein, Blue Shard…) — or All, everything. Picking a tier counts
  every sub-tier below it done; the machines follow. Read a save and it says
  which it has done; one click makes them match
- Solves use only the recipes they unlock (alternates still come from hard
  drives); the goal tree grows to match. Which milestone or research unlocks
  each recipe and machine is in data/game.json, built by
  python supply.py unlocks from SatisfactoryTools' open 1.0 game data

### Layout — by how often you go there
- Left: what goes in — resources, goals, solve settings, notes; Solve and
  Save at the bottom. `[` folds it away
- Middle: the production graph, with the results bar: power use (what the
  machines and extractors draw — what it takes to start it), the goals (a
  power plant's as power made), machines, space, shards, sloops, the ceiling
- Right panel, for reviewing and improving the plan: Analysis (what limits
  the plan), Alternates (new ones worth unlocking, and the solver's pruning),
  Build cost (one list of machines and extractors, then the materials — add any
  other saved factories or the grid's geothermal to one list — then the build
  sheet) and Issues. Its rail shows a
  count on each; a click or 1 / 2 / 3 / 4 opens one, again closes it; the
  wheel over the rail steps through them; `]` opens or closes the panel.
  Issues opens by itself when a solve falls short
- Your factories (Ctrl+O): each card shows what it makes for its goals, its
  power, and whether its plan is current, out of date or short. 💎 Shards &
  sloops shares out the ones you have across every factory: sloops where they
  raise a goal the most (as a share of it), shards where they save the most
  machine space — measured with machines in fractions, where that split is
  the best — then writes them in and re-solves them
- Far off, for what you rarely change: Your factories (the name in the top
  bar, or Ctrl+O — open, new, history, backups) and Unlocks (Ctrl+U —
  machines, miner, the alternates you've unlocked in the game, read a save),
  which are the same for every factory
- The Blackboard for planning factories together

### From plan to building
- What if (Analysis): a slider for each resource and each fixed goal — drag
  one and the goal follows as you drag (a fast solve with machines in
  fractions); Use it puts the number in the factory and solves
- Floor plan (📐 on the build sheet): each line's machines at their real
  footprint, rows folding past 120 m with belt lanes between, the size and
  the 8 m foundations it takes — a guide to the room, not a layout. Give it a
  footprint (foundations across × deep) and it folds rows to the width and
  stacks floors past the depth, each as high as its tallest machine plus a
  belt layer, with a lift wherever a line takes from a line on another floor
- Built, from your save: reading a .sav also reads every machine in it (what
  it runs, where it stands) and what your storage containers and dimensional
  depot hold. Each machine counts toward the nearest saved factory (by its
  nodes) that runs its recipe, no line past what it needs; extractors are
  built where the save mines the nodes. The build sheet marks each line ✓, 3/8
  or to build, the machine list says how many are left, and What's left
  everywhere lists every saved factory's unbuilt lines and extractors with the
  materials for all of it against what your storage holds
- Build sheet (Build cost, under the materials): every line the plan runs,
  in the order you'd build it — its machines and clock (the even clock the
  plan uses, the least power, or all but one at 100%, the easiest to set),
  what goes in and out and the belt or pipe each needs at your tier (or how
  many). ⑂ on an input says how the belt reaches the machines: a manifold
  (easiest — a splitter in front of each, they fill up), or a balancer as a
  split that repeats ("split 2 ways, four times over: 1 → 2 → 4 → 8 → 16
  belts of 30/min, one per Smelter"), with the loop-back merger when the
  count needs one, per belt when it takes several; Draw it shows the drawing
  in its own window. The lines go into Copy as a list too
- Limits point at fixes: in Analysis, a resource that limits the plan lists
  the nearest free nodes of it (no other factory mines them) — how far from
  this factory's nodes, what each gives at your miner, and about how much
  more of your goal that is (its shadow price, up to where it stops helping).
  Add & solve takes one and solves again
- Before saving: if this plan leaves a factory that takes from it short, it
  says so by Save — who, of what, how much — with Save and re-solve them (this
  one, then every factory that takes from it, in order); and if it puts the
  grid short (your saved factories' power with this plan in its place)
- Undo: Ctrl+Z steps back through this factory's edits (goals, resources,
  imports, storage, picks on the tree or the map, settings), Ctrl+Shift+Z or
  Ctrl+Y forward; opening another factory starts afresh. Solving isn't undone

### Getting around
- Go to anything (Ctrl+K or /): a system, a saved factory, an action (solve,
  save, back up, plan the network…), or an item across your factories
- The systems in a ring — the planner, then each Blackboard tab: Alt+← / Alt+→
  (or Ctrl+PgUp / PgDn, or the wheel over the top bar or the Blackboard's
  tabs) steps through them, Alt+1 … Alt+6 jumps to one; a strip shows where
  you are
- Alt+↑ / Alt+↓ opens the previous / next saved factory
- 1 / 2 / 3 / 4 the right panel's tabs, Ctrl+O your factories, Ctrl+U unlocks,
  Ctrl+M pick on the map, Ctrl+I analysis, Esc closes what's on top;
  ? shows every shortcut
- Typing in the lists (resources, imports, goals, storage): Enter goes item →
  its amount → the next row, and after the last a new one; Backspace in an
  empty row takes it away. In the single boxes Enter goes to the next
- Unsaved changes: a dot on the factory's name in the top bar and on Save;
  opening another factory or starting a new one asks first

### Blackboard (logistics)
- Between factories: every saved scenario is a black box showing only what it
  imports and exports (from its last plan), where its imports come from and
  how much of each output others take. "From factories" imports are drawn as
  routes on their own — one band per route, a stripe per item in it, each as
  wide as its rate. Join factories with routes — train,
  truck, tractor or drone, each with its round trip time (belts and pipes stay
  inside factories) — and plan the network: which recipe runs where, what
  crosses each route (items, stacks, and the freight cars, trucks, tractors or
  drones it keeps busy: a freight car holds 32 stacks or 1,600 m³ in a fluid
  car, a truck 48, a tractor 25, a drone 9; fluids by road or air go packaged —
  one round trip carries a load each way, so a route keeps busy what its
  heavier way needs, and what comes back rides along): a train of so many
  freight and fluid cars with a platform per car at each end, so many trucks
  or tractors with a station at each end, or drones — a port pair each, and
  about how many batteries a minute (24,000 MJ a trip plus 12 MJ a metre
  between the factories, an estimate; the port's own readout is exact),
  what each factory draws, and how much more each goal the leftovers could make.
  Least resources first, then least transport, then least change from each
  factory's own plan, then least space. Click a factory to open it.
  ⇧ Grow all goals plans them together instead of holding today's outputs:
  the largest share every goal can rise by at once (none traded for another),
  then the most of each on top, then least resources and transport as above —
  each factory's goal from now to then. Apply writes it in like any plan.
- ⚖ Compare trades: "bring Quickwire in for the computers, or send the Plastic
  over?" — every item one factory on a route could send the other that its
  plan makes or uses today, each tried on its own on top of what they already
  send: how much more of each goal it gives (every goal kept at least where it
  is anyway — none is bought by cutting another), what it frees with the goals
  held where they are, and the trains, trucks or drones it takes. Ranked best
  first; All of them together is the network plan; Apply writes one into the
  factories' imports and re-solves them. "+ free nodes within N km" counts the
  free nodes that close to each factory as more it could mine — and says which
  it would, per factory
- Heavy routes: past one train (8 cars), 6 trucks or tractors, or 4 drones,
  a route's load turns amber — the vehicles counted for the imports you set
  too, before any network plan — saying what most of it is and, when the
  factory it goes to turns it into something lighter, to do that step at the
  sending end instead (about how much less to carry)
- Flows: a Sankey of everything moving between factories and into storage —
  as set in each factory, or as the network plan would send it; one band per
  pair of factories, its items as stripes inside it.
- Power: what each factory's machines and extractors draw and its generators
  make, the power grid's geothermal, the grid's balance — on average and with
  every geyser at its low (½×) and its high (1½×) — and which factories their
  cap holds back.
- Map: the network on the game map — each factory where its nodes are, each
  route between them (trains with ties, trucks and tractors dashed, drones
  bowed) as thick as what it carries, labelled with the vehicles the network
  plan needs; click a factory to open it. Whose nodes are whose, what your save already mines, the pure nodes
  still free. ⚡ Geothermal: click geysers to put a geothermal generator on
  them for the power grid (100 / 200 / 400 MW by purity), or add the ones your
  save has. Geysers belong to the grid, not to a factory.
- Items: with nothing typed, everything stored or moved between factories;
  type an item — every factory that makes it, what it sends out, who takes
  it, what's stored, what's still free to import, and what's made and used up
  inside a factory. Change a stored amount there and that factory is saved
  with it (the open one follows).
- Imports and storage share one pool: importing more than a factory has free
  takes the rest out of its storage — saving moves it, and that factory is
  saved with less stored. What it makes doesn't change; it goes to you instead.
- Apply a network plan: what it sends between factories becomes their imports,
  the alternates it uses are switched on, then they're re-solved in order. A
  factory's own goals are always made in it.

### Recipe Management
- Recipe data checked against the 1.0 game files (rates, machines, build costs,
  per-recipe power for variable-power machines)
- Enable/disable alternate recipes
- Enable/disable machine tiers
- Find a part (Ctrl+Q, or the box in the top bar): it opens on the goal tree
  with its popover — every recipe that makes it, what it's used in.
  Sums work: 240*2/3 is worked out
- Belts in the same box: `4 x 120 into 5 x 80 + 40 + 20 + 20` draws the
  splitters and mergers that give every output exactly its rate — each belt
  feeds a few outputs (the ways of sharing them out are searched, and merging
  them all first), the fewest structures win; spare streams loop back
  (dashed), what's left over leaves on its own belt, and a belt over your tier
  shows red. `into`, `to`, `->` or `>`; `n x rate` for n belts; sums work;
  Enter (or a click on the drawing) shows it large
- Scenario-based planning

### Interactive Graph
- Automatic DAG layout generation
- Pan and zoom
- Node dragging
- Expandable recipe details
- Flow-rate visualization
- Source, sink, surplus, and error tracking
- Every item has one colour, the same everywhere (graph links, tree tiles and
  links, the build sheet, split drawings, the Blackboard's bands)
- A link near what one belt at your tier carries glows amber, one over it
  red, as do the links out of a resource the plan uses all of. Nothing
  animates: the graph only draws when something changes
- Colour by (◐ or C): the machines by machine, power draw, clock (under,
  100%, over), space, or alternate vs standard — with a key
- 📌 Pin (or P) on the results bar keeps the plan; every solve after shows
  under each number how it moved (green better, amber worse), and Compare
  lays the two side by side — goals, power, machines, space, each resource,
  machines by kind, the recipes only one runs — with Back to the pinned
  (undoable)

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
├── supply.py             nodes, extractors, shards, imports → supply; shared unlocks;
│                         a game save (nodes mined, unlocks, machines built, storage);
│                         python supply.py unlocks <data1.0.json> rebuilds the unlocks
├── network.py            several factories together: each from outside (what it takes
│                         in and sends out), and planning them as one network
├── index.html            the page (and its styles)
├── frontend/
│   ├── main.js           wiring, solve (and solving by itself), save/open, undo
│   ├── state.js          shared state, every call to the server, the map's nodes
│   ├── nav.js            getting around (go to anything, the systems, shortcuts),
│   │                     the right panel; loads the Blackboard when it first opens
│   ├── sidebar.js        the left panel: goals, constraints, the supply
│   ├── ui.js             results bar, build cost and the build sheet (lines, clocks,
│   │                     belts, splits, floors), Analysis (limits, what-if sliders),
│   │                     saved factories, comparing two plans, the re-solve chain
│   ├── unlocks.js        Unlocks, the Alternates tab, reading a save
│   ├── goal-tree.js      the Tree view: what your resources can become, goals on it
│   ├── graph.js          the production graph
│   ├── geometry.js       belt splits, and the bands between factories
│   └── blackboard.js     logistics between factories, and the world map (picking
│                         nodes, the Blackboard's map) — loaded when first opened
├── data/
│   ├── recipes_complete.yaml   recipes and machines (1.0)
│   ├── game.json               the map (every node, well satellite and geyser), the
│   │                           game's class names for reading saves, and what
│   │                           milestone or MAM research unlocks each recipe and machine
│   └── unlocked_alts.yaml      your unlocked alternates
│   (yours, not in git: progress.yaml, blackboard.yaml, save_nodes.json, map_image.*,
│    map_game.avif, the game's map, fetched once, and map_tiles/, cut from it)
├── scenarios/            your factories (.results: cached plans; .history: earlier versions)
├── backups/              your backups (git-ignored)
└── tests/                test_*.py (python), geometry.test.mjs (node), e2e.mjs (browser)
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
python -m unittest discover -s tests -t .   # server, supply, solver (seconds)
node --test tests/*.test.mjs                # belt splits, the Blackboard's bands
node tests/e2e.mjs                          # every browser section, a few at once (needs Playwright)
node tests/e2e.mjs tree build               # just those sections: sidebar, blackboard, nav, spare,
                                            # typing, infeasible, newalts, tree, build, improve
python -m tests.stress                      # every scenario over a sloop/shard grid, a case per core
python -m tests.stress -j 1                 # one at a time, for per-case times
```

The browser tests run the planner on a throwaway folder (each section its own);
your scenarios, plans and unlocks are never touched.

---

## Solver Inputs

A scenario may contain:

- Resource Nodes (picked on the map, typed in, or fixed rates), extractor shards
- Imports From Other Factories
- Items Sent to Storage (under the goals: taken out of what it makes, so it makes at least that)
- Objective Outputs (weighted; Power in MW for a power plant)
- Exact, Minimum and Maximum Production Targets
- Power Shards and Somersloops for its machines (Dive or Exact placement)
- A Power Cap (its own generators add to it)
- Alternate Recipes (and Min New Alts: the fewest you haven't unlocked)
- Least machine space first instead of least resources (Min Machines)

Unlocked machines, the miner tier and the best belt are shared by
every factory (Unlocks, Ctrl+U — or read them from a save).

---

## Graph Controls

| Action | Control |
|----------|----------|
| Pan | Drag empty canvas |
| Zoom | Mouse wheel |
| Move node | Drag node |
| Expand node | Click node |
| Fit graph | Fit button |
| Search the graph | Ctrl+F |

---

## Roadmap

- Region names on the map
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