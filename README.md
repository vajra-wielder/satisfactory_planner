# Satisfactory Factory Planner

A lightweight, standalone production planner for **Satisfactory** built with **Python, OR-Tools, and vanilla JavaScript**.

Unlike most web-based planners, this project uses a real optimization solver to generate factory layouts and production chains subject to resource, power, machine, and recipe constraints.

---

## Features

### Factory Optimization
- OR-Tools linear programming solver
- Weighted multi-item objectives
- Resource constraints
- Production minimums, maximums, and exact requirements
- Machine count limits
- Power consumption limits
- Power Shard support
- Somersloop support

### Recipe Management
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

## Solver Inputs

A scenario may contain:

- Available Resources
- Objective Outputs
- Exact Production Targets
- Minimum Production Targets
- Maximum Production Targets
- Power Limits
- Machine Limits
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