#!/usr/bin/env python3
"""
Paragem local proxy. Python 3.8+, standard library only.

- Serves the Paragem app from the folder above this one (index.html etc.).
- Forwards a few read-only STCP API paths (/api/...) and adds CORS headers.
- Caches realtime answers for 20 s and stop lists for an hour, so several
  open tabs or phones never multiply the requests to STCP.

Run:   python3 proxy/local_proxy.py            (port 8787)
       python3 proxy/local_proxy.py --port 9000
Then open http://localhost:8787 on this computer, or http://<this-computer's-LAN-IP>:8787
on your phone while both are on the same Wi-Fi.
"""
import argparse
import json
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

UPSTREAM = "https://stcp.pt"
ALLOWED = re.compile(
    r"^/api/(stops/[A-Za-z0-9._-]{1,16}(/(realtime|routes))?"
    r"|route/[A-Za-z0-9_-]{1,16}/(stops/direction|services))$"
)
APP_DIR = Path(__file__).resolve().parent.parent

_cache = {}
_lock = threading.Lock()


def fetch_upstream(path, query):
    params = urllib.parse.parse_qs(query)
    q = ""
    if "direction_id" in params:
        d = params["direction_id"][0]
        if d not in ("0", "1"):
            return 400, b'{"error":"bad direction_id"}'
        q = "?direction_id=" + d
    url = UPSTREAM + path + q
    ttl = 20 if path.endswith("/realtime") else 3600

    with _lock:
        hit = _cache.get(url)
        if hit and time.time() - hit[0] < ttl:
            return hit[1], hit[2]

    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "Paragem personal proxy"})
    try:
        with urllib.request.urlopen(req, timeout=10, context=ssl.create_default_context()) as r:
            status, body = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, body = e.code, e.read() or json.dumps({"error": str(e)}).encode()
    except Exception as e:  # network down, DNS, TLS…
        return 502, json.dumps({"error": "upstream unreachable", "detail": str(e)}).encode()

    if status == 200:
        with _lock:
            _cache[url] = (time.time(), status, body)
    return status, body


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parts = urllib.parse.urlsplit(self.path)
        if parts.path.startswith("/api/"):
            if not ALLOWED.match(parts.path):
                self.send_error(404, "Not an allowed API path")
                return
            status, body = fetch_upstream(parts.path, parts.query)
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # Only the app's own files are served, nothing from the proxy folder.
        if parts.path.startswith("/proxy/") or parts.path.startswith("/test/"):
            self.send_error(404)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        line = fmt % args
        if "/api/" in line or " 4" in line or " 5" in line:
            print("  " + line)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="0.0.0.0", help="0.0.0.0 = reachable from your phone on the same Wi-Fi")
    a = ap.parse_args()
    srv = ThreadingHTTPServer((a.host, a.port), partial(Handler, directory=str(APP_DIR)))
    print(f"Paragem on http://localhost:{a.port}  (serving {APP_DIR})")
    print("Ctrl+C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
