"""
Satisfactory Factory Planner — Standalone App Launcher
=======================================================
Starts the HTTP server in a background thread then opens a native
desktop window via pywebview. No browser, no Node, no Flask.

Requirements (once):
    pip install pywebview ortools pyyaml

Run:
    python app.py
    python app.py 5001   # custom port
"""

import sys, threading, time
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5000

# ── Start server in daemon thread ─────────────────────────────────────────────
def _run_server():
    # Import server module; its module-level code does the startup work
    # (copies yaml, imports solver, pre-loads recipes) then we create HTTPServer.
    from http.server import HTTPServer
    import server as srv
    httpd = HTTPServer(("127.0.0.1", PORT), srv.Handler)
    print(f"   Server ready on http://127.0.0.1:{PORT}/")
    httpd.serve_forever()

t = threading.Thread(target=_run_server, daemon=True)
t.start()

# Give the server a moment to bind and load recipes
time.sleep(1.2)

# ── Open native window ────────────────────────────────────────────────────────
try:
    import webview
except ImportError:
    print("\n⚠  pywebview not installed.")
    print("   Run:  pip install pywebview")
    print(f"   Then open  http://127.0.0.1:{PORT}/  in your browser.\n")
    # Keep server alive so user can still use the browser
    try:
        while True: time.sleep(60)
    except KeyboardInterrupt:
        print("Stopped.")
    sys.exit(0)

window = webview.create_window(
    title    = "Satisfactory Factory Planner",
    url      = f"http://127.0.0.1:{PORT}/",
    width    = 1440,
    height   = 900,
    resizable = True,
    min_size  = (920, 620),
)

webview.start(debug=False)
