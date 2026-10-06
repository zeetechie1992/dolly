#!/usr/bin/env python3
"""End-to-end tests for Dolly share links (server.py + sharing.py).

Starts the real server in-process on a random port with a temporary data directory and
talks to it over HTTP. Python 3.9+ standard library only.

Usage: python3 tools/test_sharing.py [-v]
"""
from __future__ import annotations

import contextlib
import hashlib
import http.client
import io
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="dolly-share-test-")
os.environ["DOLLY_DATA_DIR"] = os.path.join(TMP, "data")
os.environ["DOLLY_HOST"] = "127.0.0.1"
for _key in ("DOLLY_PUBLIC_URL", "DOLLY_SHARE_KEY", "DOLLY_MAX_UPLOAD_MB", "DOLLY_TRUST_PROXY", "ANTHROPIC_API_KEY"):
    os.environ.pop(_key, None)
sys.path.insert(0, ROOT)

import server  # noqa: E402
import sharing  # noqa: E402

if "-v" not in sys.argv:
    server.Handler.log_message = lambda self, fmt, *args: None  # keep the test output readable

WEBM = b"\x1a\x45\xdf\xa3" + bytes(range(256)) * 40          # 10 244 bytes, starts like a WebM file
WEBM_V2 = b"\x1a\x45\xdf\xa3" + bytes(reversed(range(256))) * 30
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 5000
JPEG = b"\xff\xd8\xff\xe0" + b"\x10" * 2000 + b"\xff\xd9"
TEMPLATE = (
    "<!doctype html><html><head><title>{{TITLE}}</title>"
    '<meta name="description" content="{{DESCRIPTION}}">'
    '<link rel="canonical" href="{{URL}}">'
    '<meta property="og:image" content="{{OG_IMAGE}}">'
    '<meta property="og:video" content="{{OG_VIDEO}}">'
    '<meta property="og:video:type" content="{{OG_VIDEO_TYPE}}">'
    "</head><body data-share-id=\"{{SHARE_ID}}\" data-mode=\"{{MODE}}\">{{NOT_A_PLACEHOLDER}}</body></html>"
)
ID_RE = re.compile(r"^[A-Za-z0-9]{6,16}$")
PUBLIC_DIR = os.path.join(ROOT, "public")


class StubHandler:
    """Just enough of a request handler for the network-identity helpers."""

    def __init__(self, peer, headers=None):
        self.client_address = (peer, 1)
        self.headers = dict(headers or {})


class Resp:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers
        self.body = body

    @property
    def json(self):
        return json.loads(self.body.decode("utf-8")) if self.body else None

    @property
    def text(self):
        return self.body.decode("utf-8")


class ProxyTrustTest(unittest.TestCase):
    def test_cloud_edge_ranges_count_as_internal(self):
        import ipaddress
        internal = ["10.0.0.5", "192.168.1.2", "172.16.4.4", "100.64.0.1", "100.127.255.254", "fd12::1"]
        public = ["8.8.8.8", "100.128.0.1", "2606:4700::1111"]
        for raw in internal:
            self.assertTrue(sharing._is_internal(ipaddress.ip_address(raw)), raw)
        for raw in public:
            self.assertFalse(sharing._is_internal(ipaddress.ip_address(raw)), raw)


class ShareServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc = server.SHARING
        cls.template_path = os.path.join(TMP, "share.html")
        with open(cls.template_path, "w", encoding="utf-8") as f:
            f.write(TEMPLATE)
        cls.real_template_path = cls.svc.template_path
        cls.svc.template_path = cls.template_path
        cls.httpd = server.create_server("127.0.0.1", 0)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(TMP, ignore_errors=True)

    def setUp(self):
        self.svc.share_key = None
        self.svc.public_url = None
        self.svc.host = "127.0.0.1"
        self.svc.max_upload_bytes = 4096 * sharing.MB
        self.svc.unlock_fail_delay = sharing.UNLOCK_FAIL_DELAY
        self.svc.comment_limiter.reset()
        self.svc.comment_share_limiter.reset()
        self.svc.unlock_limiter.reset()
        self.svc.unlock_share_limiter.reset()
        self.svc.view_limiter.reset()
        self.svc.key_limiter.reset()

    # ------------------------------------------------------------------ helpers

    def request(self, method, path, body=None, headers=None, json_body=None, raw_body_len=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        hdrs = dict(headers or {})
        if json_body is not None:
            body = json.dumps(json_body).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
        try:
            if raw_body_len is not None:  # announce a body but don't send it
                conn.putrequest(method, path)
                for k, v in hdrs.items():
                    conn.putheader(k, v)
                conn.putheader("Content-Length", str(raw_body_len))
                conn.endheaders()
            else:
                conn.request(method, path, body=body, headers=hdrs)
            r = conn.getresponse()
            data = r.read()
            return Resp(r.status, {k.lower(): v for k, v in r.getheaders()}, data)
        finally:
            conn.close()

    def payload(self, **overrides):
        data = {
            "title": "Quarterly review",
            "description": "We walk through the numbers.",
            "ownerName": "Sam",
            "summary": {
                "title": "Review", "tldr": "Numbers are up.", "key_points": ["Up 10%"],
                "action_items": ["Ship it"], "chapters": [{"start": 0, "title": "Intro"}],
                "source": "ai", "model": "claude", "generatedAt": 1700000000000, "transcriptHash": "abc",
            },
            "transcript": [{"start": 0, "end": 2, "text": "Hello there"}, {"start": 2, "end": 4, "text": "Second"}],
            "captions": {"enabled": True, "style": "clean", "position": "bottom", "size": "M", "burned": False},
            "layout": {"aspect": "16:9", "width": 1920, "height": 1080,
                       "camera": {"x": 1500, "y": 700, "size": 300, "shape": "circle"}},
            "duration": 30,
            "settings": {"allowDownload": False, "showSummary": True, "showTranscript": True, "allowComments": True},
        }
        data.update(overrides)
        return data

    def create(self, **overrides):
        r = self.request("POST", "/api/shares", json_body=self.payload(**overrides))
        self.assertEqual(r.status, 201, r.body)
        body = r.json
        return body["id"], body["ownerToken"], body

    def owner(self, token):
        return {"X-Owner-Token": token}

    def upload(self, sid, token, data=WEBM, chunk=4000, mime="video/webm", duration=30, **start_fields):
        r = self.request("POST", f"/api/shares/{sid}/video/start", headers=self.owner(token),
                         json_body={"mimeType": mime, "size": len(data), "width": 1920, "height": 1080,
                                    "duration": duration, **start_fields})
        self.assertEqual(r.status, 200, r.body)
        version = r.json["version"]
        self.assertEqual(r.json["offset"], 0)
        offset = 0
        while offset < len(data):
            piece = data[offset: offset + chunk]
            r = self.request("PUT", f"/api/shares/{sid}/video?version={version}&offset={offset}", body=piece,
                             headers={**self.owner(token), "Content-Type": "application/octet-stream"})
            self.assertEqual(r.status, 200, r.body)
            offset += len(piece)
            self.assertEqual(r.json["received"], offset)
        r = self.request("POST", f"/api/shares/{sid}/video/complete?version={version}", headers=self.owner(token))
        self.assertEqual(r.status, 200, r.body)
        return version, r.json

    def share_dir(self, sid):
        return os.path.join(self.svc.shares_dir, sid)

    def patch(self, sid, token, body):
        r = self.request("PATCH", f"/api/shares/{sid}", headers=self.owner(token), json_body=body)
        self.assertEqual(r.status, 200, r.body)
        return r.json

    # ------------------------------------------------------------------ existing APIs

    def test_existing_api_unchanged(self):
        r = self.request("GET", "/api/status")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json, {"ai": False, "model": None})
        r = self.request("POST", "/api/summarize", json_body={"segments": [{"start": 0, "text": "hi"}], "duration": 1})
        self.assertEqual(r.status, 503)
        r = self.request("GET", "/index.html")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.headers.get("cache-control"), "no-store")
        r = self.request("GET", "/js/main.js")
        self.assertEqual(r.status, 200)
        self.assertTrue(r.headers["content-type"].startswith("text/javascript"))

    def test_security_headers(self):
        for path in ("/api/share-config", "/index.html", "/api/status"):
            r = self.request("GET", path)
            self.assertEqual(r.headers.get("x-content-type-options"), "nosniff", path)
            self.assertEqual(r.headers.get("referrer-policy"), "strict-origin-when-cross-origin", path)
            self.assertEqual(r.headers.get("cache-control"), "no-store", path)
        self.assertEqual(self.request("GET", "/js/").status, 404)  # no directory listings

    # ------------------------------------------------------------------ config & create

    def test_share_config_loopback(self):
        r = self.request("GET", "/api/share-config")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json, {"canCreate": True, "keyRequired": False,
                                  "publicBase": f"http://127.0.0.1:{self.port}", "isLocalOnly": True})

    def test_share_config_remote(self):
        proxied = {"X-Forwarded-For": "203.0.113.9"}
        r = self.request("GET", "/api/share-config", headers=proxied)
        self.assertEqual((r.json["canCreate"], r.json["keyRequired"]), (False, False))
        self.svc.share_key = "s3cret"
        r = self.request("GET", "/api/share-config", headers=proxied)
        self.assertEqual((r.json["canCreate"], r.json["keyRequired"]), (True, True))
        r = self.request("GET", "/api/share-config")  # a configured key applies to loopback too
        self.assertEqual((r.json["canCreate"], r.json["keyRequired"]), (True, True))
        self.svc.share_key = None
        r = self.request("GET", "/api/share-config", headers={"Origin": "https://evil.example"})
        self.assertEqual((r.json["canCreate"], r.json["keyRequired"]), (False, False))

    def test_public_base(self):
        r = self.request("GET", "/api/share-config", headers={"X-Forwarded-Proto": "https", "Host": "dolly.example.com"})
        self.assertEqual(r.json["publicBase"], "https://dolly.example.com")
        self.assertFalse(r.json["isLocalOnly"])
        r = self.request("GET", "/api/share-config", headers={"Host": "bad host\"<>"})
        self.assertTrue(r.json["publicBase"].startswith("http://localhost:"))
        self.svc.public_url = "https://videos.example.org"
        sid, _, body = self.create()
        self.assertEqual(body["url"], f"https://videos.example.org/s/{sid}")
        self.assertEqual(body["embedUrl"], f"https://videos.example.org/embed/{sid}")
        self.assertFalse(self.request("GET", "/api/share-config").json["isLocalOnly"])
        self.svc.public_url = None
        self.svc.host = "0.0.0.0"
        lan = self.svc._lan_ip()
        r = self.request("GET", "/api/share-config", headers={"Host": f"localhost:{self.port}"})
        if lan:
            self.assertEqual(r.json["publicBase"], f"http://{lan}:{self.port}")
            self.assertFalse(r.json["isLocalOnly"])
        else:
            self.assertTrue(r.json["isLocalOnly"])

    def test_create_loopback(self):
        sid, token, body = self.create()
        self.assertRegex(sid, ID_RE)
        self.assertGreaterEqual(len(token), 40)
        self.assertEqual(body["url"], f"http://127.0.0.1:{self.port}/s/{sid}")
        self.assertEqual(body["embedUrl"], f"http://127.0.0.1:{self.port}/embed/{sid}")
        share = body["share"]
        self.assertEqual(share["status"], "processing")
        self.assertEqual(share["version"], 0)
        self.assertIsNone(share["video"])
        self.assertEqual(share["commentCount"], 0)
        self.assertIsNone(share["upload"])
        self.assertEqual(share["settings"], {"allowDownload": False, "showSummary": True, "showTranscript": True,
                                             "allowComments": True, "hasPassword": False})
        with open(os.path.join(self.share_dir(sid), "meta.json"), encoding="utf-8") as f:
            meta = json.load(f)
        self.assertEqual(meta["ownerTokenHash"], hashlib.sha256(token.encode()).hexdigest())
        self.assertNotIn(token, json.dumps(meta))
        self.assertNotIn("ownerTokenHash", json.dumps(share))
        mode = os.stat(os.path.join(self.svc.data_dir, "secret.key")).st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_create_remote_needs_key(self):
        proxied = {"X-Forwarded-For": "203.0.113.9"}
        r = self.request("POST", "/api/shares", headers=proxied, json_body=self.payload())
        self.assertEqual(r.status, 403)
        self.assertFalse(r.json["keyRequired"])
        self.svc.share_key = "s3cret"
        r = self.request("POST", "/api/shares", headers=proxied, json_body=self.payload())
        self.assertEqual(r.status, 403)
        self.assertTrue(r.json["keyRequired"])
        r = self.request("POST", "/api/shares", headers={**proxied, "X-Dolly-Key": "wrong"}, json_body=self.payload())
        self.assertEqual(r.status, 403)
        r = self.request("POST", "/api/shares", headers={**proxied, "X-Dolly-Key": "s3cret"}, json_body=self.payload())
        self.assertEqual(r.status, 201)
        # Loopback peer but a foreign Host (DNS rebinding / tunnel) counts as remote.
        self.svc.share_key = None
        r = self.request("POST", "/api/shares", headers={"Host": "evil.example"}, json_body=self.payload())
        self.assertEqual(r.status, 403)

    def test_share_key_applies_to_loopback_too(self):
        # A same-host proxy or tunnel that adds no forwarding headers makes every visitor look
        # local, so once a key is configured nobody is exempt.
        self.svc.share_key = "a-long-enough-test-key"
        r = self.request("POST", "/api/shares", json_body=self.payload())
        self.assertEqual((r.status, r.json["keyRequired"]), (403, True))
        started = time.monotonic()
        r = self.request("POST", "/api/shares", headers={"X-Dolly-Key": "nope"}, json_body=self.payload())
        self.assertEqual(r.status, 403)
        self.assertGreaterEqual(time.monotonic() - started, 0.5)  # wrong keys are slowed down
        r = self.request("POST", "/api/shares", headers={"X-Dolly-Key": "a-long-enough-test-key"}, json_body=self.payload())
        self.assertEqual(r.status, 201)
        self.svc.share_key = None
        self.assertEqual(self.request("POST", "/api/shares", json_body=self.payload()).status, 201)

    def test_share_key_attempts_are_throttled(self):
        self.svc.share_key = "k" * 24
        self.svc.unlock_fail_delay = 0
        proxied = {"X-Forwarded-For": "203.0.113.50"}
        statuses = [self.request("POST", "/api/shares", headers={**proxied, "X-Dolly-Key": f"guess-{i}"},
                                 json_body={}).status for i in range(11)]
        self.assertEqual(statuses, [403] * 10 + [429])
        r = self.request("POST", "/api/shares", headers={**proxied, "X-Dolly-Key": "k" * 24}, json_body={})
        self.assertEqual(r.status, 429)  # throttled even with the right key: no free guesses
        self.assertIn("retry-after", r.headers)
        r = self.request("POST", "/api/shares", headers={"X-Forwarded-For": "203.0.113.51", "X-Dolly-Key": "k" * 24},
                         json_body={})
        self.assertEqual(r.status, 201)  # other clients keep their own budget

    def test_create_refuses_cross_site_requests(self):
        before = set(os.listdir(self.svc.shares_dir))
        # Empty "simple" requests a page on any site can send (fetch no-cors, sendBeacon, <form>).
        self.assertEqual(self.request("POST", "/api/shares").status, 415)
        for ctype in ("application/x-www-form-urlencoded", "text/plain", "multipart/form-data; boundary=x"):
            r = self.request("POST", "/api/shares", body=b"", headers={"Content-Type": ctype, "Origin": "https://evil.example"})
            self.assertEqual(r.status, 415, ctype)
        # JSON from another site's page (needs a preflight, which never succeeds) is refused too.
        r = self.request("POST", "/api/shares", headers={"Origin": "https://evil.example"}, json_body={})
        self.assertEqual((r.status, r.json["keyRequired"]), (403, False))
        r = self.request("POST", "/api/shares", headers={"Origin": "null"}, json_body={})
        self.assertEqual(r.status, 403)
        r = self.request("POST", "/api/shares", headers={"Sec-Fetch-Site": "cross-site"}, json_body={})
        self.assertEqual(r.status, 403)
        r = self.request("POST", "/api/shares", headers={"Sec-Fetch-Site": "same-site"}, json_body={})
        self.assertEqual(r.status, 403)
        self.assertEqual(set(os.listdir(self.svc.shares_dir)), before)
        # The app itself (same origin) still works, an empty JSON body included.
        same = {"Origin": f"http://127.0.0.1:{self.port}", "Sec-Fetch-Site": "same-origin"}
        self.assertEqual(self.request("POST", "/api/shares", headers=same, json_body={}).status, 201)
        r = self.request("POST", "/api/shares", body=b"", headers={"Content-Type": "application/json"})
        self.assertEqual(r.status, 201)

    def test_create_validation(self):
        r = self.request("POST", "/api/shares", body=json.dumps(self.payload()).encode(),
                         headers={"Content-Type": "text/plain"})
        self.assertEqual(r.status, 415)
        r = self.request("POST", "/api/shares", body=b"{nope", headers={"Content-Type": "application/json"})
        self.assertEqual(r.status, 400)
        r = self.request("POST", "/api/shares", body=b'{"duration": NaN}', headers={"Content-Type": "application/json"})
        self.assertEqual(r.status, 400)
        r = self.request("POST", "/api/shares", body=b"[1,2]", headers={"Content-Type": "application/json"})
        self.assertEqual(r.status, 400)
        r = self.request("POST", "/api/shares", body=b'{"duration": ' + b"9" * 5000 + b"}",
                         headers={"Content-Type": "application/json"})
        self.assertEqual(r.status, 400)
        r = self.request("POST", "/api/shares", body=b"[" * 100000, headers={"Content-Type": "application/json"})
        self.assertEqual(r.status, 400)
        r = self.request("POST", "/api/shares", json_body=self.payload(title=123))
        self.assertEqual(r.status, 400)
        r = self.request("POST", "/api/shares", json_body=self.payload(settings={"allowDownload": "yes"}))
        self.assertEqual(r.status, 400)
        r = self.request("POST", "/api/shares",
                         json_body=self.payload(transcript=[{"start": 0, "end": 1, "text": "x"}] * 20001))
        self.assertEqual(r.status, 400)
        big = {"title": "x", "description": "y" * (3 * 1024 * 1024)}
        r = self.request("POST", "/api/shares", json_body=big)
        self.assertEqual(r.status, 413)

        sid, token, body = self.create(
            title="  " + "T" * 500 + "‮\x00",
            description="line one\r\n\r\n\r\n\r\nline two\x07",
            ownerName="N" * 100,
            duration=10,
            transcript=[
                {"start": 5, "end": 7, "text": "  later  "},
                {"start": 1, "end": 0.5, "text": "end before start"},
                {"start": "x", "end": 1, "text": "bad start"},
                {"start": 2, "end": 3, "text": 42},
                {"start": 9, "end": 15, "text": "clipped"},
                {"start": 11, "end": 12, "text": "past the end"},
                "junk",
            ],
            summary={"title": "S", "key_points": ["a", 5, None, "b"], "chapters": [{"start": 50, "title": "past"},
                     {"start": 3, "title": "Three"}, {"start": 1}], "extra": "dropped", "source": "weird"},
            captions={"enabled": True, "style": "nonexistent", "position": "left", "size": "XXL", "burned": False},
            layout={"aspect": "7:3", "width": 99999, "height": -5, "camera": {"x": "a"}},
        )
        share = body["share"]
        self.assertEqual(len(share["title"]), 200)
        self.assertEqual(share["description"], "line one\n\nline two")
        self.assertEqual(len(share["ownerName"]), 60)
        self.assertEqual(share["transcript"], [
            {"start": 1.0, "end": 1.0, "text": "end before start"},
            {"start": 5.0, "end": 7.0, "text": "later"},
            {"start": 9.0, "end": 10.0, "text": "clipped"},
        ])
        summary = share["summary"]
        self.assertNotIn("extra", summary)
        self.assertEqual(summary["key_points"], ["a", "b"])
        self.assertEqual(summary["chapters"], [{"start": 3.0, "title": "Three"}])
        self.assertEqual(summary["source"], "local")
        self.assertEqual(share["captions"], {"enabled": True, "style": "minimal", "position": "bottom",
                                             "size": "M", "burned": False})
        self.assertEqual(share["layout"], {"aspect": "16:9", "width": 16384, "height": 1, "camera": None})

    # ------------------------------------------------------------------ owner auth & patch

    def test_owner_auth_failures(self):
        sid, token, _ = self.create()
        self.assertEqual(self.request("GET", f"/api/shares/{sid}/owner").status, 401)
        self.assertEqual(self.request("GET", f"/api/shares/{sid}/owner", headers=self.owner("nope")).status, 403)
        self.assertEqual(self.request("GET", f"/api/shares/{sid}/owner", headers=self.owner("x" * 5000)).status, 403)
        _, other_token, _ = self.create()
        self.assertEqual(self.request("GET", f"/api/shares/{sid}/owner", headers=self.owner(other_token)).status, 403)
        self.assertEqual(self.request("PATCH", f"/api/shares/{sid}", headers=self.owner("nope"),
                                      json_body={"title": "hacked"}).status, 403)
        self.assertEqual(self.request("DELETE", f"/api/shares/{sid}", headers=self.owner("nope")).status, 403)
        self.assertEqual(self.request("POST", f"/api/shares/{sid}/video/start", headers=self.owner("nope"),
                                      json_body={"mimeType": "video/webm", "size": 10}).status, 403)
        self.assertEqual(self.request("PUT", f"/api/shares/{sid}/poster", body=JPEG).status, 401)
        self.assertEqual(self.request("GET", "/api/shares/zzzzzzzzzz/owner", headers=self.owner(token)).status, 404)
        r = self.request("GET", f"/api/shares/{sid}/owner", headers=self.owner(token))
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json["title"], "Quarterly review")
        r = self.request("POST", f"/api/shares/{sid}/owner", headers=self.owner(token))
        self.assertEqual(r.status, 405)
        self.assertIn("GET", r.headers["allow"])

    def test_patch_settings_merge_and_password(self):
        sid, token, _ = self.create()
        view = self.patch(sid, token, {"settings": {"allowDownload": True}})
        self.assertEqual(view["settings"], {"allowDownload": True, "showSummary": True, "showTranscript": True,
                                            "allowComments": True, "hasPassword": False})
        view = self.patch(sid, token, {"title": "New title", "settings": {"showSummary": False, "showTranscript": False}})
        self.assertEqual(view["title"], "New title")
        self.assertTrue(view["settings"]["allowDownload"])
        self.assertIsNotNone(view["summary"])  # owners always see their own summary
        public = self.request("GET", f"/api/shares/{sid}").json
        self.assertIsNone(public["summary"])
        self.assertTrue(public["transcript"])  # still sent: captions are overlaid (enabled, not burned)
        self.patch(sid, token, {"captions": {"enabled": True, "burned": True}})
        self.assertEqual(self.request("GET", f"/api/shares/{sid}").json["transcript"], [])
        self.assertNotIn("ownerTokenHash", public)
        self.assertNotIn("password", json.dumps(public["settings"]))

        view = self.patch(sid, token, {"settings": {"password": "hunter2"}})
        self.assertTrue(view["settings"]["hasPassword"])
        self.assertTrue(view["settings"]["allowDownload"])  # merge kept the other settings
        self.assertNotIn("hunter2", json.dumps(view))
        with open(os.path.join(self.share_dir(sid), "meta.json"), encoding="utf-8") as f:
            stored = json.load(f)["settings"]["password"]
        self.assertEqual(set(stored), {"salt", "hash"})
        r = self.request("GET", f"/api/shares/{sid}")
        self.assertEqual(r.status, 401)
        self.assertEqual(r.json["passwordRequired"], True)
        self.assertIsNone(r.json["title"])
        view = self.patch(sid, token, {"settings": {"allowComments": False}})  # omitted password is kept
        self.assertTrue(view["settings"]["hasPassword"])
        view = self.patch(sid, token, {"settings": {"password": None}})
        self.assertFalse(view["settings"]["hasPassword"])
        self.assertFalse(view["settings"]["allowComments"])
        self.assertEqual(self.request("GET", f"/api/shares/{sid}").status, 200)
        r = self.request("PATCH", f"/api/shares/{sid}", headers=self.owner(token),
                         json_body={"settings": {"password": 1234}})
        self.assertEqual(r.status, 400)
        r = self.request("PATCH", f"/api/shares/{sid}", headers=self.owner(token),
                         json_body={"settings": {"password": "p" * 300}})
        self.assertEqual(r.status, 400)
        # Patching the duration re-clips the transcript.
        view = self.patch(sid, token, {"duration": 3})
        self.assertEqual(view["transcript"][-1], {"start": 2.0, "end": 3.0, "text": "Second"})

    # ------------------------------------------------------------------ upload

    def test_chunked_upload_resume_complete_and_versions(self):
        sid, token, _ = self.create()
        h = self.owner(token)
        r = self.request("POST", f"/api/shares/{sid}/video/start", headers=h,
                         json_body={"mimeType": "video/webm;codecs=vp9,opus", "size": len(WEBM),
                                    "width": 1920, "height": 1080, "duration": 30})
        self.assertEqual(r.json, {"version": 1, "offset": 0})
        put = "/api/shares/{}/video?version={}&offset={}"
        r = self.request("PUT", put.format(sid, 1, 0), body=WEBM[:4000], headers=h)
        self.assertEqual(r.json, {"received": 4000})
        # A retried chunk the server already has → 409 with the real offset.
        r = self.request("PUT", put.format(sid, 1, 0), body=WEBM[:4000], headers=h)
        self.assertEqual(r.status, 409)
        self.assertEqual(r.json["expectedOffset"], 4000)
        r = self.request("PUT", put.format(sid, 1, 9000), body=WEBM[9000:], headers=h)
        self.assertEqual((r.status, r.json["expectedOffset"]), (409, 4000))
        r = self.request("PUT", put.format(sid, 2, 4000), body=WEBM[4000:8000], headers=h)
        self.assertEqual(r.status, 410)
        r = self.request("PUT", f"/api/shares/{sid}/video?version=1", body=b"x", headers=h)
        self.assertEqual(r.status, 400)
        # Completing early → 409 with where to resume.
        r = self.request("POST", f"/api/shares/{sid}/video/complete?version=1", headers=h)
        self.assertEqual((r.status, r.json["expectedOffset"]), (409, 4000))
        r = self.request("PUT", put.format(sid, 1, 4000), body=WEBM[4000:] + b"extra", headers=h)
        self.assertEqual(r.status, 413)
        owner = self.request("GET", f"/api/shares/{sid}/owner", headers=h).json
        self.assertEqual(owner["upload"]["received"], 4000)
        self.assertEqual(owner["upload"]["mimeType"], "video/webm")
        self.assertEqual(owner["status"], "processing")
        r = self.request("PUT", put.format(sid, 1, 4000), body=WEBM[4000:], headers=h)
        self.assertEqual(r.json, {"received": len(WEBM)})
        r = self.request("POST", f"/api/shares/{sid}/video/complete?version=1", headers=h)
        self.assertEqual(r.status, 200)
        view = r.json
        self.assertEqual((view["status"], view["version"], view["upload"]), ("ready", 1, None))
        self.assertEqual(view["video"]["url"], f"/media/{sid}/video?v=1")
        self.assertEqual(view["video"]["mimeType"], "video/webm")
        self.assertEqual(view["video"]["size"], len(WEBM))
        self.assertIsNone(view["video"]["downloadUrl"])
        files = sorted(os.listdir(self.share_dir(sid)))
        self.assertIn("video-1.webm", files)
        self.assertFalse([f for f in files if f.endswith(".part")])
        # Retrying complete after it succeeded is harmless.
        r = self.request("POST", f"/api/shares/{sid}/video/complete?version=1", headers=h)
        self.assertEqual((r.status, r.json["version"]), (200, 1))

        # Second upload: the old video stays live until complete, then is deleted.
        r = self.request("POST", f"/api/shares/{sid}/video/start", headers=h,
                         json_body={"mimeType": "video/mp4", "size": len(MP4), "duration": 12})
        self.assertEqual(r.json["version"], 2)
        public = self.request("GET", f"/api/shares/{sid}").json
        self.assertEqual((public["status"], public["version"]), ("ready", 1))
        self.assertEqual(self.request("GET", f"/media/{sid}/video?v=1").body, WEBM)
        r = self.request("PUT", put.format(sid, 2, 0), body=MP4, headers=h)
        self.assertEqual(r.status, 200)
        r = self.request("POST", f"/api/shares/{sid}/video/complete?version=2", headers=h)
        self.assertEqual((r.json["version"], r.json["video"]["mimeType"]), (2, "video/mp4"))
        files = os.listdir(self.share_dir(sid))
        self.assertIn("video-2.mp4", files)
        self.assertNotIn("video-1.webm", files)
        self.assertEqual(self.request("GET", f"/media/{sid}/video?v=1").status, 404)
        r = self.request("GET", f"/media/{sid}/video?v=2")
        self.assertEqual((r.status, r.headers["content-type"], r.body), (200, "video/mp4", MP4))

        # A restarted upload supersedes the one in flight.
        r1 = self.request("POST", f"/api/shares/{sid}/video/start", headers=h,
                          json_body={"mimeType": "video/webm", "size": len(WEBM_V2)}).json
        r2 = self.request("POST", f"/api/shares/{sid}/video/start", headers=h,
                          json_body={"mimeType": "video/webm", "size": len(WEBM_V2)}).json
        self.assertEqual((r1["version"], r2["version"]), (3, 4))
        self.assertEqual(self.request("PUT", put.format(sid, 3, 0), body=WEBM_V2, headers=h).status, 410)
        self.assertEqual(self.request("PUT", put.format(sid, 4, 0), body=WEBM_V2, headers=h).status, 200)
        self.assertEqual(self.request("POST", f"/api/shares/{sid}/video/complete?version=4", headers=h).json["version"], 4)
        self.assertEqual(sorted(os.listdir(self.share_dir(sid))), ["meta.json", "video-4.webm"])

    def test_upload_limits_and_validation(self):
        sid, token, _ = self.create()
        h = self.owner(token)
        start = f"/api/shares/{sid}/video/start"
        self.assertEqual(self.request("POST", start, headers=h, json_body={"mimeType": "video/quicktime", "size": 10}).status, 415)
        self.assertEqual(self.request("POST", start, headers=h, json_body={"mimeType": "video/mp4", "size": 0}).status, 400)
        self.assertEqual(self.request("POST", start, headers=h, json_body={"mimeType": "video/mp4", "size": 1.5}).status, 400)
        self.assertEqual(self.request("POST", start, headers=h, json_body={"mimeType": "video/mp4", "size": "10"}).status, 400)
        self.svc.max_upload_bytes = 1000
        r = self.request("POST", start, headers=h, json_body={"mimeType": "video/mp4", "size": 2000})
        self.assertEqual((r.status, r.json["maxBytes"]), (413, 1000))
        self.svc.max_upload_bytes = 4096 * sharing.MB
        version = self.request("POST", start, headers=h, json_body={"mimeType": "video/webm", "size": 100}).json["version"]
        # A chunk bigger than 16 MB is refused before its body is read.
        r = self.request("PUT", f"/api/shares/{sid}/video?version={version}&offset=0", headers=h,
                         raw_body_len=20 * sharing.MB)
        self.assertEqual(r.status, 413)
        # Bytes that aren't a video are rejected on complete and the link is marked failed.
        self.request("PUT", f"/api/shares/{sid}/video?version={version}&offset=0", body=b"<html>" + b"x" * 94, headers=h)
        r = self.request("POST", f"/api/shares/{sid}/video/complete?version={version}", headers=h)
        self.assertEqual(r.status, 415)
        view = self.request("GET", f"/api/shares/{sid}/owner", headers=h).json
        self.assertEqual((view["status"], view["upload"], view["video"]), ("failed", None, None))

    def test_video_fail(self):
        sid, token, _ = self.create()
        h = self.owner(token)
        fail = f"/api/shares/{sid}/video/fail"
        start = f"/api/shares/{sid}/video/start"
        v1 = self.request("POST", start, headers=h, json_body={"mimeType": "video/webm", "size": 50}).json["version"]
        # Without a version (or with another one) an upload in flight is never touched: it may be
        # another tab's.
        r = self.request("POST", fail, headers=h, json_body={"error": "render crashed"})
        self.assertEqual((r.status, r.json["status"], r.json["upload"]["version"]), (200, "processing", v1))
        r = self.request("POST", fail, headers=h, json_body={"error": "old job", "version": v1 + 7})
        self.assertEqual((r.json["status"], r.json["upload"]["version"]), ("processing", v1))
        self.assertIn(f"upload-{v1}.part", os.listdir(self.share_dir(sid)))
        # The caller's own upload: dropped, and with no ready video the link has failed.
        r = self.request("POST", fail, headers=h, json_body={"error": "render crashed", "version": v1})
        self.assertEqual((r.status, r.json["status"], r.json["upload"]), (200, "failed", None))
        self.assertEqual(sorted(os.listdir(self.share_dir(sid))), ["meta.json"])
        # Nothing in flight and no video: a failure (even without a version) marks it failed.
        sid2, token2, _ = self.create()
        r = self.request("POST", f"/api/shares/{sid2}/video/fail", headers=self.owner(token2), json_body={"error": "x"})
        self.assertEqual(r.json["status"], "failed")
        # With a ready video the link stays ready; only the failed upload goes.
        self.upload(sid, token)
        v = self.request("POST", start, headers=h, json_body={"mimeType": "video/webm", "size": 50}).json["version"]
        r = self.request("POST", fail, headers=h, json_body={"error": "again", "version": v})
        self.assertEqual((r.json["status"], r.json["upload"], r.json["video"]["url"]),
                         ("ready", None, f"/media/{sid}/video?v={v - 1}"))
        self.assertEqual(sorted(os.listdir(self.share_dir(sid))), ["meta.json", f"video-{v - 1}.webm"])
        # Validation.
        self.assertEqual(self.request("POST", fail, headers=h, json_body={"error": "x", "version": "1"}).status, 400)
        self.assertEqual(self.request("POST", fail, headers=h, json_body={"error": "x", "cancelled": "yes"}).status, 400)
        self.assertEqual(self.request("POST", fail, json_body={"error": "x"}).status, 401)

    def test_cancelled_upload_keeps_new_link_processing(self):
        sid, token, _ = self.create()
        h = self.owner(token)
        fail = f"/api/shares/{sid}/video/fail"
        # Cancelled while rendering (no upload started): nothing changes.
        r = self.request("POST", fail, headers=h, json_body={"error": "Cancelled", "cancelled": True})
        self.assertEqual((r.status, r.json["status"], r.json["upload"]), (200, "processing", None))
        # Cancelled mid-upload: that upload is dropped, but viewers still see "processing", not "failed".
        v = self.request("POST", f"/api/shares/{sid}/video/start", headers=h,
                         json_body={"mimeType": "video/webm", "size": len(WEBM)}).json["version"]
        self.request("PUT", f"/api/shares/{sid}/video?version={v}&offset=0", body=WEBM[:4000], headers=h)
        r = self.request("POST", fail, headers=h, json_body={"error": "Cancelled", "cancelled": True, "version": v})
        self.assertEqual((r.json["status"], r.json["upload"]), ("processing", None))
        self.assertEqual(sorted(os.listdir(self.share_dir(sid))), ["meta.json"])
        self.assertEqual(self.request("GET", f"/api/shares/{sid}").json["status"], "processing")
        # A later upload still completes normally.
        version, view = self.upload(sid, token)
        self.assertEqual((view["status"], view["version"]), ("ready", version))
        # Cancelling an update leaves the ready video live.
        v = self.request("POST", f"/api/shares/{sid}/video/start", headers=h,
                         json_body={"mimeType": "video/webm", "size": 50}).json["version"]
        r = self.request("POST", fail, headers=h, json_body={"error": "Cancelled", "cancelled": True, "version": v})
        self.assertEqual((r.json["status"], r.json["upload"], r.json["version"]), ("ready", None, version))

    def test_comments_follow_the_trim_start(self):
        sid, token, _ = self.create(duration=30)
        h = self.owner(token)
        url = f"/api/shares/{sid}/comments"
        meta_path = os.path.join(self.share_dir(sid), "meta.json")

        def post(time_, kind="comment"):
            body = {"kind": kind, "time": time_}
            body.update({"emoji": "🔥"} if kind == "reaction" else {"text": f"at {time_}"})
            r = self.request("POST", url, json_body=body)
            self.assertEqual(r.status, 201, r.body)
            return r.json["id"]

        def times():
            return {c["id"]: c["time"] for c in self.request("GET", url).json["comments"]}

        # A comment posted before any video exists isn't moved by the first upload.
        early = post(5)
        self.upload(sid, token, sourceStart=5, prevSourceStart=None)
        with open(meta_path, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["sourceStart"], 5.0)
        self.assertEqual(times()[early], 5.0)
        a, b, react, untimed = post(2), post(20), post(10, "reaction"), post(None)
        etag = self.request("GET", url).headers["etag"]
        # The owner trims 2 s less off the start: the same moments are 2 s later in the new video.
        self.upload(sid, token, sourceStart=3, prevSourceStart=5)
        t = times()
        self.assertEqual((t[early], t[a], t[b], t[react], t[untimed]), (7.0, 4.0, 22.0, 12.0, None))
        self.assertEqual(self.request("GET", url, headers={"If-None-Match": etag}).status, 200)  # pollers see it
        # Trimmed to [10 s, 22 s] of the recording: moments that were cut become untimed comments.
        self.upload(sid, token, duration=12, sourceStart=10, prevSourceStart=3)
        t = times()
        self.assertEqual((t[early], t[a], t[b], t[react], t[untimed]), (0.0, None, None, 5.0, None))
        self.assertEqual(len(t), 5)  # nothing is deleted
        # Same start, nothing to move: the file isn't rewritten.
        etag = self.request("GET", url).headers["etag"]
        self.upload(sid, token, duration=12, sourceStart=10, prevSourceStart=10)
        self.assertEqual(self.request("GET", url, headers={"If-None-Match": etag}).status, 304)

    def test_comments_follow_the_trim_start_for_older_links(self):
        # Links whose server meta has no sourceStart yet rely on the client's prevSourceStart.
        sid, token, _ = self.create(duration=30)
        url = f"/api/shares/{sid}/comments"
        self.upload(sid, token)  # no sourceStart (an older client)
        cid = self.request("POST", url, json_body={"kind": "comment", "text": "hi", "time": 10}).json["id"]
        self.upload(sid, token, sourceStart=4, prevSourceStart=1)
        self.assertEqual({c["id"]: c["time"] for c in self.request("GET", url).json["comments"]}[cid], 7.0)
        with open(os.path.join(self.share_dir(sid), "meta.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["sourceStart"], 4.0)
        # Without a new start nothing moves (junk values are ignored rather than refused), and the
        # live video's start is unknown again, so the next upload uses the client's prevSourceStart.
        self.upload(sid, token, sourceStart="soon", prevSourceStart=True)
        self.assertEqual(self.request("GET", url).json["comments"][0]["time"], 7.0)
        with open(os.path.join(self.share_dir(sid), "meta.json"), encoding="utf-8") as f:
            self.assertNotIn("sourceStart", json.load(f))
        self.upload(sid, token, sourceStart=2, prevSourceStart=4)
        self.assertEqual(self.request("GET", url).json["comments"][0]["time"], 9.0)

    def test_poster(self):
        sid, token, _ = self.create()
        h = self.owner(token)
        self.assertEqual(self.request("PUT", f"/api/shares/{sid}/poster", body=b"\x89PNG....", headers=h).status, 415)
        self.assertEqual(self.request("PUT", f"/api/shares/{sid}/poster", headers=h, raw_body_len=6 * sharing.MB).status, 413)
        r = self.request("PUT", f"/api/shares/{sid}/poster", body=JPEG, headers={**h, "Content-Type": "image/jpeg"})
        self.assertEqual(r.status, 204)
        poster_url = self.request("GET", f"/api/shares/{sid}").json["posterUrl"]
        self.assertRegex(poster_url, rf"^/media/{sid}/poster\.jpg\?v=\d+$")
        r = self.request("GET", poster_url)
        self.assertEqual((r.status, r.headers["content-type"], r.body), (200, "image/jpeg", JPEG))
        self.assertEqual(r.headers["cache-control"], "private, max-age=3600")
        r2 = self.request("GET", poster_url, headers={"If-None-Match": r.headers["etag"]})
        self.assertEqual(r2.status, 304)

    # ------------------------------------------------------------------ media

    def test_range_requests(self):
        sid, token, _ = self.create()
        self.upload(sid, token)
        url = f"/media/{sid}/video?v=1"
        size = len(WEBM)
        r = self.request("GET", url)
        self.assertEqual((r.status, r.body), (200, WEBM))
        self.assertEqual(r.headers["accept-ranges"], "bytes")
        self.assertEqual(r.headers["content-type"], "video/webm")
        self.assertEqual(r.headers["cache-control"], "private, max-age=3600")
        self.assertNotIn("content-disposition", r.headers)
        r = self.request("GET", url, headers={"Range": "bytes=0-99"})
        self.assertEqual((r.status, r.body), (206, WEBM[:100]))
        self.assertEqual(r.headers["content-range"], f"bytes 0-99/{size}")
        self.assertEqual(r.headers["content-length"], "100")
        r = self.request("GET", url, headers={"Range": "bytes=10000-"})
        self.assertEqual((r.status, r.body), (206, WEBM[10000:]))
        self.assertEqual(r.headers["content-range"], f"bytes 10000-{size - 1}/{size}")
        r = self.request("GET", url, headers={"Range": "bytes=-50"})
        self.assertEqual((r.status, r.body), (206, WEBM[-50:]))
        r = self.request("GET", url, headers={"Range": f"bytes=100-{size * 2}"})
        self.assertEqual((r.status, r.body), (206, WEBM[100:]))
        r = self.request("GET", url, headers={"Range": f"bytes={size}-"})
        self.assertEqual(r.status, 416)
        self.assertEqual(r.headers["content-range"], f"bytes */{size}")
        self.assertEqual(self.request("GET", url, headers={"Range": "bytes=-0"}).status, 416)
        r = self.request("GET", url, headers={"Range": "bytes=50-10"})  # invalid → ignored
        self.assertEqual((r.status, len(r.body)), (200, size))
        r = self.request("GET", url, headers={"Range": "bytes=0-1,5-6"})  # multi-range → whole file
        self.assertEqual((r.status, len(r.body)), (200, size))
        r = self.request("GET", url, headers={"Range": "bytes=0-9", "If-Range": '"stale"'})
        self.assertEqual(r.status, 200)
        r = self.request("HEAD", url, headers={"Range": "bytes=0-9"})
        self.assertEqual((r.status, r.body, r.headers["content-length"]), (206, b"", "10"))
        self.assertEqual(self.request("GET", f"/media/{sid}/video?v=7").status, 404)
        self.assertEqual(self.request("GET", f"/media/{sid}/video").status, 200)
        sid2, _, _ = self.create()
        self.assertEqual(self.request("GET", f"/media/{sid2}/video").status, 404)  # still processing

    def test_client_disconnect_mid_stream(self):
        sid, token, _ = self.create()
        big = b"\x1a\x45\xdf\xa3" + os.urandom(3 * sharing.MB)
        self.upload(sid, token, data=big, chunk=sharing.MB)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", f"/media/{sid}/video?v=1")
        resp = conn.getresponse()
        resp.read(1000)
        conn.close()  # hang up mid-response; the server must shrug it off
        r = self.request("GET", f"/media/{sid}/video?v=1", headers={"Range": "bytes=0-3"})
        self.assertEqual((r.status, r.body), (206, big[:4]))

    def test_download_permission(self):
        sid, token, _ = self.create(title='Q3 "review" / déjà vu')
        self.upload(sid, token)
        r = self.request("GET", f"/media/{sid}/video?v=1&download=1")
        self.assertEqual(r.status, 403)
        view = self.patch(sid, token, {"settings": {"allowDownload": True}})
        self.assertEqual(view["video"]["downloadUrl"], f"/media/{sid}/video?v=1&download=1")
        r = self.request("GET", view["video"]["downloadUrl"])
        self.assertEqual((r.status, r.body), (200, WEBM))
        disposition = r.headers["content-disposition"]
        self.assertTrue(disposition.startswith('attachment; filename="Q3 review  dj vu.webm"'), disposition)
        self.assertIn("filename*=UTF-8''Q3%20%22review%22%20%2F%20d%C3%A9j%C3%A0%20vu.webm", disposition)

    # ------------------------------------------------------------------ password

    def test_password_unlock_and_protected_reads(self):
        sid, token, _ = self.create(settings={"password": "open sesame", "allowDownload": True})
        h = self.owner(token)
        self.upload(sid, token)
        self.request("PUT", f"/api/shares/{sid}/poster", body=JPEG, headers=h)
        r = self.request("GET", f"/api/shares/{sid}")
        self.assertEqual((r.status, r.json["passwordRequired"], r.json["title"]), (401, True, None))
        for path in (f"/api/shares/{sid}/comments", f"/media/{sid}/video?v=1", f"/media/{sid}/poster.jpg"):
            self.assertEqual(self.request("GET", path).status, 401, path)
        self.assertEqual(self.request("POST", f"/api/shares/{sid}/view", json_body={"viewerId": "v1"}).status, 401)
        self.assertEqual(self.request("POST", f"/api/shares/{sid}/comments",
                                      json_body={"kind": "comment", "text": "hi"}).status, 401)
        started = time.monotonic()
        r = self.request("POST", f"/api/shares/{sid}/unlock", json_body={"password": "wrong"})
        self.assertEqual(r.status, 403)
        self.assertGreaterEqual(time.monotonic() - started, 0.5)
        self.assertEqual(self.request("POST", f"/api/shares/{sid}/unlock", json_body={}).status, 400)
        r = self.request("POST", f"/api/shares/{sid}/unlock", json_body={"password": "open sesame"})
        self.assertEqual(r.status, 200)
        access = r.json["access"]
        self.assertRegex(access, r"^[A-Za-z0-9_-]+$")
        r = self.request("GET", f"/api/shares/{sid}", headers={"X-Share-Access": access})
        self.assertEqual(r.status, 200)
        view = r.json
        self.assertEqual(view["title"], "Quarterly review")
        self.assertTrue(view["settings"]["hasPassword"])
        self.assertEqual(view["video"]["url"], f"/media/{sid}/video?v=1&a={access}")
        self.assertEqual(view["video"]["downloadUrl"], f"/media/{sid}/video?v=1&a={access}&download=1")
        self.assertTrue(view["posterUrl"].endswith(f"&a={access}"))
        self.assertEqual(self.request("GET", view["video"]["url"], headers={"Range": "bytes=0-3"}).body, WEBM[:4])
        self.assertEqual(self.request("GET", view["posterUrl"]).body, JPEG)
        self.assertEqual(self.request("GET", view["video"]["downloadUrl"]).status, 200)
        self.assertEqual(self.request("GET", f"/api/shares/{sid}?a={access}").status, 200)
        self.assertEqual(self.request("POST", f"/api/shares/{sid}/view", headers={"X-Share-Access": access},
                                      json_body={"viewerId": "v1"}).json, {"views": 1})
        # Forged, tampered or foreign tokens are refused.
        tampered = access[:-2] + ("AA" if access[-2:] != "AA" else "BB")
        for bad in (tampered, "garbage", "x" * 300, access + "=="):
            self.assertEqual(self.request("GET", f"/api/shares/{sid}", headers={"X-Share-Access": bad}).status, 401, bad)
        other, other_token, _ = self.create(settings={"password": "open sesame"})
        self.assertEqual(self.request("GET", f"/api/shares/{other}", headers={"X-Share-Access": access}).status, 401)
        # The owner token also grants access (owner previewing their own link).
        r = self.request("GET", f"/api/shares/{sid}", headers=h)
        self.assertEqual(r.status, 200)
        owner_view = self.request("GET", f"/api/shares/{sid}/owner", headers=h).json
        self.assertIn("&a=", owner_view["video"]["url"])
        self.assertEqual(self.request("GET", owner_view["video"]["url"]).status, 200)
        # Changing the password revokes earlier access tokens.
        self.patch(sid, token, {"settings": {"password": "new one"}})
        self.assertEqual(self.request("GET", f"/api/shares/{sid}", headers={"X-Share-Access": access}).status, 401)
        self.assertEqual(self.request("GET", f"/media/{sid}/video?v=1&a={access}").status, 401)
        # Expired tokens are refused.
        meta = self.svc.read_meta(sid)
        expired = self.svc.make_access(meta, ttl=-10)
        self.assertEqual(self.request("GET", f"/api/shares/{sid}", headers={"X-Share-Access": expired}).status, 401)

    def test_unlock_rate_limit(self):
        sid, _, _ = self.create(settings={"password": "pw"})
        self.svc.unlock_fail_delay = 0
        statuses = [self.request("POST", f"/api/shares/{sid}/unlock", json_body={"password": "no"}).status
                    for _ in range(21)]
        self.assertEqual(statuses[:20], [403] * 20)
        self.assertEqual(statuses[20], 429)

    def test_unlock_rate_limit_buckets_ipv6_by_64(self):
        sid, _, _ = self.create(settings={"password": "pw"})
        self.svc.unlock_fail_delay = 0
        url = f"/api/shares/{sid}/unlock"
        # 21 addresses from one /64 (what a single VPS gets) share one budget.
        statuses = [self.request("POST", url, headers={"X-Forwarded-For": f"2001:db8:5:6::{i + 1:x}"},
                                 json_body={"password": ""}).status for i in range(21)]
        self.assertEqual(statuses, [403] * 20 + [429])

    def test_unlock_per_share_failure_cap(self):
        sid, _, _ = self.create(settings={"password": "pw"})
        other, _, _ = self.create(settings={"password": "pw"})
        self.svc.unlock_fail_delay = 0
        url = f"/api/shares/{sid}/unlock"
        # Every attempt from a different network: the per-IP limit never kicks in.
        statuses = [self.request("POST", url, headers={"X-Forwarded-For": f"2001:db8:{i:x}::1"},
                                 json_body={"password": "" if i else "wrong"}).status for i in range(31)]
        self.assertEqual(statuses, [403] * 30 + [429])
        r = self.request("POST", url, headers={"X-Forwarded-For": "198.51.100.200"}, json_body={"password": "pw"})
        self.assertEqual(r.status, 429)
        self.assertIn("retry-after", r.headers)
        r = self.request("POST", f"/api/shares/{other}/unlock", json_body={"password": "pw"})
        self.assertEqual(r.status, 200)  # other shares are unaffected

    # ------------------------------------------------------------------ comments & views

    def test_comments(self):
        sid, token, _ = self.create(duration=30)
        h = self.owner(token)
        url = f"/api/shares/{sid}/comments"
        r = self.request("POST", url, json_body={"kind": "comment", "name": "  Ada  ", "text": "  Nice\x00 work  ", "time": 12.5})
        self.assertEqual(r.status, 201)
        c = r.json
        self.assertEqual((c["kind"], c["name"], c["text"], c["emoji"], c["time"]), ("comment", "Ada", "Nice work", "", 12.5))
        self.assertRegex(c["id"], r"^[A-Za-z0-9]{6,32}$")
        self.assertIsInstance(c["createdAt"], int)
        r = self.request("POST", url, json_body={"kind": "comment", "text": "no name", "time": 9999})
        self.assertEqual((r.json["name"], r.json["time"]), ("Guest", 30.0))
        r = self.request("POST", url, json_body={"kind": "comment", "text": "neg", "time": -5})
        self.assertEqual(r.json["time"], 0.0)
        r = self.request("POST", url, json_body={"kind": "comment", "text": "no time", "time": "soon"})
        self.assertIsNone(r.json["time"])
        r = self.request("POST", url, json_body={"kind": "reaction", "emoji": "\U0001F525", "text": "ignored", "time": 3})
        self.assertEqual((r.status, r.json["text"], r.json["emoji"]), (201, "", "\U0001F525"))
        r = self.request("POST", url, json_body={"kind": "reaction", "emoji": "❤"})
        self.assertEqual(r.json["emoji"], "❤️")
        # Limits.
        self.assertEqual(self.request("POST", url, json_body={"kind": "reaction", "emoji": "\U0001F4A9"}).status, 400)
        self.assertEqual(self.request("POST", url, json_body={"kind": "comment", "text": "   "}).status, 400)
        self.assertEqual(self.request("POST", url, json_body={"kind": "comment", "text": "x" * 2001}).status, 400)
        self.assertEqual(self.request("POST", url, json_body={"kind": "shout", "text": "x"}).status, 400)
        self.assertEqual(self.request("POST", url, json_body={"kind": "comment", "text": "x" * 20000}).status, 413)
        r = self.request("POST", url, json_body={"kind": "comment", "text": "y" * 2000, "name": "Z" * 200})
        self.assertEqual((r.status, len(r.json["name"])), (201, 60))
        comments = self.request("GET", url).json["comments"]
        self.assertEqual(len(comments), 7)
        self.assertEqual([x["createdAt"] for x in comments], sorted(x["createdAt"] for x in comments))
        self.assertEqual(self.request("GET", f"/api/shares/{sid}/owner", headers=h).json["commentCount"], 7)
        # Rate limit: 10 per minute per IP (7 used above).
        statuses = [self.request("POST", url, json_body={"kind": "comment", "text": f"spam {i}"}).status for i in range(4)]
        self.assertEqual(statuses, [201, 201, 201, 429])
        r = self.request("POST", url, json_body={"kind": "comment", "text": "spam"})
        self.assertIn("retry-after", r.headers)
        # Another client behind the same reverse proxy has its own budget.
        r = self.request("POST", url, headers={"X-Forwarded-For": "198.51.100.7"}, json_body={"kind": "comment", "text": "proxied"})
        self.assertEqual(r.status, 201)
        # Owner delete.
        cid = c["id"]
        self.assertEqual(self.request("DELETE", f"{url}/{cid}").status, 401)
        self.assertEqual(self.request("DELETE", f"{url}/{cid}", headers=self.owner("nope")).status, 403)
        self.assertEqual(self.request("DELETE", f"{url}/{cid}", headers=h).status, 204)
        self.assertEqual(self.request("DELETE", f"{url}/{cid}", headers=h).status, 404)
        self.assertEqual(self.request("DELETE", f"{url}/..%2Fmeta.json", headers=h).status, 404)
        self.assertNotIn(cid, [x["id"] for x in self.request("GET", url).json["comments"]])
        # Disabled.
        self.svc.comment_limiter.reset()
        self.patch(sid, token, {"settings": {"allowComments": False}})
        r = self.request("POST", url, json_body={"kind": "comment", "text": "hello?"})
        self.assertEqual(r.status, 403)
        self.assertNotIn("limitReached", r.json)
        self.assertEqual(self.request("GET", url).json, {"comments": []})
        self.assertTrue(self.request("GET", url, headers=h).json["comments"])  # the owner still sees them
        # Full: 403 too, but flagged so the viewer doesn't treat it as "comments turned off".
        self.patch(sid, token, {"settings": {"allowComments": True}})
        saved_max = sharing.COMMENTS_MAX
        sharing.COMMENTS_MAX = len(self.request("GET", url).json["comments"])
        try:
            r = self.request("POST", url, json_body={"kind": "comment", "text": "one too many"})
        finally:
            sharing.COMMENTS_MAX = saved_max
        self.assertEqual((r.status, r.json.get("limitReached")), (403, True))

    def test_comment_storage_budget_and_polling(self):
        sid, token, _ = self.create()
        h = self.owner(token)
        url = f"/api/shares/{sid}/comments"
        path = os.path.join(self.share_dir(sid), "comments.json")
        astral = "\U0001D54F" * 2000
        body = json.dumps({"kind": "comment", "text": astral}, ensure_ascii=False).encode("utf-8")  # ~8 KB
        r = self.request("POST", url, body=body, headers={"Content-Type": "application/json"})
        self.assertEqual((r.status, r.json["text"]), (201, astral))
        self.assertLess(os.path.getsize(path), 8300)  # stored as UTF-8 (4 bytes each), not 12-byte escapes
        self.assertEqual(self.request("GET", url).json["comments"][0]["text"], astral)
        # Polling: an unchanged list is a bodiless 304.
        r1 = self.request("GET", url)
        etag = r1.headers["etag"]
        self.assertTrue(etag.startswith('W/"c'))
        r2 = self.request("GET", url, headers={"If-None-Match": etag})
        self.assertEqual((r2.status, r2.body, r2.headers["etag"]), (304, b"", etag))
        self.request("POST", url, json_body={"kind": "reaction", "emoji": "\U0001F525"})
        r3 = self.request("GET", url, headers={"If-None-Match": etag})
        self.assertEqual((r3.status, len(r3.json["comments"])), (200, 2))
        self.assertNotEqual(r3.headers["etag"], etag)
        # Byte budget: a post that would push comments.json past it is refused before parsing it.
        saved = sharing.COMMENTS_MAX_BYTES
        sharing.COMMENTS_MAX_BYTES = os.path.getsize(path) + 50
        try:
            r = self.request("POST", url, json_body={"kind": "comment", "text": "one too many"})
        finally:
            sharing.COMMENTS_MAX_BYTES = saved
        self.assertEqual((r.status, r.json.get("limitReached")), (403, True))
        self.assertEqual(len(self.request("GET", url).json["comments"]), 2)
        # Comments off: a different representation with its own tag.
        self.patch(sid, token, {"settings": {"allowComments": False}})
        r = self.request("GET", url, headers={"If-None-Match": r3.headers["etag"]})
        self.assertEqual((r.status, r.json, r.headers["etag"]), (200, {"comments": []}, 'W/"c-off"'))
        self.assertEqual(self.request("GET", url, headers={"If-None-Match": 'W/"c-off"'}).status, 304)
        r = self.request("GET", url, headers={**h, "If-None-Match": 'W/"c-off"'})
        self.assertEqual((r.status, len(r.json["comments"])), (200, 2))  # the owner still gets the list
        self.patch(sid, token, {"settings": {"allowComments": True}})
        r = self.request("GET", url, headers={"If-None-Match": 'W/"c-off"'})
        self.assertEqual((r.status, len(r.json["comments"])), (200, 2))

    def test_comment_per_share_limit(self):
        sid, _, _ = self.create()
        url = f"/api/shares/{sid}/comments"
        body = {"kind": "reaction", "emoji": "\U0001F44D"}
        statuses = [self.request("POST", url, headers={"X-Forwarded-For": f"198.51.100.{i}"}, json_body=body).status
                    for i in range(61)]
        self.assertEqual(statuses, [201] * 60 + [429])
        other, _, _ = self.create()
        r = self.request("POST", f"/api/shares/{other}/comments", headers={"X-Forwarded-For": "198.51.100.99"},
                         json_body=body)
        self.assertEqual(r.status, 201)

    def test_views_dedupe(self):
        sid, token, _ = self.create()
        url = f"/api/shares/{sid}/view"
        self.assertEqual(self.request("POST", url, json_body={"viewerId": "viewer-a"}).json, {"views": 1})
        self.assertEqual(self.request("POST", url, json_body={"viewerId": "viewer-a"}).json, {"views": 1})
        self.assertEqual(self.request("POST", url, json_body={"viewerId": "viewer-b"}).json, {"views": 2})
        self.assertEqual(self.request("POST", url, json_body={"viewerId": ""}).status, 400)
        self.assertEqual(self.request("POST", url, json_body={"viewerId": 5}).status, 400)
        self.assertEqual(self.request("POST", url, json_body={"viewerId": "v" * 201}).status, 400)
        with open(os.path.join(self.share_dir(sid), "viewers.json"), encoding="utf-8") as f:
            stored = json.load(f)
        self.assertEqual(stored, [hashlib.sha256(b"viewer-a").hexdigest(), hashlib.sha256(b"viewer-b").hexdigest()])
        self.assertEqual(self.request("GET", f"/api/shares/{sid}").json["views"], 2)

    def test_concurrent_writes_are_not_lost(self):
        sid, token, _ = self.create()
        results = []

        def view(i):
            results.append(self.request("POST", f"/api/shares/{sid}/view", json_body={"viewerId": f"viewer-{i}"}).status)

        def comment(i):
            results.append(self.request("POST", f"/api/shares/{sid}/comments",
                                        headers={"X-Forwarded-For": f"198.51.100.{i}"},
                                        json_body={"kind": "reaction", "emoji": "\U0001F44D"}).status)

        threads = [threading.Thread(target=view, args=(i,)) for i in range(25)]
        threads += [threading.Thread(target=comment, args=(i,)) for i in range(25)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(set(results)), [200, 201])
        view_ = self.request("GET", f"/api/shares/{sid}/owner", headers=self.owner(token)).json
        self.assertEqual((view_["views"], view_["commentCount"]), (25, 25))
        leftovers = [n for n in os.listdir(self.share_dir(sid)) if n.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_interrupted_chunk_rolls_back(self):
        sid, token, _ = self.create()
        h = self.owner(token)
        version = self.request("POST", f"/api/shares/{sid}/video/start", headers=h,
                               json_body={"mimeType": "video/webm", "size": len(WEBM)}).json["version"]
        sock = socket.create_connection(("127.0.0.1", self.port))
        sock.sendall((f"PUT /api/shares/{sid}/video?version={version}&offset=0 HTTP/1.1\r\n"
                      f"Host: 127.0.0.1\r\nX-Owner-Token: {token}\r\nContent-Length: 4000\r\n\r\n").encode()
                     + WEBM[:1500])
        sock.shutdown(socket.SHUT_WR)  # the uploader dies after 1500 of 4000 bytes
        sock.recv(65536)
        sock.close()
        part = os.path.join(self.share_dir(sid), f"upload-{version}.part")
        deadline = time.monotonic() + 5
        while os.path.getsize(part) != 0 and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(os.path.getsize(part), 0)
        owner = self.request("GET", f"/api/shares/{sid}/owner", headers=h).json
        self.assertEqual(owner["upload"]["received"], 0)
        r = self.request("PUT", f"/api/shares/{sid}/video?version={version}&offset=0", body=WEBM, headers=h)
        self.assertEqual(r.json, {"received": len(WEBM)})
        r = self.request("POST", f"/api/shares/{sid}/video/complete?version={version}", headers=h)
        self.assertEqual(r.json["status"], "ready")
        self.assertEqual(self.request("GET", f"/media/{sid}/video").body, WEBM)

    # ------------------------------------------------------------------ pages

    def test_template_filling_and_escaping(self):
        evil = '<script>alert("x")</script>&\'"'
        sid, token, _ = self.create(title=evil, description='desc "quoted" <b>')
        r = self.request("GET", f"/s/{sid}")
        self.assertEqual(r.status, 200)
        self.assertTrue(r.headers["content-type"].startswith("text/html"))
        self.assertEqual(r.headers["x-frame-options"], "SAMEORIGIN")
        self.assertEqual(r.headers["cache-control"], "no-store")
        page = r.text
        self.assertNotIn("<script>alert", page)
        self.assertIn("<title>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#x27;&quot;</title>", page)
        self.assertIn('content="desc &quot;quoted&quot; &lt;b&gt;"', page)
        self.assertIn(f'href="http://127.0.0.1:{self.port}/s/{sid}"', page)
        self.assertIn(f'data-share-id="{sid}" data-mode="watch"', page)
        self.assertIn('og:video" content=""', page)  # not ready yet
        self.assertIn('og:video:type" content=""', page)
        self.assertIn("{{NOT_A_PLACEHOLDER}}", page)
        self.upload(sid, token)
        self.request("PUT", f"/api/shares/{sid}/poster", body=JPEG, headers=self.owner(token))
        r = self.request("GET", f"/embed/{sid}")
        self.assertEqual(r.status, 200)
        self.assertNotIn("x-frame-options", r.headers)
        self.assertIn('data-mode="embed"', r.text)
        self.assertIn(f'og:video" content="http://127.0.0.1:{self.port}/media/{sid}/video?v=1"', r.text)
        self.assertIn('og:video:type" content="video/webm"', r.text)  # follows the uploaded bytes
        self.assertRegex(r.text, rf'og:image" content="http://127\.0\.0\.1:{self.port}/media/{sid}/poster\.jpg\?v=\d+"')
        # Password-protected: generic title, nothing leaks into meta tags.
        self.patch(sid, token, {"settings": {"password": "pw"}})
        page = self.request("GET", f"/s/{sid}").text
        self.assertIn("<title>Password-protected video</title>", page)
        self.assertNotIn("quoted", page)
        self.assertIn('og:image" content=""', page)
        self.assertIn('og:video" content=""', page)
        self.assertIn('og:video:type" content=""', page)
        self.assertEqual(self.request("HEAD", f"/s/{sid}").body, b"")
        # The template is read per request, so edits apply without a restart.
        with open(self.template_path, "w", encoding="utf-8") as f:
            f.write("<p>{{MODE}}:{{SHARE_ID}}</p>")
        try:
            self.assertEqual(self.request("GET", f"/embed/{sid}").text, f"<p>embed:{sid}</p>")
        finally:
            with open(self.template_path, "w", encoding="utf-8") as f:
                f.write(TEMPLATE)

    def test_description_hidden_when_summary_off(self):
        # The description is the summary's TL;DR: "Show summary: off" keeps it out of the page,
        # the API and link unfurls (meta/og/twitter description all use {{DESCRIPTION}}).
        sid, token, _ = self.create(description="Private TL;DR", settings={"showSummary": False})
        public = self.request("GET", f"/api/shares/{sid}").json
        self.assertEqual((public["description"], public["summary"]), ("", None))
        page = self.request("GET", f"/s/{sid}").text
        self.assertIn('<meta name="description" content="">', page)
        self.assertNotIn("Private", page)
        self.assertNotIn("Private", self.request("GET", f"/embed/{sid}").text)
        owner = self.request("GET", f"/api/shares/{sid}/owner", headers=self.owner(token)).json
        self.assertEqual(owner["description"], "Private TL;DR")  # owners see everything
        self.patch(sid, token, {"settings": {"showSummary": True}})
        self.assertEqual(self.request("GET", f"/api/shares/{sid}").json["description"], "Private TL;DR")
        self.assertIn('<meta name="description" content="Private TL;DR">', self.request("GET", f"/s/{sid}").text)

    def test_unknown_id_page_is_404(self):
        r = self.request("GET", "/s/abcdefghij")
        self.assertEqual(r.status, 404)
        self.assertTrue(r.headers["content-type"].startswith("text/html"))
        self.assertIn('data-share-id="abcdefghij"', r.text)
        self.assertIn("<title>Video not found</title>", r.text)
        for path in ("/s/..%2F..%2Fserver.py", "/embed/<script>", "/s/a/b/c", "/s/", "/embed/abc"):
            r = self.request("GET", path)
            self.assertEqual(r.status, 404, path)
            self.assertIn('data-share-id=""', r.text, path)
            self.assertNotIn("<script>", r.text.replace('<script type="module"', ""), path)

    def test_real_template_has_all_placeholders(self):
        if not os.path.exists(self.real_template_path):
            self.skipTest("public/share.html isn't there yet")
        with open(self.real_template_path, encoding="utf-8") as f:
            tpl = f.read()
        for name in ("TITLE", "DESCRIPTION", "URL", "OG_IMAGE", "OG_VIDEO", "OG_VIDEO_TYPE", "SHARE_ID", "MODE"):
            self.assertIn("{{%s}}" % name, tpl)

    def test_path_traversal(self):
        sid, token, _ = self.create()
        attempts = [
            "/api/shares/..%2F..%2Fsecret.key", "/api/shares/../../data/secret.key", "/api/shares/%2e%2e",
            "/api/shares/abc", "/api/shares/" + "a" * 17, f"/api/shares/{sid}%00", f"/api/shares/{sid}.json",
            "/media/..%2Fsecret.key/video", "/media/%2e%2e/poster.jpg", f"/media/{sid}/..%2Fmeta.json",
            f"/media/{sid}/meta.json", "/media/../secret.key", "/data/secret.key", "/../server.py",
            "/../data/secret.key", "/%2e%2e/server.py", f"/api/shares/{sid}/comments/../../owner",
        ]
        with open(os.path.join(self.svc.data_dir, "secret.key"), "rb") as f:
            secret = f.read()
        for path in attempts:
            r = self.request("GET", path)
            self.assertIn(r.status, (400, 404), path)
            self.assertNotIn(secret, r.body, path)
            self.assertNotIn(b"ownerTokenHash", r.body, path)
        r = self.request("PATCH", "/api/shares/..%2F..", headers=self.owner(token), json_body={"title": "x"})
        self.assertEqual(r.status, 404)
        r = self.request("PUT", f"/api/shares/{sid}/video?version=1&offset=-1", body=b"x", headers=self.owner(token))
        self.assertEqual(r.status, 400)
        # Ids differing only in case don't alias (macOS filesystems are case-insensitive).
        swapped = sid.swapcase() if sid.swapcase() != sid else sid
        if swapped != sid:
            self.assertEqual(self.request("GET", f"/api/shares/{swapped}").status, 404)

    def test_delete(self):
        sid, token, _ = self.create()
        self.upload(sid, token)
        self.assertEqual(self.request("DELETE", f"/api/shares/{sid}").status, 401)
        self.assertTrue(os.path.isdir(self.share_dir(sid)))
        self.assertEqual(self.request("DELETE", f"/api/shares/{sid}", headers=self.owner(token)).status, 204)
        self.assertFalse(os.path.exists(self.share_dir(sid)))
        self.assertFalse([n for n in os.listdir(self.svc.shares_dir) if n.startswith(".trash-")])
        self.assertEqual(self.request("GET", f"/api/shares/{sid}").status, 404)
        self.assertEqual(self.request("GET", f"/api/shares/{sid}/owner", headers=self.owner(token)).status, 404)
        self.assertEqual(self.request("GET", f"/media/{sid}/video?v=1").status, 404)
        self.assertEqual(self.request("GET", f"/s/{sid}").status, 404)
        self.assertEqual(self.request("DELETE", f"/api/shares/{sid}", headers=self.owner(token)).status, 404)

    # ------------------------------------------------------------------ unit-level checks

    def test_parse_range(self):
        pr = sharing.parse_range
        self.assertEqual(pr("bytes=0-0", 10), (0, 0))
        self.assertEqual(pr("bytes=3-", 10), (3, 9))
        self.assertEqual(pr("bytes=-3", 10), (7, 9))
        self.assertEqual(pr("bytes=-30", 10), (0, 9))
        self.assertEqual(pr("bytes=10-", 10), sharing._UNSATISFIABLE)
        self.assertEqual(pr("bytes=0-", 0), sharing._UNSATISFIABLE)
        self.assertIsNone(pr("bytes=5-1", 10))
        self.assertIsNone(pr("items=0-1", 10))
        self.assertIsNone(pr("bytes=-", 10))

    def test_rate_key_proxy_trust_and_ipv6_buckets(self):
        def key(svc, peer, xff=None):
            return svc._rate_key(StubHandler(peer, {"X-Forwarded-For": xff} if xff else {}))

        data = self.svc.data_dir
        self.assertEqual(sharing.ShareService(PUBLIC_DIR, data).trust_private_proxies,
                         sharing.ShareService.in_container())  # default: trusted only in a container
        lan = sharing.ShareService(PUBLIC_DIR, data, trust_private_proxies=False)
        # On a bare LAN every client is a private address: their X-Forwarded-For is ignored.
        for fake in ("203.0.113.1", "203.0.113.2", "10.9.8.7", "garbage"):
            self.assertEqual(key(lan, "192.168.1.50", fake), "192.168.1.50")
        self.assertEqual(key(lan, "fd00::5", "203.0.113.1"), "fd00::/64")
        self.assertEqual(key(lan, "198.51.100.3", "203.0.113.1"), "198.51.100.3")  # public peer: never
        self.assertEqual(key(lan, "127.0.0.1", "203.0.113.1, 203.0.113.9"), "203.0.113.9")  # local proxy: always
        self.assertEqual(key(lan, "127.0.0.1", "not-an-ip"), "127.0.0.1")
        behind = sharing.ShareService(PUBLIC_DIR, data, trust_private_proxies=True)
        self.assertEqual(key(behind, "172.17.0.1", "203.0.113.1"), "203.0.113.1")  # Docker bridge / PaaS proxy
        self.assertEqual(key(behind, "192.168.1.50", "203.0.113.2"), "203.0.113.2")
        # IPv6 clients are bucketed by /64; IPv4-mapped addresses count as IPv4.
        self.assertEqual(key(lan, "2001:db8:1:2::5"), "2001:db8:1:2::/64")
        self.assertEqual(key(lan, "127.0.0.1", "2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64")
        self.assertEqual(key(lan, "127.0.0.1", "::ffff:203.0.113.4"), "203.0.113.4")
        self.assertEqual(key(lan, "::ffff:192.0.2.1"), "192.0.2.1")

    def test_from_env_share_key_and_proxy_settings(self):
        def make(**env):
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                svc = sharing.ShareService.from_env(PUBLIC_DIR, "127.0.0.1", 8000,
                                                    environ={"DOLLY_DATA_DIR": self.svc.data_dir, **env})
            return svc, err.getvalue()

        for weak in ("change-me", "CHANGE-ME", "short", "paste-a-long-random-secret-here"):
            svc, err = make(DOLLY_SHARE_KEY=weak)
            self.assertIsNone(svc.share_key, weak)
            self.assertIn("Ignoring DOLLY_SHARE_KEY", err)
        self.assertIsNone(make(DOLLY_SHARE_KEY="   ")[0].share_key)
        good = "3f9a" * 12
        svc, err = make(DOLLY_SHARE_KEY=f" {good}\n")
        self.assertEqual((svc.share_key, err), (good, ""))
        self.assertTrue(make(DOLLY_TRUST_PROXY="1")[0].trust_private_proxies)
        self.assertTrue(make(DOLLY_TRUST_PROXY="yes")[0].trust_private_proxies)
        self.assertFalse(make(DOLLY_TRUST_PROXY="0")[0].trust_private_proxies)
        self.assertFalse(make(DOLLY_TRUST_PROXY="off")[0].trust_private_proxies)
        self.assertEqual(make()[0].trust_private_proxies, sharing.ShareService.in_container())
        svc, err = make(DOLLY_TRUST_PROXY="maybe")
        self.assertEqual(svc.trust_private_proxies, sharing.ShareService.in_container())
        self.assertIn("Ignoring DOLLY_TRUST_PROXY", err)

    def test_rate_limiter_evicts_least_recent_keys(self):
        lim = sharing.RateLimiter(2, 60)
        lim.MAX_KEYS = 3
        self.assertEqual(lim.wait("a"), 0.0)
        self.assertEqual((lim.hit("a"), lim.hit("a")), (0.0, 0.0))
        self.assertGreater(lim.hit("a"), 0)
        self.assertGreater(lim.wait("a"), 0)
        lim.hit("b")
        lim.hit("c")
        self.assertGreater(lim.hit("a"), 0)  # still throttled, and now the most recently seen
        lim.hit("d")  # table full: the least recently seen keys go, not everyone's counters
        lim.hit("e")
        self.assertEqual(list(lim._hits), ["a", "d", "e"])
        self.assertGreater(lim.wait("a"), 0)
        # wait() records nothing.
        lim2 = sharing.RateLimiter(1, 60)
        self.assertEqual((lim2.wait("x"), lim2.wait("x")), (0.0, 0.0))
        self.assertNotIn("x", lim2._hits)
        self.assertEqual(lim2.hit("x"), 0.0)
        self.assertGreater(lim2.wait("x"), 0)

    def test_dump_is_utf8(self):
        self.assertEqual(sharing._dump({"t": "é\U0001D54F"}), '{"t":"é\U0001D54F"}'.encode("utf-8"))
        self.assertEqual(sharing._dump({"t": "a\ud800b"}), b'{"t":"a?b"}')  # lone surrogate: no crash


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1, argv=[sys.argv[0]] + [a for a in sys.argv[1:] if a != "-v"])
