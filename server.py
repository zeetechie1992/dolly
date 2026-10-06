#!/usr/bin/env python3
"""Dolly server: serves the static app and share links. No API keys needed.

Run:  python3 server.py            (then open http://localhost:8000 in Chrome)
Summaries are generated in the browser. Share links (see sharing.py and README
"Sharing publicly") are stored under DOLLY_DATA_DIR (default ./data). Bind address: DOLLY_HOST (default 127.0.0.1).
"""
from __future__ import annotations

import json
import os
import socket
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

import sharing

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
HOST = os.environ.get("DOLLY_HOST", "127.0.0.1").strip() or "127.0.0.1"
PORT = int(os.environ.get("PORT", "8000"))
SHARING = sharing.ShareService.from_env(ROOT, host=HOST, port=PORT)

class Handler(SimpleHTTPRequestHandler):
    server_version = "Dolly"
    sys_version = ""
    timeout = 60  # seconds a socket read/write may stall (slow uploads resume; idle sockets close)
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".webmanifest": "application/manifest+json",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def version_string(self):
        return self.server_version

    # Response headers: every response gets nosniff + a referrer policy, and is framable only
    # by this site (the /embed/ player opts out). Cache-Control defaults to no-store unless
    # the route chose its own (the /media routes use private caching).
    def send_response(self, code, message=None):
        self._dolly_headers = set()
        super().send_response(code, message)

    def send_header(self, keyword, value):
        sent = getattr(self, "_dolly_headers", None)
        if sent is not None:
            sent.add(keyword.lower())
        super().send_header(keyword, value)

    def end_headers(self):
        sent = getattr(self, "_dolly_headers", None)
        if sent is not None:  # None for interim responses such as 100 Continue
            if "cache-control" not in sent:
                self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
            if "x-frame-options" not in sent and not getattr(self, "_dolly_allow_framing", False):
                self.send_header("X-Frame-Options", "SAMEORIGIN")
            self._dolly_headers = None
        super().end_headers()

    def list_directory(self, path):  # never list folders of public/
        self.send_error(404, "File not found")
        return None

    def log_message(self, fmt, *args):
        sys.stderr.write("[dolly] " + (fmt % args) + "\n")

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._dolly_allow_framing = False
        if self.path == "/api/status":
            return self._json(200, {"ok": True})
        if SHARING.handle(self):
            return None
        return super().do_GET()

    def do_HEAD(self):
        self._dolly_allow_framing = False
        if SHARING.handle(self):
            return None
        return super().do_HEAD()

    def do_PUT(self):
        if not SHARING.handle(self):
            self._json(404, {"error": "not found"})

    def do_PATCH(self):
        if not SHARING.handle(self):
            self._json(404, {"error": "not found"})

    def do_DELETE(self):
        if not SHARING.handle(self):
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if SHARING.handle(self):
            return None
        return self._json(404, {"error": "not found"})


class DollyServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], sharing.DISCONNECT_ERRORS):
            return  # the browser went away mid-response (seeking video, closed tab)
        super().handle_error(request, client_address)


class DollyServer6(DollyServer):
    address_family = socket.AF_INET6


def create_server(host: str = HOST, port: int = PORT) -> DollyServer:
    """Creates the data directory + secret, then binds (port 0 picks a free port)."""
    SHARING.init_storage()
    cls = DollyServer6 if ":" in host else DollyServer
    return cls((host, port), Handler)


def main():
    httpd = create_server()
    port = httpd.server_address[1]
    print(f"Dolly running at http://localhost:{port}")
    for line in SHARING.startup_lines(port):
        print(line)
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
