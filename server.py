#!/usr/bin/env python3
"""Dolly server: serves the static app, /api/summarize (Claude) and share links.

Run:  python3 server.py            (then open http://localhost:8000 in Chrome)
AI summaries use Claude when the `anthropic` package is installed and
ANTHROPIC_API_KEY is set; otherwise the browser falls back to a local summary.
Share links (see sharing.py and README "Sharing publicly") are stored under
DOLLY_DATA_DIR (default ./data). Bind address: DOLLY_HOST (default 127.0.0.1).
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
MODEL = os.environ.get("DOLLY_MODEL", "claude-opus-5-5")
SHARING = sharing.ShareService.from_env(ROOT, host=HOST, port=PORT)

try:
    import anthropic  # type: ignore
except ImportError:  # pragma: no cover
    anthropic = None

SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "tldr": {"type": "string"},
        "key_points": {"type": "array", "items": {"type": "string"}},
        "action_items": {"type": "array", "items": {"type": "string"}},
        "chapters": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "number"},
                    "title": {"type": "string"},
                },
                "required": ["start", "title"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "tldr", "key_points", "action_items", "chapters"],
    "additionalProperties": False,
}

PROMPT = """You are summarizing a screen recording (like a Loom video) from its timestamped transcript.
Write for a teammate who has not watched it yet.

- title: a short, specific title (max 8 words).
- tldr: 1-2 sentences.
- key_points: 3-6 concise bullet points.
- action_items: concrete follow-ups mentioned or implied (empty list if none).
- chapters: 2-6 chapters; `start` is seconds from the start of the video and must match a transcript timestamp. The first chapter starts at 0.

Video duration: {duration:.0f} seconds.

Transcript (each line is [seconds] text):
{transcript}"""


def ai_available():
    return anthropic is not None and bool(os.environ.get("ANTHROPIC_API_KEY"))


def summarize(segments, duration):
    lines = "\n".join(f"[{s.get('start', 0):.1f}] {s.get('text', '').strip()}" for s in segments)
    client = anthropic.Anthropic()
    response = client.messages.create(
        model=MODEL,
        max_tokens=16000,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SUMMARY_SCHEMA}},
        messages=[{"role": "user", "content": PROMPT.format(duration=duration, transcript=lines)}],
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to summarize this transcript.")
    text = next(b.text for b in response.content if b.type == "text")
    return json.loads(text)


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
            return self._json(200, {"ai": ai_available(), "model": MODEL if ai_available() else None})
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
        if self.path != "/api/summarize":
            return self._json(404, {"error": "not found"})
        if not ai_available():
            return self._json(503, {"error": "AI summaries are not configured on the server."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length) or b"{}")
            segments = data.get("segments") or []
            if not segments:
                return self._json(400, {"error": "Transcript is empty."})
            return self._json(200, summarize(segments, float(data.get("duration") or 0)))
        except anthropic.AuthenticationError:
            return self._json(502, {"error": "Invalid ANTHROPIC_API_KEY."})
        except anthropic.RateLimitError:
            return self._json(429, {"error": "Rate limited by the API, try again shortly."})
        except anthropic.APIStatusError as e:
            return self._json(502, {"error": f"API error: {e.message}"})
        except anthropic.APIConnectionError:
            return self._json(502, {"error": "Could not reach the Claude API."})
        except Exception as e:  # noqa: BLE001
            return self._json(500, {"error": str(e)})


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
    print(f"Dolly running at http://localhost:{port}  (AI summaries: {'on' if ai_available() else 'off'})")
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
