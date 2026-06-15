"""
Satisfactory Factory Planner — Desktop Launcher
================================================
Starts the HTTP server in a background thread then opens a native
desktop window via pywebview. No browser, no Node, no Flask.

Usage:
    run.bat             # normal launch — no console window
    python app.py       # launch with console (for debugging)
    python app.py 5001  # custom port

All output is written to planner.log in the project folder.
Click the 📋 button inside the app to view logs without a terminal.
"""

import sys
import threading
import time
import os
from http.server import ThreadingHTTPServer
from pathlib import Path

HERE     = Path(__file__).parent
LOG_PATH = HERE / "planner.log"

sys.path.insert(0, str(HERE))

# ── Safe log redirect ─────────────────────────────────────────────────────────
# pythonw.exe has no stdout/stderr at all — any write raises an error.
# We redirect both to a file, and also mirror to the real stdout/stderr
# if they exist (i.e. when launched via python.exe with a console).

class _Logger:
    def __init__(self, path):
        self._file = open(path, "w", buffering=1, encoding="utf-8")

    def write(self, data):
        try:
            self._file.write(data)
        except Exception:
            pass

    def flush(self):
        try:
            self._file.flush()
        except Exception:
            pass

    def fileno(self):
        return self._file.fileno()

    def read_all(self):
        try:
            self._file.flush()
            return LOG_PATH.read_text(encoding="utf-8")
        except Exception:
            return ""

_logger = _Logger(LOG_PATH)

# Mirror to real stdout/stderr only if they are valid (python.exe, not pythonw.exe)
class _Tee:
    def __init__(self, log, real):
        self._log  = log
        self._real = real

    def write(self, data):
        self._log.write(data)
        if self._real is not None:
            try:
                self._real.write(data)
            except Exception:
                pass

    def flush(self):
        self._log.flush()
        if self._real is not None:
            try:
                self._real.flush()
            except Exception:
                pass

    def fileno(self):
        return self._log.fileno()

def _is_valid_stream(s):
    """Return True if s is a real writable stream (not None, not closed, has a valid fd)."""
    if s is None:
        return False
    try:
        return s.fileno() >= 0
    except Exception:
        return False

_real_out = sys.stdout if _is_valid_stream(sys.stdout) else None
_real_err = sys.stderr if _is_valid_stream(sys.stderr) else None

sys.stdout = _Tee(_logger, _real_out)
sys.stderr = _Tee(_logger, _real_err)

# ── Server ────────────────────────────────────────────────────────────────────

import server as srv

def _patch_log_endpoint():
    """Add GET /api/log to the existing server handler."""
    _orig_get = srv.Handler.do_GET

    def do_GET(self):
        from urllib.parse import urlparse
        if urlparse(self.path).path.rstrip("/") == "/api/log":
            text = _logger.read_all()
            body = text.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return
        _orig_get(self)

    srv.Handler.do_GET = do_GET

def _start_server(port):
    _patch_log_endpoint()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), srv.Handler)
    print(f"Server ready on http://127.0.0.1:{port}/")
    httpd.serve_forever()


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000

    thread = threading.Thread(target=_start_server, args=(port,), daemon=True)
    thread.start()

    time.sleep(1.2)

    try:
        import webview
    except ImportError:
        print("pywebview not installed. Run: pip install pywebview")
        print(f"Then open http://127.0.0.1:{port}/ in your browser.")
        try:
            while True:
                time.sleep(60)
        except KeyboardInterrupt:
            pass
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
