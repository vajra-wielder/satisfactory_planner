"""
Satisfactory Factory Planner — Desktop Launcher
================================================
Starts the HTTP server in a background thread then opens a native
desktop window via pywebview. No browser, no Node, no Flask.

Usage:
    python app.py           # default port 5000
    python app.py 5001      # custom port

Dependencies (install once):
    pip install -r requirements.txt
"""

import sys
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

# Ensure we can import server/solver from the same directory regardless of
# the working directory the user launches from.
sys.path.insert(0, str(Path(__file__).parent))

import server as srv


def _start_server(port: int) -> None:
    httpd = ThreadingHTTPServer(("127.0.0.1", port), srv.Handler)
    print(f"   Server ready on http://127.0.0.1:{port}/")
    httpd.serve_forever()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000

    thread = threading.Thread(target=_start_server, args=(port,), daemon=True)
    thread.start()

    # Give the server a moment to bind and finish loading recipes.
    time.sleep(1.2)

    try:
        import webview
    except ImportError:
        print("\n⚠  pywebview not installed.")
        print("   Run:  pip install pywebview")
        print(f"   Then open  http://127.0.0.1:{port}/  in your browser.\n")
        # Keep the server alive so the user can use a browser instead.
        try:
            while True:
                time.sleep(60)
        except KeyboardInterrupt:
            print("Stopped.")
        return

    window = webview.create_window(
        title     = "Satisfactory Factory Planner",
        url       = f"http://127.0.0.1:{port}/",
        width     = 1440,
        height    = 900,
        resizable = True,
        min_size  = (920, 620),
    )
    webview.start(debug=False)


if __name__ == "__main__":
    main()
