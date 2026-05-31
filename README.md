# Satisfactory Factory Planner — Lite

Single-process local desktop app. No Node, no npm, no Flask, no Electron.
One Python process serves the UI and runs the OR-Tools LP solver.

---

## Project layout

```
sfplanner_lite/
├── app.py                  ← Launch this (opens native window via pywebview)
├── server.py               ← Stdlib HTTP server — handles /api/* + serves frontend/
├── solver.py               ← OR-Tools LP solver (copy from your original backend)
├── recipes_complete.yaml   ← Canonical recipe data — edit this one
├── data/                   ← Auto-created on startup; server copies yaml here for solver
│   └── recipes_complete.yaml
├── scenarios/              ← Auto-created on first Save; your saved .yaml files live here
│
├── index.html              ← Thin HTML shell — imports CSS/JS, zero embedded data
└── frontend/
    ├── style.css           ← All visual styles and CSS variables
    ├── state.js            ← Shared mutable state (SC, RESULT, ALL_ITEMS, RECIPES, …)
    ├── api.js              ← All fetch calls to the server (/api/items, /api/recipes, …)
    ├── sidebar.js          ← Sidebar panels: KV editors, machines, alternates,
    │                          recipe lookup, saved scenarios, topbar, warnings modal
    └── graph.js            ← Canvas DAG renderer: layout, pan/zoom, node drag,
                               click-to-expand, edge labels with actual flow rates
```

---

## Setup

```bash
# 1. Install Python dependencies (once)
pip install ortools pyyaml pywebview

# 2. Copy solver.py from your original backend into this directory
cp /path/to/your/original/solver.py .

# 3. Launch
python app.py
```

`app.py` starts the server on port 5000 (pass a different port as `python app.py 5001`)
then opens a native desktop window. The server also stays accessible in a browser
at http://127.0.0.1:5000/ if you prefer that.

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/items` | Sorted list of all item keys; `?q=iron` for search |
| GET | `/api/recipes` | All recipes: `{key: {display, machine, alternate, inputs, outputs}}` |
| GET | `/api/item-display` | Map of `item_key → "Human Name"` |
| GET | `/api/scenarios` | List of saved scenario metadata |
| GET | `/api/scenarios/<name>` | Load a scenario YAML |
| POST | `/api/scenarios/<name>` | Save a scenario |
| DELETE | `/api/scenarios/<name>` | Delete a scenario |
| POST | `/api/solve-inline` | Submit scenario JSON → get solver result |

---

## Editing

- **Recipes** — edit `recipes_complete.yaml` directly. Server copies it to `data/` on
  next startup, so just restart `app.py` to pick up changes.
- **Styles** — edit `frontend/style.css`. Reload the window (Ctrl+R) to apply.
- **Graph behaviour** — edit `frontend/graph.js`.
- **Sidebar panels** — edit `frontend/sidebar.js`.
- **Shared state / data model** — edit `frontend/state.js`.
- **Server routes** — edit `server.py`.

No build step. All JS is vanilla ES modules, served directly.

---

## Graph controls

| Action | How |
|--------|-----|
| Pan | Click-drag on empty canvas |
| Zoom | Scroll wheel, or +/− buttons |
| Fit view | ⊡ button (bottom-left) |
| Move a node | Click-drag the node |
| Expand node detail (layout options) | Click the node (single click, no drag) |
| Collapse | Click the expanded node again |
