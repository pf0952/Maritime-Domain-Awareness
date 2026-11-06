"""Starts ENC 3D and opens it in a window of its own, like an app: no address bar, no tabs, no port to know.

start.bat runs this, with no console of its own. If ENC 3D is already running, it just opens another window onto it.
If not, it starts the server on the first free port from 8000 (another app may have 8000) and opens the window once
the server answers. The window is Edge's app mode, at enc3d.localhost, which Edge and Chrome take to be this computer
without any setup; with no Edge, it opens in the default browser instead.

The server stops by itself once the last window is closed: each tells it every ALIVE seconds that it's open, and says
goodbye as it closes. A refresh says goodbye too, then hello again, so it waits GRACE seconds before taking a goodbye
at its word. What it would have printed goes to enc/server.log.

  python backend/launch.py [--no-window] [--port N] [--stay]   (--stay: run on with no window open)"""
import json
import logging
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

PORTS = range(8000, 8020)
HOST = "enc3d.localhost"
EDGE = [Path(os.environ.get(v, ""), r"Microsoft\Edge\Application\msedge.exe") for v in ("ProgramFiles(x86)", "ProgramFiles", "LocalAppData")]
LOG = Path(__file__).parent.parent / "enc" / "server.log"
ALIVE = 10  # s: how often an open window says so (frontend/src/App.jsx)
GRACE = 8  # s after a goodbye, for a refresh to say hello again
LOG_MOST = 5_000_000  # bytes: a bigger log is set aside when the app starts
SHUTDOWN = 5  # s for requests still running to finish, once stopping
QUIET = 45  # s with no word from any window: it was closed without a goodbye, or the computer slept


def ours(port: int) -> bool:
    """Is ENC 3D's server on this port? Its status answer says so; another app's won't."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=2) as res:
            return "charts" in json.load(res)
    except (OSError, ValueError):
        return False


def free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def open_window(port: int) -> None:
    url = f"http://{HOST}:{port}"
    edge = next((p for p in EDGE if p.is_file()), None)
    if edge:
        # (the user's own Edge, as it is: its settings and sign-ins are theirs)
        subprocess.Popen([str(edge), f"--app={url}"])
    else:
        webbrowser.open(url)
    print(f"ENC 3D is open at {url}", flush=True)


def watch(windows: dict, server) -> None:
    """Stops the server once no window is left: after a goodbye no hello followed, or none has been heard of a while.
    Not before the first window has said hello, so a slow start doesn't count."""
    while not server.should_exit:
        time.sleep(2)
        alive, bye = windows["alive"], windows["bye"]
        if alive is None:
            continue
        now = time.time()
        closed = bye is not None and bye >= alive and now - bye > GRACE
        if closed or now - alive > QUIET:
            print("The last window was closed: stopping", flush=True)
            server.should_exit = True


def main() -> None:
    args = sys.argv[1:]
    window = "--no-window" not in args
    asked = int(args[args.index("--port") + 1]) if "--port" in args else None
    if sys.stdout is None:  # (started with no console: pythonw)
        LOG.parent.mkdir(parents=True, exist_ok=True)
        if LOG.exists() and LOG.stat().st_size > LOG_MOST:  # (the last one kept, the rest let go)
            LOG.replace(LOG.with_suffix(".old.log"))
        sys.stdout = sys.stderr = open(LOG, "a", encoding="utf-8", buffering=1)
    # the server's own messages, with when: a thread that failed in the night says so with its time
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    running = next((p for p in ([asked] if asked else PORTS) if ours(p)), None)
    if running:
        print(f"ENC 3D is already running, on port {running}", flush=True)
        if window:
            open_window(running)
        return
    port = asked or next(p for p in PORTS if free(p))

    def when_ready():
        for _ in range(600):
            if ours(port):
                if window:
                    open_window(port)
                return
            time.sleep(0.5)

    threading.Thread(target=when_ready, daemon=True).start()
    print(f"Starting ENC 3D on port {port}, {time.strftime('%Y-%m-%d %H:%M')}", flush=True)
    import uvicorn

    sys.path.insert(0, str(Path(__file__).parent))
    import main as server_app

    # (a request still running when the last window goes, from a window that was killed say, would hold the shutdown up
    # for ever: it's given a few seconds)
    server = uvicorn.Server(uvicorn.Config(server_app.app, host="127.0.0.1", port=port, log_config=None,
                                           timeout_graceful_shutdown=SHUTDOWN))
    if "--stay" not in args:
        threading.Thread(target=watch, args=(server_app.windows, server), daemon=True).start()
    server.run()
    print("Stopped", flush=True)
    os._exit(0)  # (and gone, whatever's left: a chart download's worker processes, a thread mid-request)


if __name__ == "__main__":
    main()
