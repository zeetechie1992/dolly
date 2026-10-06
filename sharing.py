"""Dolly share links: storage, auth, validation, templates and Range responses.

server.py routes every request through ShareService.handle(handler) first; it returns
False for paths that aren't share routes. Python 3.9 standard library only.

Storage (one directory per share, see ARCHITECTURE.md -> Sharing):
    <data>/secret.key                      32 random bytes (HMAC key for access tokens), 0600
    <data>/shares/<id>/meta.json           ShareMeta (atomic tmp + fsync + rename writes)
    <data>/shares/<id>/video-<v>.<ext>     the ready video (older versions deleted on complete)
    <data>/shares/<id>/upload-<v>.part     upload in progress
    <data>/shares/<id>/poster.jpg
    <data>/shares/<id>/comments.json       [Comment]
    <data>/shares/<id>/viewers.json        [sha256(viewerId) hex], capped at 100k

Concurrency: every read-modify-write of a share's JSON files happens under that share's
`meta` lock; upload steps (start / chunk / complete / fail) also serialize on its `upload`
lock, which is always taken before `meta`. Readers never lock: writes are atomic renames.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import html
import ipaddress
import json
import math
import os
import re
import secrets
import shutil
import socket
import string
import sys
import threading
import time
import traceback
from collections import OrderedDict, deque
from urllib.parse import parse_qs, quote, urlsplit

# --------------------------------------------------------------------------------------
# Limits & constants
# --------------------------------------------------------------------------------------

ID_RE = re.compile(r"[A-Za-z0-9]{6,16}")
COMMENT_ID_RE = re.compile(r"[A-Za-z0-9]{6,32}")
ID_ALPHABET = string.ascii_letters + string.digits
ID_LENGTH = 10
COMMENT_ID_LENGTH = 12

KB = 1024
MB = 1024 * 1024
META_BODY_LIMIT = 2 * MB          # create / patch
COMMENT_BODY_LIMIT = 16 * KB
SMALL_BODY_LIMIT = 8 * KB         # unlock, view, video/start, video/fail
CHUNK_LIMIT = 16 * MB             # one PUT of video bytes
POSTER_LIMIT = 5 * MB
DRAIN_LIMIT = CHUNK_LIMIT + MB    # unread request bodies up to this size are drained before closing
UPLOAD_BLOCK = 1 * MB             # chunk bodies are copied to disk in blocks of this size
STREAM_BLOCK = 256 * KB           # video responses are streamed in blocks of this size
DISK_HEADROOM = 64 * MB

TITLE_MAX = 200
DESCRIPTION_MAX = 500
OWNER_NAME_MAX = 60
TRANSCRIPT_MAX_SEGMENTS = 20000
SEGMENT_TEXT_MAX = 2000
SUMMARY_TITLE_MAX = 200
SUMMARY_TLDR_MAX = 2000
SUMMARY_ITEM_MAX = 1000
SUMMARY_LIST_MAX = 50
CHAPTERS_MAX = 200
COMMENT_TEXT_MAX = 2000
COMMENT_NAME_MAX = 60
COMMENTS_MAX = 5000
COMMENTS_MAX_BYTES = 2 * MB       # comments.json size cap (bounds every GET/POST parse of it)
COMMENT_TIME_SLACK = 0.05         # re-timed comments this close past an edge are clamped, not untimed
PASSWORD_MAX = 256
VIEWER_ID_MAX = 200
VIEWERS_MAX = 100_000
MAX_DURATION = 24 * 3600.0
MAX_DIMENSION = 16384

PBKDF2_ITERATIONS = 200_000
ACCESS_TTL = 7 * 24 * 3600
UNLOCK_FAIL_DELAY = 0.6
SHARE_KEY_MIN = 16
SHARE_KEY_PLACEHOLDERS = ("change-me", "paste-a-long-random-secret-here")

CAPTION_STYLE_IDS = ("minimal", "clean", "bold", "karaoke", "subtitle", "glass")
CAPTION_POSITIONS = ("bottom", "middle", "top")
CAPTION_SIZES = ("S", "M", "L")
ASPECTS = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350)}
CAMERA_SHAPES = ("circle", "rounded", "square")
VIDEO_TYPES = {"video/mp4": "mp4", "video/webm": "webm"}
REACTIONS = ("\U0001F44D", "❤️", "\U0001F602", "\U0001F389", "\U0001F62E", "\U0001F525")
BOOL_SETTINGS = ("allowDownload", "showSummary", "showTranscript", "allowComments")
DEFAULT_SETTINGS = {"allowDownload": False, "showSummary": True, "showTranscript": True,
                    "allowComments": True, "password": None}
DEFAULT_CAPTIONS = {"enabled": False, "style": "minimal", "position": "bottom", "size": "M", "burned": False}
DEFAULT_TITLE = "Untitled video"

SHARE_PREFIXES = ("/api/shares/", "/media/", "/s/", "/embed/")
SHARE_PATHS = ("/api/share-config", "/api/shares")

DISCONNECT_ERRORS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socket.timeout)

_PLACEHOLDER_RE = re.compile(r"\{\{([A-Z_]+)\}\}")
_CTRL_RE = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f‪-‮⁦-⁩]")
_DIGITS_RE = re.compile(r"[0-9]{1,15}")
_HOST_RE = re.compile(r"(?:[A-Za-z0-9_-]{1,63}(?:\.[A-Za-z0-9_-]{1,63})*\.?|\[[0-9A-Fa-f:.]{2,45}\])(?::[0-9]{1,5})?")
_RANGE_RE = re.compile(r"\s*bytes\s*=\s*([0-9]{0,18})\s*-\s*([0-9]{0,18})\s*")
_UNSATISFIABLE = "unsatisfiable"
_TRUE_WORDS = ("1", "true", "yes", "on")
_FALSE_WORDS = ("0", "false", "no", "off")

# At most this many password checks (PBKDF2, ~0.1 s of CPU each) run at once, so unlock
# floods can't starve every other request of CPU.
_PBKDF2_SLOTS = threading.BoundedSemaphore(max(1, (os.cpu_count() or 2) // 2))

FALLBACK_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}}</title>
<meta name="description" content="{{DESCRIPTION}}">
<link rel="canonical" href="{{URL}}">
<meta property="og:title" content="{{TITLE}}">
<meta property="og:description" content="{{DESCRIPTION}}">
<meta property="og:url" content="{{URL}}">
<meta property="og:image" content="{{OG_IMAGE}}">
<meta property="og:video" content="{{OG_VIDEO}}">
<meta property="og:video:type" content="{{OG_VIDEO_TYPE}}">
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/base.css">
<link rel="stylesheet" href="/css/viewer.css">
</head>
<body data-share-id="{{SHARE_ID}}" data-mode="{{MODE}}">
<script type="module" src="/js/share/viewer.js"></script>
</body>
</html>
"""


class ApiError(Exception):
    """An error response: JSON `{ error, ...extra }` with `status` (and optional headers)."""

    def __init__(self, status: int, message: str, headers: dict | None = None, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.headers = headers or {}
        self.extra = extra


# --------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------

def now_ms() -> int:
    return int(time.time() * 1000)


def _random_id(length: int) -> str:
    return "".join(secrets.choice(ID_ALPHABET) for _ in range(length))


def valid_id(value) -> bool:
    return isinstance(value, str) and ID_RE.fullmatch(value) is not None


def _is_num(value) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(float(value))
    except OverflowError:
        return False


def _num(value, lo: float, hi: float, field: str, default: float | None = None) -> float:
    if value is None and default is not None:
        return default
    if not _is_num(value):
        raise ApiError(400, f"{field} must be a number.")
    return min(hi, max(lo, float(value)))


def _int(value, lo: int, hi: int, field: str, default: int | None = None) -> int:
    if value is None and default is not None:
        return default
    if not _is_num(value):
        raise ApiError(400, f"{field} must be a number.")
    return int(min(hi, max(lo, round(float(value)))))


def _bool(value, field: str, default: bool | None = None) -> bool:
    if value is None and default is not None:
        return default
    if not isinstance(value, bool):
        raise ApiError(400, f"{field} must be true or false.")
    return value


def _clean_text(value, limit: int, field: str, multiline: bool = False, strict: bool = False) -> str:
    """Type-checks, strips control/bidi-override characters, normalizes whitespace, trims and
    truncates to `limit` characters (or rejects longer text when `strict`)."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ApiError(400, f"{field} must be a string.")
    if len(value) > limit * 8 + 1024:  # don't even normalize absurdly long input
        if strict:
            raise ApiError(400, f"{field} is too long (max {limit} characters).", maxLength=limit)
        value = value[: limit * 8 + 1024]
    value = value.encode("utf-8", "replace").decode("utf-8")  # lone surrogates -> '?'
    if multiline:
        value = value.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " ")
        value = _CTRL_RE.sub("", value)
        value = "\n".join(line.strip() for line in value.split("\n"))
        value = re.sub(r"\n{3,}", "\n\n", value)
    else:
        value = _CTRL_RE.sub("", value)
        value = re.sub(r"\s+", " ", value)
    value = value.strip()
    if len(value) > limit:
        if strict:
            raise ApiError(400, f"{field} is too long (max {limit} characters).", maxLength=limit)
        value = value[:limit].rstrip()
    return value


def _soft_text(value, limit: int, multiline: bool = False) -> str:
    """Like _clean_text but returns '' for non-strings (used inside lists we filter)."""
    if not isinstance(value, str):
        return ""
    return _clean_text(value, limit, "text", multiline=multiline)


def _parse_int(text: str):
    if len(text) > 30:
        raise ValueError("number too long")
    return int(text)


def _parse_float(text: str):
    if len(text) > 64:
        raise ValueError("number too long")
    return float(text)


def _bad_constant(name: str):
    raise ValueError(f"{name} is not valid JSON")


def _qint(qs: dict, key: str) -> int:
    value = qs.get(key)
    if value is None or not _DIGITS_RE.fullmatch(value):
        raise ApiError(400, f"Query parameter '{key}' must be a non-negative integer.")
    return int(value)


def _split_host(host: str):
    """'example.com:8000' -> ('example.com', '8000'); '[::1]:80' -> ('::1', '80')."""
    host = (host or "").strip()
    if host.startswith("["):
        end = host.find("]")
        if end == -1:
            return host, ""
        rest = host[end + 1:]
        return host[1:end], rest[1:] if rest.startswith(":") else ""
    if host.count(":") == 1:
        name, port = host.split(":")
        return name, port
    return host, ""


def _is_loopback_name(name: str) -> bool:
    n = (name or "").strip().lower().rstrip(".")
    if n.startswith("[") and n.endswith("]"):
        n = n[1:-1]
    if n == "localhost" or n.endswith(".localhost"):
        return True
    try:
        ip = ipaddress.ip_address(n.split("%")[0])
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback or ip.is_unspecified


def _peer_ip(handler):
    try:
        raw = str(handler.client_address[0]).split("%")[0]
        ip = ipaddress.ip_address(raw)
    except (ValueError, IndexError, TypeError):
        return None
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip


_SHARED_SPACE = ipaddress.ip_network("100.64.0.0/10")  # RFC 6598; cloud edge proxies (e.g. Railway) connect from here


def _is_internal(ip) -> bool:
    """A non-public peer that may be our own reverse proxy: RFC 1918 / ULA / link-local, plus RFC 6598
    shared address space, which Python 3.12+ no longer reports as is_private."""
    return ip.is_private or (ip.version == 4 and ip in _SHARED_SPACE)


def _ip_bucket(ip) -> str:
    """Rate-limit bucket for an address: IPv4 as is, IPv6 by /64 (one subscriber or VPS gets a
    whole /64, so single addresses would be free fresh buckets)."""
    if ip.version == 6:
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        return str(ipaddress.IPv6Network((int(ip) >> 64 << 64, 64)))
    return str(ip)


def _is_proxied(handler) -> bool:
    return any(handler.headers.get(k) for k in ("X-Forwarded-For", "Forwarded", "X-Real-IP"))


def _write_atomic(path: str, data: bytes) -> None:
    """Write tmp -> fsync -> os.replace, so readers see either the old or the new file."""
    tmp = f"{path}.{secrets.token_hex(6)}.tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _dump(obj) -> bytes:
    # Real UTF-8, not \uXXXX escapes (an astral character would cost 12 bytes instead of 4);
    # a lone surrogate in a field that skipped _clean_text becomes '?' instead of raising.
    return json.dumps(obj, allow_nan=False, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "replace")


def _sniff_video(head: bytes):
    """The container type from the first bytes, or None."""
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "video/webm"
    if head[4:8] in (b"ftyp", b"styp", b"moov", b"mdat", b"free", b"wide"):
        return "video/mp4"
    return None


def _attachment_header(title: str, ext: str) -> str:
    ascii_name = re.sub(r"[^A-Za-z0-9 ._-]+", "", title or "").strip(" .")[:80] or "video"
    utf8_name = quote(((title or "").strip() or "video")[:120], safe="")
    return f"attachment; filename=\"{ascii_name}.{ext}\"; filename*=UTF-8''{utf8_name}.{ext}"


def parse_range(header: str, size: int):
    """Single byte range -> (start, end) inclusive; None = ignore the header and send the
    whole file (malformed or multi-range); _UNSATISFIABLE -> 416."""
    m = _RANGE_RE.fullmatch(header or "")
    if not m:
        return None
    first, last = m.groups()
    if first == "" and last == "":
        return None
    if first == "":  # suffix range: the last N bytes
        n = int(last)
        if n == 0 or size == 0:
            return _UNSATISFIABLE
        return max(0, size - n), size - 1
    start = int(first)
    end = int(last) if last != "" else size - 1
    if last != "" and end < start:
        return None
    if start >= size:
        return _UNSATISFIABLE
    return start, min(end, size - 1)


class RateLimiter:
    """Sliding-window limiter: at most `limit` hits per `window` seconds per key (in memory).
    Keys are kept least-recently-seen first; when the table is full the stalest keys are
    evicted (a flood of fresh keys never wipes the counters of clients already throttled)."""

    MAX_KEYS = 20000

    def __init__(self, limit: int, window: float):
        self.limit = limit
        self.window = window
        self._hits: OrderedDict = OrderedDict()
        self._lock = threading.Lock()

    def hit(self, key: str) -> float:
        """Records a hit; returns 0 when allowed, else the seconds until the next one is."""
        now = time.monotonic()
        with self._lock:
            q = self._hits.get(key)
            if q is None:
                if len(self._hits) >= self.MAX_KEYS:
                    self._prune(now)
                q = self._hits[key] = deque()
            else:
                self._hits.move_to_end(key)  # a throttled client that keeps knocking stays recent
            while q and now - q[0] >= self.window:
                q.popleft()
            if len(q) >= self.limit:
                return max(0.1, self.window - (now - q[0]))
            q.append(now)
            return 0.0

    def wait(self, key: str) -> float:
        """Like hit() but records nothing: 0 when a hit would be allowed, else the seconds to wait."""
        now = time.monotonic()
        with self._lock:
            q = self._hits.get(key)
            while q and now - q[0] >= self.window:
                q.popleft()
            return max(0.1, self.window - (now - q[0])) if q and len(q) >= self.limit else 0.0

    def _prune(self, now: float) -> None:
        hits = self._hits
        while hits:  # expired keys sit at the front (least recently seen)
            q = next(iter(hits.values()))
            if q and now - q[-1] < self.window:
                break
            hits.popitem(last=False)
        while len(hits) >= self.MAX_KEYS:  # still full: evict the least recently seen
            hits.popitem(last=False)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


class _ShareLocks:
    """Per-share locks. Only requested for shares that exist (callers load the meta first), so
    the registry stays bounded by the number of shares."""

    __slots__ = ("meta", "upload")

    def __init__(self):
        self.meta = threading.RLock()
        self.upload = threading.Lock()


class _Body:
    """The request body, read at most once, never beyond Content-Length."""

    def __init__(self, handler):
        self.handler = handler
        self.length = 0
        self.remaining = 0
        self.declared = False
        te = handler.headers.get("Transfer-Encoding")
        if te and te.strip().lower() != "identity":
            handler.close_connection = True
            raise ApiError(411, "Send the body with a Content-Length (chunked encoding isn't supported).")
        cl = handler.headers.get("Content-Length")
        if cl is not None:
            cl = cl.strip()
            if not _DIGITS_RE.fullmatch(cl):
                handler.close_connection = True
                raise ApiError(400, "Invalid Content-Length.")
            self.length = int(cl)
            self.remaining = self.length
            self.declared = True

    def read(self, n: int) -> bytes:
        n = min(n, self.remaining)
        if n <= 0:
            return b""
        data = self.handler.rfile.read(n)
        if len(data) < n:  # client closed early
            self.remaining = 0
        else:
            self.remaining -= len(data)
        return data

    def read_all(self) -> bytes:
        data = self.read(self.length)
        if len(data) < self.length:
            raise ApiError(400, "The request body was cut off.")
        return data

    def finish(self) -> None:
        """Drain what the handler didn't read (so the client sees our response instead of a
        connection reset), unless it's too big to bother."""
        if self.remaining <= 0:
            return
        if self.remaining > DRAIN_LIMIT:
            self.handler.close_connection = True
            return
        try:
            while self.remaining > 0:
                if not self.read(min(UPLOAD_BLOCK, self.remaining)):
                    break
        except (OSError, ValueError):
            pass
        self.handler.close_connection = True


# --------------------------------------------------------------------------------------
# Validation of client-supplied share metadata
# --------------------------------------------------------------------------------------

def clean_transcript(value, duration: float = 0.0) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ApiError(400, "transcript must be a list.")
    if len(value) > TRANSCRIPT_MAX_SEGMENTS:
        raise ApiError(400, f"transcript is too long (max {TRANSCRIPT_MAX_SEGMENTS} segments).")
    out = []
    for seg in value:
        if not isinstance(seg, dict) or not _is_num(seg.get("start")):
            continue
        start = min(MAX_DURATION, max(0.0, float(seg["start"])))
        end = float(seg["end"]) if _is_num(seg.get("end")) else start
        end = min(MAX_DURATION, max(start, end))
        if duration > 0:
            if start > duration:
                continue
            end = min(end, duration)
        text = _soft_text(seg.get("text"), SEGMENT_TEXT_MAX)
        if not text:
            continue
        out.append({"start": round(start, 3), "end": round(end, 3), "text": text})
    out.sort(key=lambda s: (s["start"], s["end"]))
    return out


def _clean_str_list(value, max_items: int, max_len: int) -> list:
    if not isinstance(value, list):
        return []
    out = []
    for item in value[: max_items * 4]:
        text = _soft_text(item, max_len)
        if text:
            out.append(text)
        if len(out) >= max_items:
            break
    return out


def clean_summary(value, duration: float = 0.0):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ApiError(400, "summary must be an object or null.")
    chapters = []
    raw_chapters = value.get("chapters")
    if isinstance(raw_chapters, list):
        for ch in raw_chapters[: CHAPTERS_MAX * 4]:
            if not isinstance(ch, dict) or not _is_num(ch.get("start")):
                continue
            start = min(MAX_DURATION, max(0.0, float(ch["start"])))
            if duration > 0 and start > duration:
                continue
            title = _soft_text(ch.get("title"), SUMMARY_TITLE_MAX)
            if not title:
                continue
            chapters.append({"start": round(start, 3), "title": title})
            if len(chapters) >= CHAPTERS_MAX:
                break
        chapters.sort(key=lambda c: c["start"])
    generated = value.get("generatedAt")
    model = value.get("model")
    thash = value.get("transcriptHash")
    return {
        "title": _soft_text(value.get("title"), SUMMARY_TITLE_MAX),
        "tldr": _soft_text(value.get("tldr"), SUMMARY_TLDR_MAX, multiline=True),
        "key_points": _clean_str_list(value.get("key_points"), SUMMARY_LIST_MAX, SUMMARY_ITEM_MAX),
        "action_items": _clean_str_list(value.get("action_items"), SUMMARY_LIST_MAX, SUMMARY_ITEM_MAX),
        "chapters": chapters,
        "source": "ai" if value.get("source") == "ai" else "local",
        "model": _soft_text(model, 100) or None,
        "generatedAt": int(min(1e15, max(0.0, float(generated)))) if _is_num(generated) else None,
        "transcriptHash": _soft_text(thash, 128) or None,
    }


def clean_captions(value) -> dict:
    if value is None:
        return dict(DEFAULT_CAPTIONS)
    if not isinstance(value, dict):
        raise ApiError(400, "captions must be an object.")
    return {
        "enabled": _bool(value.get("enabled"), "captions.enabled", False),
        "style": value.get("style") if value.get("style") in CAPTION_STYLE_IDS else "minimal",
        "position": value.get("position") if value.get("position") in CAPTION_POSITIONS else "bottom",
        "size": value.get("size") if value.get("size") in CAPTION_SIZES else "M",
        "burned": _bool(value.get("burned"), "captions.burned", False),
    }


def clean_layout(value) -> dict:
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise ApiError(400, "layout must be an object.")
    aspect = value.get("aspect") if value.get("aspect") in ASPECTS else "16:9"
    dw, dh = ASPECTS[aspect]
    width = _int(value.get("width"), 1, MAX_DIMENSION, "layout.width", dw)
    height = _int(value.get("height"), 1, MAX_DIMENSION, "layout.height", dh)
    camera = None
    cam = value.get("camera")
    if isinstance(cam, dict) and all(_is_num(cam.get(k)) for k in ("x", "y", "size")):
        camera = {
            "x": round(min(MAX_DIMENSION, max(-MAX_DIMENSION, float(cam["x"]))), 2),
            "y": round(min(MAX_DIMENSION, max(-MAX_DIMENSION, float(cam["y"]))), 2),
            "size": round(min(MAX_DIMENSION, max(0.0, float(cam["size"]))), 2),
            "shape": cam.get("shape") if cam.get("shape") in CAMERA_SHAPES else "circle",
        }
    return {"aspect": aspect, "width": width, "height": height, "camera": camera}


def hash_password(password: str) -> dict:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8", "replace"), salt, PBKDF2_ITERATIONS)
    return {"salt": salt.hex(), "hash": digest.hex()}


def check_password(password: str, record: dict) -> bool:
    try:
        salt = bytes.fromhex(record["salt"])
        expected = bytes.fromhex(record["hash"])
    except (KeyError, TypeError, ValueError):
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8", "replace"), salt, PBKDF2_ITERATIONS)
    return hmac.compare_digest(digest, expected)


def clean_settings_patch(value) -> dict:
    """Validated settings changes. `password` (when present) is already hashed, or None to clear."""
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ApiError(400, "settings must be an object.")
    out = {}
    for key in BOOL_SETTINGS:
        if key in value:
            out[key] = _bool(value[key], f"settings.{key}")
    if "password" in value:
        pw = value["password"]
        if pw is None or pw == "":
            out["password"] = None
        elif isinstance(pw, str):
            if len(pw) > PASSWORD_MAX:
                raise ApiError(400, f"The password is too long (max {PASSWORD_MAX} characters).")
            out["password"] = hash_password(pw)
        else:
            raise ApiError(400, "settings.password must be a string or null.")
    return out


def clean_share_fields(data: dict, partial: bool) -> dict:
    """Validated top-level share fields. With `partial`, only fields present in `data`.
    Transcript/summary are clipped to the duration later (it may change in the same request)."""
    out = {}

    def wanted(key):
        return (not partial) or key in data

    if wanted("title"):
        out["title"] = _clean_text(data.get("title"), TITLE_MAX, "title") or DEFAULT_TITLE
    if wanted("description"):
        out["description"] = _clean_text(data.get("description"), DESCRIPTION_MAX, "description", multiline=True)
    if wanted("ownerName"):
        out["ownerName"] = _clean_text(data.get("ownerName"), OWNER_NAME_MAX, "ownerName")
    if wanted("duration"):
        out["duration"] = round(_num(data.get("duration"), 0.0, MAX_DURATION, "duration", 0.0), 3)
    if wanted("summary"):
        out["summary"] = clean_summary(data.get("summary"))
    if wanted("transcript"):
        out["transcript"] = clean_transcript(data.get("transcript"))
    if wanted("captions"):
        out["captions"] = clean_captions(data.get("captions"))
    if wanted("layout"):
        out["layout"] = clean_layout(data.get("layout"))
    return out


# --------------------------------------------------------------------------------------
# The service
# --------------------------------------------------------------------------------------

class ShareService:
    """All share routes. Create one per process; call handle(handler) for every request."""

    def __init__(self, public_dir: str, data_dir: str, host: str = "127.0.0.1", port: int = 8000,
                 public_url: str | None = None, share_key: str | None = None, max_upload_mb: float = 4096,
                 trust_private_proxies: bool | None = None):
        self.public_dir = os.path.abspath(public_dir)
        self.template_path = os.path.join(self.public_dir, "share.html")
        self.data_dir = os.path.abspath(data_dir)
        self.shares_dir = os.path.join(self.data_dir, "shares")
        self.host = host
        self.port = port
        self.public_url = public_url
        self.share_key = share_key or None
        self.max_upload_bytes = int(max_upload_mb * MB)
        # X-Forwarded-For from a private (non-loopback) peer is only believed in a container
        # (Docker bridge / PaaS proxy in front) or when the operator says so; on a bare LAN any
        # device could otherwise pick its own rate-limit bucket.
        self.trust_private_proxies = self.in_container() if trust_private_proxies is None else bool(trust_private_proxies)
        self.unlock_fail_delay = UNLOCK_FAIL_DELAY
        self.comment_limiter = RateLimiter(10, 60)
        self.comment_share_limiter = RateLimiter(60, 60)    # keys: share ids (bounded)
        self.unlock_limiter = RateLimiter(20, 60)
        self.unlock_share_limiter = RateLimiter(30, 600)    # failed unlocks per share id
        self.view_limiter = RateLimiter(120, 60)
        self.key_limiter = RateLimiter(10, 60)              # share creations while a key is set
        self._secret: bytes | None = None
        self._init_lock = threading.Lock()
        self._locks: dict = {}
        self._locks_guard = threading.Lock()
        self._lan_cache = (0.0, "")
        self._routes = self._build_routes()

    @classmethod
    def from_env(cls, public_dir: str, host: str, port: int, environ=None) -> "ShareService":
        env = os.environ if environ is None else environ
        repo = os.path.dirname(os.path.abspath(public_dir))
        data_dir = env.get("DOLLY_DATA_DIR") or os.path.join(repo, "data")
        public_url = None
        raw_url = (env.get("DOLLY_PUBLIC_URL") or "").strip().rstrip("/")
        if raw_url:
            parts = urlsplit(raw_url)
            if parts.scheme in ("http", "https") and parts.netloc and _HOST_RE.fullmatch(parts.netloc):
                public_url = raw_url
            else:
                sys.stderr.write(f"[dolly] Ignoring DOLLY_PUBLIC_URL={raw_url!r}: use e.g. https://dolly.example.com\n")
        max_mb = 4096.0
        raw_max = (env.get("DOLLY_MAX_UPLOAD_MB") or "").strip()
        if raw_max:
            try:
                max_mb = float(raw_max)
                if not math.isfinite(max_mb) or max_mb <= 0:
                    raise ValueError
            except ValueError:
                max_mb = 4096.0
                sys.stderr.write(f"[dolly] Ignoring DOLLY_MAX_UPLOAD_MB={raw_max!r}: expected a positive number.\n")
        share_key = (env.get("DOLLY_SHARE_KEY") or "").strip() or None
        if share_key and (len(share_key) < SHARE_KEY_MIN or share_key.lower() in SHARE_KEY_PLACEHOLDERS):
            sys.stderr.write("[dolly] Ignoring DOLLY_SHARE_KEY: use a long random secret (e.g. openssl rand -hex 24). "
                             "Only this computer can create links.\n")
            share_key = None
        raw_tp = (env.get("DOLLY_TRUST_PROXY") or "").strip().lower()
        trust = True if raw_tp in _TRUE_WORDS else False if raw_tp in _FALSE_WORDS else None
        if raw_tp and trust is None:
            sys.stderr.write(f"[dolly] Ignoring DOLLY_TRUST_PROXY={raw_tp!r}: expected 1 or 0.\n")
        return cls(public_dir, data_dir, host=host, port=port, public_url=public_url,
                   share_key=share_key, max_upload_mb=max_mb, trust_private_proxies=trust)

    # ---------------------------------------------------------------- storage

    def init_storage(self) -> None:
        """Creates the data directory and secret.key (0600) if needed. Idempotent."""
        with self._init_lock:
            if self._secret is not None:
                return
            os.makedirs(self.shares_dir, mode=0o700, exist_ok=True)
            path = os.path.join(self.data_dir, "secret.key")
            secret = b""
            try:
                with open(path, "rb") as f:
                    secret = f.read()
            except FileNotFoundError:
                pass
            if len(secret) < 32:
                secret = secrets.token_bytes(32)
                tmp = path + ".tmp"
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "wb") as f:
                    f.write(secret)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, path)
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
            self._secret = secret
            self._sweep_trash()

    @property
    def secret(self) -> bytes:
        if self._secret is None:
            self.init_storage()
        return self._secret  # type: ignore[return-value]

    def _sweep_trash(self) -> None:
        try:
            for name in os.listdir(self.shares_dir):
                if name.startswith(".trash-"):
                    shutil.rmtree(os.path.join(self.shares_dir, name), ignore_errors=True)
        except OSError:
            pass

    def _dir(self, sid: str) -> str:
        if not valid_id(sid):  # belt and braces: every caller validated already
            raise ApiError(404, "Share not found.")
        return os.path.join(self.shares_dir, sid)

    def _path(self, sid: str, name: str) -> str:
        return os.path.join(self._dir(sid), name)

    def _locks_for(self, sid: str) -> _ShareLocks:
        with self._locks_guard:
            locks = self._locks.get(sid)
            if locks is None:
                locks = _ShareLocks()
                self._locks[sid] = locks
            return locks

    def read_meta(self, sid: str):
        """The share's meta, or None if it doesn't exist."""
        if not valid_id(sid):
            return None
        try:
            with open(self._path(sid, "meta.json"), "rb") as f:
                meta = json.loads(f.read().decode("utf-8"))
        except (FileNotFoundError, NotADirectoryError):
            return None
        if not isinstance(meta, dict) or meta.get("id") != sid:  # case-insensitive filesystems
            return None
        return meta

    def _load(self, sid: str) -> dict:
        meta = self.read_meta(sid)
        if meta is None:
            raise ApiError(404, "This share link doesn't exist.")
        return meta

    def _save_meta(self, sid: str, meta: dict) -> None:
        try:
            _write_atomic(self._path(sid, "meta.json"), _dump(meta))
        except (FileNotFoundError, NotADirectoryError):
            raise ApiError(404, "This share link doesn't exist.")

    def _read_list(self, sid: str, name: str) -> list:
        try:
            with open(self._path(sid, name), "rb") as f:
                data = json.loads(f.read().decode("utf-8"))
        except (FileNotFoundError, NotADirectoryError):
            return []
        return data if isinstance(data, list) else []

    def _write_list(self, sid: str, name: str, items: list) -> None:
        try:
            _write_atomic(self._path(sid, name), _dump(items))
        except (FileNotFoundError, NotADirectoryError):
            raise ApiError(404, "This share link doesn't exist.")

    def _remove_files(self, sid: str, keep: str | None = None, videos: bool = True) -> None:
        """Deletes upload-*.part files (and video-*.* files when `videos`), except `keep`."""
        try:
            names = os.listdir(self._dir(sid))
        except OSError:
            return
        for name in names:
            if name == keep:
                continue
            if re.fullmatch(r"upload-[0-9]+\.part", name) or (videos and re.fullmatch(r"video-[0-9]+\.(?:mp4|webm)", name)):
                try:
                    os.unlink(os.path.join(self._dir(sid), name))
                except OSError:
                    pass

    # ---------------------------------------------------------------- network identity

    def _lan_ip(self) -> str:
        """This machine's LAN address (UDP connect sends no packets), cached for a minute."""
        stamp, ip = self._lan_cache
        now = time.monotonic()
        if stamp and now - stamp < 60:
            return ip
        ip = ""
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                s.connect(("10.255.255.255", 1))
                ip = s.getsockname()[0]
            finally:
                s.close()
        except OSError:
            ip = ""
        if ip.startswith("127.") or ip == "0.0.0.0":
            ip = ""
        self._lan_cache = (now, ip)
        return ip

    def _bound_to_all(self) -> bool:
        return self.host in ("0.0.0.0", "::", "")

    @staticmethod
    def in_container() -> bool:
        """Inside Docker/Podman the "LAN" address is the container's private one, useless to others."""
        return os.path.exists("/.dockerenv") or os.path.exists("/run/.containerenv")

    def public_base(self, handler) -> str:
        """Origin for absolute links: DOLLY_PUBLIC_URL, else scheme + Host (LAN IP when the Host
        is localhost but the server listens on every interface)."""
        if self.public_url:
            return self.public_url
        proto = (handler.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        scheme = proto if proto in ("http", "https") else "http"
        host = (handler.headers.get("Host") or "").strip()
        if not _HOST_RE.fullmatch(host):
            host = f"localhost:{self.port}"
        name, port = _split_host(host)
        if _is_loopback_name(name) and self._bound_to_all() and not self.in_container():
            lan = self._lan_ip()
            if lan:
                host = lan + (f":{port}" if port else "")
        return f"{scheme}://{host}"

    @staticmethod
    def is_local_base(base: str) -> bool:
        try:
            return _is_loopback_name(urlsplit(base).hostname or "")
        except ValueError:
            return True

    def is_loopback_client(self, handler) -> bool:
        """A request from this machine, not relayed by a proxy/tunnel, addressed to a loopback
        host name (the Host check blocks DNS-rebinding pages from creating shares), and not sent
        by another site's page (Sec-Fetch-Site / Origin). Only trusted while no share key is set."""
        ip = _peer_ip(handler)
        if ip is None or not ip.is_loopback or _is_proxied(handler):
            return False
        host = (handler.headers.get("Host") or "").strip()
        if not host or not _is_loopback_name(_split_host(host)[0]):
            return False
        site = (handler.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if site and site not in ("same-origin", "none"):
            return False
        origin = (handler.headers.get("Origin") or "").strip()
        if origin:
            try:
                if urlsplit(origin).netloc.lower() != host.lower():
                    return False
            except ValueError:
                return False
        return True

    def _key_ok(self, handler) -> bool:
        if not self.share_key:
            return False
        given = handler.headers.get("X-Dolly-Key") or ""
        if not given:
            return False
        return hmac.compare_digest(given.encode("utf-8", "replace"), self.share_key.encode("utf-8", "replace"))

    def _rate_key(self, handler) -> str:
        """Client bucket for rate limiting (IPv4 address, or IPv6 /64). X-Forwarded-For (its
        right-most entry, the one our proxy appended) is believed from a loopback peer, or from a
        private peer only when running in a container or with DOLLY_TRUST_PROXY=1."""
        ip = _peer_ip(handler)
        xff = handler.headers.get("X-Forwarded-For")
        if ip is not None and xff and (ip.is_loopback or (_is_internal(ip) and self.trust_private_proxies)):
            try:
                return _ip_bucket(ipaddress.ip_address(xff.split(",")[-1].strip()))
            except ValueError:
                pass
        return _ip_bucket(ip) if ip is not None else "unknown"

    # ---------------------------------------------------------------- auth

    def _is_owner(self, handler, meta: dict) -> bool:
        token = handler.headers.get("X-Owner-Token") or ""
        if not token or len(token) > 512:
            return False
        digest = hashlib.sha256(token.encode("utf-8", "replace")).hexdigest()
        return hmac.compare_digest(digest, str(meta.get("ownerTokenHash") or ""))

    def _require_owner(self, handler, meta: dict) -> None:
        if not handler.headers.get("X-Owner-Token"):
            raise ApiError(401, "Only the owner of this link can do that (missing owner token).")
        if not self._is_owner(handler, meta):
            raise ApiError(403, "Only the owner of this link can do that.")

    def _access_mac(self, meta: dict, expiry: int) -> bytes:
        # Bound to the share id and its password salt (not the video version), so changing or
        # removing the password revokes every access token handed out before.
        salt = ((meta.get("settings") or {}).get("password") or {}).get("salt", "")
        msg = f"{meta['id']}|{salt}|{expiry}".encode("utf-8")
        return hmac.new(self.secret, msg, hashlib.sha256).digest()

    def make_access(self, meta: dict, ttl: int = ACCESS_TTL) -> str:
        expiry = int(time.time()) + ttl
        raw = expiry.to_bytes(8, "big") + self._access_mac(meta, expiry)
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    def verify_access(self, meta: dict, token: str) -> bool:
        if not token or len(token) > 128 or not re.fullmatch(r"[A-Za-z0-9_-]+", token):
            return False
        try:
            raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
        except ValueError:
            return False
        if len(raw) != 40:
            return False
        expiry = int.from_bytes(raw[:8], "big")
        now = time.time()
        if expiry < now or expiry > now + ACCESS_TTL + 3600:
            return False
        return hmac.compare_digest(raw[8:], self._access_mac(meta, expiry))

    def _access(self, handler, meta: dict, qs: dict):
        """None for public shares; for password-protected ones the access token to embed in
        media URLs. Raises 401 { passwordRequired } without valid access."""
        if not (meta.get("settings") or {}).get("password"):
            return None
        token = handler.headers.get("X-Share-Access") or qs.get("a") or ""
        if token and self.verify_access(meta, token):
            return token
        if self._is_owner(handler, meta):
            return self.make_access(meta)
        raise ApiError(401, "This video is password-protected.", passwordRequired=True, title=None)

    # ---------------------------------------------------------------- views

    def public_view(self, meta: dict, access: str | None, full: bool = False) -> dict:
        sid = meta["id"]
        settings = meta.get("settings") or {}
        a = f"&a={quote(access, safe='')}" if access else ""
        version = int(meta.get("version") or 0)
        video = None
        vmeta = meta.get("video")
        if vmeta:
            url = f"/media/{sid}/video?v={version}{a}"
            video = {
                "url": url,
                "mimeType": vmeta.get("mimeType"),
                "width": vmeta.get("width"),
                "height": vmeta.get("height"),
                "duration": vmeta.get("duration"),
                "size": vmeta.get("size"),
                "downloadUrl": f"{url}&download=1" if settings.get("allowDownload") else None,
            }
        poster = f"/media/{sid}/poster.jpg?v={int(meta.get('posterAt') or 0)}{a}" if meta.get("poster") else None
        captions = meta.get("captions") or dict(DEFAULT_CAPTIONS)
        overlay = bool(captions.get("enabled")) and not captions.get("burned")
        show_transcript = full or settings.get("showTranscript") or overlay
        return {
            "id": sid,
            "title": meta.get("title") or DEFAULT_TITLE,
            # The description is the summary's TL;DR, so "Show summary: off" hides it too.
            "description": (meta.get("description") or "") if (full or settings.get("showSummary")) else "",
            "ownerName": meta.get("ownerName") or "",
            "createdAt": meta.get("createdAt"),
            "updatedAt": meta.get("updatedAt"),
            "status": meta.get("status"),
            "version": version,
            "duration": meta.get("duration") or 0,
            "summary": meta.get("summary") if (full or settings.get("showSummary")) else None,
            "transcript": (meta.get("transcript") or []) if show_transcript else [],
            "captions": captions,
            "layout": meta.get("layout"),
            "video": video,
            "posterUrl": poster,
            "settings": {
                "allowDownload": bool(settings.get("allowDownload")),
                "showSummary": bool(settings.get("showSummary")),
                "showTranscript": bool(settings.get("showTranscript")),
                "allowComments": bool(settings.get("allowComments")),
                "hasPassword": bool(settings.get("password")),
            },
            "views": int(meta.get("views") or 0),
        }

    def owner_view(self, handler, meta: dict) -> dict:
        """PublicView with the full summary/transcript (owners see everything) + owner fields."""
        access = self.make_access(meta) if (meta.get("settings") or {}).get("password") else None
        view = self.public_view(meta, access, full=True)
        base = self.public_base(handler)
        view["commentCount"] = len(self._read_list(meta["id"], "comments.json"))
        view["upload"] = meta.get("upload")
        view["url"] = f"{base}/s/{meta['id']}"
        view["embedUrl"] = f"{base}/embed/{meta['id']}"
        return view

    # ---------------------------------------------------------------- HTTP plumbing

    def _build_routes(self):
        sid = r"([^/]*)"
        table = [
            ("GET", r"/api/share-config", self.r_share_config),
            ("POST", r"/api/shares", self.r_create),
            ("GET", rf"/api/shares/{sid}/owner", self.r_owner_view),
            ("GET", rf"/api/shares/{sid}", self.r_public_view),
            ("PATCH", rf"/api/shares/{sid}", self.r_patch),
            ("DELETE", rf"/api/shares/{sid}", self.r_delete),
            ("POST", rf"/api/shares/{sid}/video/start", self.r_video_start),
            ("PUT", rf"/api/shares/{sid}/video", self.r_video_chunk),
            ("POST", rf"/api/shares/{sid}/video/complete", self.r_video_complete),
            ("POST", rf"/api/shares/{sid}/video/fail", self.r_video_fail),
            ("PUT", rf"/api/shares/{sid}/poster", self.r_poster),
            ("POST", rf"/api/shares/{sid}/unlock", self.r_unlock),
            ("POST", rf"/api/shares/{sid}/view", self.r_view),
            ("GET", rf"/api/shares/{sid}/comments", self.r_comments),
            ("POST", rf"/api/shares/{sid}/comments", self.r_comment_create),
            ("DELETE", rf"/api/shares/{sid}/comments/([^/]*)", self.r_comment_delete),
            ("GET", rf"/media/{sid}/video", self.r_media_video),
            ("GET", rf"/media/{sid}/poster\.jpg", self.r_media_poster),
            ("GET", rf"/s/{sid}/?", self.r_watch_page),
            ("GET", rf"/embed/{sid}/?", self.r_embed_page),
        ]
        return [(method, re.compile(pattern), fn) for method, pattern, fn in table]

    @staticmethod
    def owns_path(path: str) -> bool:
        return path in SHARE_PATHS or path.startswith(SHARE_PREFIXES)

    def handle(self, handler) -> bool:
        """Serves the request if it is a share route; returns False otherwise."""
        handler._dolly_allow_framing = False
        try:
            parts = urlsplit(handler.path)
        except ValueError:
            return False
        path = parts.path
        if not self.owns_path(path):
            return False
        method = "GET" if handler.command == "HEAD" else handler.command
        qs = {k: v[0] for k, v in parse_qs(parts.query, keep_blank_values=True).items()}
        handler._dolly_responded = False
        body = None
        try:
            body = handler._dolly_body = _Body(handler)
            allowed = set()
            for route_method, pattern, fn in self._routes:
                m = pattern.fullmatch(path)
                if not m:
                    continue
                allowed.add(route_method)
                if route_method == method:
                    fn(handler, qs, *m.groups())
                    break
            else:
                if allowed:
                    if "GET" in allowed:
                        allowed.add("HEAD")
                    raise ApiError(405, "Method not allowed.", headers={"Allow": ", ".join(sorted(allowed))})
                if path.startswith(("/s/", "/embed/")) and method == "GET":
                    self._render_page(handler, "", "embed" if path.startswith("/embed/") else "watch")
                else:
                    raise ApiError(404, "Not found.")
        except ApiError as e:
            if not handler._dolly_responded:
                payload = {"error": e.message}
                payload.update(e.extra)
                try:
                    self._json(handler, e.status, payload, headers=e.headers)
                except DISCONNECT_ERRORS:
                    handler.close_connection = True
                    return True
        except DISCONNECT_ERRORS:
            handler.close_connection = True
            if body is not None:
                body.remaining = 0  # the client is gone: nothing left to drain
            return True
        except Exception:  # noqa: BLE001
            sys.stderr.write(f"[dolly] error handling {handler.command} {path}\n")
            traceback.print_exc()
            if not handler._dolly_responded:
                try:
                    self._json(handler, 500, {"error": "Something went wrong on the Dolly server."})
                except DISCONNECT_ERRORS:
                    handler.close_connection = True
                    return True
        finally:
            if body is not None:
                body.finish()
        return True

    def _send(self, handler, status: int, body: bytes = b"", content_type: str | None = None,
              headers: dict | None = None) -> None:
        handler.send_response(status)
        if content_type:
            handler.send_header("Content-Type", content_type)
        if status not in (204, 304):
            handler.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            handler.send_header(key, value)
        handler.end_headers()
        handler._dolly_responded = True
        if body and handler.command != "HEAD" and status not in (204, 304):
            handler.wfile.write(body)

    def _json(self, handler, status: int, obj, headers: dict | None = None) -> None:
        hdrs = {"X-Robots-Tag": "noindex"}
        hdrs.update(headers or {})
        self._send(handler, status, _dump(obj), "application/json; charset=utf-8", hdrs)

    def _no_content(self, handler) -> None:
        self._send(handler, 204, headers={"X-Robots-Tag": "noindex"})

    def _read_json(self, handler, limit: int) -> dict:
        body: _Body = handler._dolly_body
        if body.length > limit:
            raise ApiError(413, "The request is too large.", maxBytes=limit)
        if body.length == 0:
            return {}
        ctype = (handler.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise ApiError(415, "Send JSON with Content-Type: application/json.")
        raw = body.read_all()
        try:
            data = json.loads(raw.decode("utf-8"), parse_constant=_bad_constant,
                              parse_int=_parse_int, parse_float=_parse_float)
        except (ValueError, RecursionError):
            raise ApiError(400, "The request body isn't valid JSON.")
        if not isinstance(data, dict):
            raise ApiError(400, "Expected a JSON object.")
        return data

    # ---------------------------------------------------------------- routes: config & CRUD

    def r_share_config(self, handler, qs):
        loopback = self.is_loopback_client(handler)
        base = self.public_base(handler)
        self._json(handler, 200, {
            "canCreate": loopback or bool(self.share_key),
            "keyRequired": bool(self.share_key),  # a configured key applies to every client
            "publicBase": base,
            "isLocalOnly": self.is_local_base(base),
        })

    def _new_share_dir(self) -> str:
        os.makedirs(self.shares_dir, mode=0o700, exist_ok=True)
        for _ in range(32):
            sid = _random_id(ID_LENGTH)
            try:
                os.mkdir(os.path.join(self.shares_dir, sid), 0o700)
                return sid
            except FileExistsError:  # (also catches case-only collisions on macOS)
                continue
        raise RuntimeError("could not allocate a share id")

    def _check_can_create(self, handler) -> None:
        """With a share key configured every client must send it (loopback included: a same-host
        proxy or tunnel that adds no forwarding headers makes everyone look local). Without
        one, only this computer may create links."""
        if self.share_key:
            wait = self.key_limiter.hit(self._rate_key(handler))
            if wait:
                raise ApiError(429, "Too many attempts. Try again in a minute.",
                               headers={"Retry-After": str(int(math.ceil(wait)))})
            if not self._key_ok(handler):
                if handler.headers.get("X-Dolly-Key"):
                    time.sleep(self.unlock_fail_delay)  # slow down guessing
                raise ApiError(403, "Enter the share key to create links on this server.", keyRequired=True)
        elif not self.is_loopback_client(handler):
            raise ApiError(403, "Share links can only be created on the computer running Dolly.", keyRequired=False)

    def r_create(self, handler, qs):
        self.secret  # noqa: B018 - make sure storage exists before the first share
        # Always JSON, even with an empty body: an HTML form can't send this type, and a
        # cross-site fetch that sets it needs a CORS preflight, which this server never grants.
        # Checked first so such requests can't spend the share-key attempt budget either.
        ctype = (handler.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise ApiError(415, "Send JSON with Content-Type: application/json.")
        self._check_can_create(handler)
        data = self._read_json(handler, META_BODY_LIMIT)
        fields = clean_share_fields(data, partial=False)
        settings = dict(DEFAULT_SETTINGS)
        settings.update(clean_settings_patch(data.get("settings")))
        duration = fields["duration"]
        fields["transcript"] = clean_transcript(fields["transcript"], duration)
        fields["summary"] = clean_summary(fields["summary"], duration)

        owner_token = secrets.token_urlsafe(32)
        sid = self._new_share_dir()
        now = now_ms()
        meta = {
            "id": sid,
            "ownerTokenHash": hashlib.sha256(owner_token.encode("utf-8")).hexdigest(),
            "createdAt": now,
            "updatedAt": now,
            "status": "processing",
            "version": 0,
            "upload": None,
            "title": fields["title"],
            "description": fields["description"],
            "ownerName": fields["ownerName"],
            "summary": fields["summary"],
            "transcript": fields["transcript"],
            "captions": fields["captions"],
            "layout": fields["layout"],
            "duration": duration,
            "video": None,
            "poster": False,
            "posterAt": 0,
            "settings": settings,
            "views": 0,
        }
        try:
            self._save_meta(sid, meta)
        except BaseException:
            shutil.rmtree(self._dir(sid), ignore_errors=True)
            raise
        base = self.public_base(handler)
        self._json(handler, 201, {
            "id": sid,
            "ownerToken": owner_token,
            "url": f"{base}/s/{sid}",
            "embedUrl": f"{base}/embed/{sid}",
            "share": self.owner_view(handler, meta),
        })

    def r_owner_view(self, handler, qs, sid):
        meta = self._load(sid)
        self._require_owner(handler, meta)
        self._json(handler, 200, self.owner_view(handler, meta))

    def r_public_view(self, handler, qs, sid):
        meta = self._load(sid)
        access = self._access(handler, meta, qs)
        self._json(handler, 200, self.public_view(meta, access))

    def r_patch(self, handler, qs, sid):
        meta = self._load(sid)
        self._require_owner(handler, meta)
        data = self._read_json(handler, META_BODY_LIMIT)
        fields = clean_share_fields(data, partial=True)
        settings_patch = clean_settings_patch(data.get("settings")) if "settings" in data else {}
        with self._locks_for(sid).meta:
            meta = self._load(sid)
            meta.update(fields)
            duration = float(meta.get("duration") or 0)
            if "transcript" in fields or "duration" in fields:
                meta["transcript"] = clean_transcript(meta.get("transcript"), duration)
            if ("summary" in fields or "duration" in fields) and meta.get("summary"):
                meta["summary"] = clean_summary(meta["summary"], duration)
            if settings_patch:
                settings = dict(DEFAULT_SETTINGS)
                settings.update(meta.get("settings") or {})
                settings.update(settings_patch)
                meta["settings"] = settings
            meta["updatedAt"] = now_ms()
            self._save_meta(sid, meta)
        self._json(handler, 200, self.owner_view(handler, meta))

    def r_delete(self, handler, qs, sid):
        meta = self._load(sid)
        self._require_owner(handler, meta)
        trash = os.path.join(self.shares_dir, f".trash-{sid}-{secrets.token_hex(4)}")
        with self._locks_for(sid).meta:
            try:
                os.rename(self._dir(sid), trash)
            except FileNotFoundError:
                raise ApiError(404, "This share link doesn't exist.")
        shutil.rmtree(trash, ignore_errors=True)
        self._no_content(handler)

    # ---------------------------------------------------------------- routes: upload

    def _acquire_upload(self, sid: str):
        locks = self._locks_for(sid)
        if not locks.upload.acquire(timeout=30):
            up = (self.read_meta(sid) or {}).get("upload") or {}
            raise ApiError(409, "Another upload request for this video is still running.",
                           expectedOffset=int(up.get("received") or 0))
        return locks

    def r_video_start(self, handler, qs, sid):
        meta = self._load(sid)
        self._require_owner(handler, meta)
        data = self._read_json(handler, SMALL_BODY_LIMIT)
        raw_type = data.get("mimeType")
        mime = raw_type.split(";")[0].strip().lower() if isinstance(raw_type, str) else ""
        if mime not in VIDEO_TYPES:
            raise ApiError(415, "Only MP4 and WebM videos can be shared.")
        size = data.get("size")
        if not _is_num(size) or float(size) != int(size) or int(size) <= 0:
            raise ApiError(400, "size must be a positive whole number of bytes.")
        size = int(size)
        if size > self.max_upload_bytes:
            raise ApiError(413, f"This video is larger than the server allows ({self.max_upload_bytes // MB} MB).",
                           maxBytes=self.max_upload_bytes)
        width = _int(data.get("width"), 0, MAX_DIMENSION, "width", 0)
        height = _int(data.get("height"), 0, MAX_DIMENSION, "height", 0)
        duration = round(_num(data.get("duration"), 0.0, MAX_DURATION, "duration", 0.0), 3)
        # Where this video starts in the owner's recording (its trim start), and the same for the
        # video live now (a fallback for links stored before sourceStart was kept): on complete,
        # timed comments and reactions move by the difference. Optional; non-numbers are ignored.
        starts = {}
        for key in ("sourceStart", "prevSourceStart"):
            v = data.get(key)
            starts[key] = round(min(MAX_DURATION, max(0.0, float(v))), 3) if _is_num(v) else None
        try:
            free = shutil.disk_usage(self._dir(sid)).free
        except OSError:
            free = None
        if free is not None and free < size + DISK_HEADROOM:
            raise ApiError(507, "The Dolly server is out of disk space.")

        locks = self._acquire_upload(sid)
        try:
            with locks.meta:
                meta = self._load(sid)
                previous = meta.get("upload") or {}
                version = max(int(meta.get("version") or 0), int(previous.get("version") or 0)) + 1
                self._remove_files(sid, videos=False)
                with open(self._path(sid, f"upload-{version}.part"), "wb"):
                    pass
                meta["upload"] = {"version": version, "mimeType": mime, "size": size, "width": width,
                                  "height": height, "duration": duration, "received": 0,
                                  "sourceStart": starts["sourceStart"], "prevSourceStart": starts["prevSourceStart"]}
                if not meta.get("video"):
                    meta["status"] = "processing"
                meta["updatedAt"] = now_ms()
                self._save_meta(sid, meta)
        finally:
            locks.upload.release()
        self._json(handler, 200, {"version": version, "offset": 0})

    def r_video_chunk(self, handler, qs, sid):
        meta = self._load(sid)
        self._require_owner(handler, meta)
        version = _qint(qs, "version")
        offset = _qint(qs, "offset")
        body: _Body = handler._dolly_body
        if not body.declared:
            raise ApiError(411, "Content-Length is required.")
        n = body.length
        if n > CHUNK_LIMIT:
            raise ApiError(413, "Upload chunks can be at most 16 MB.", maxBytes=CHUNK_LIMIT)

        locks = self._acquire_upload(sid)
        try:
            meta = self._load(sid)
            up = meta.get("upload")
            if not up or up.get("version") != version:
                raise ApiError(410, "This upload is no longer active. Start a new one.")
            received = int(up.get("received") or 0)
            if offset != received:
                raise ApiError(409, "The upload offset doesn't match.", expectedOffset=received)
            if offset + n > int(up["size"]):
                raise ApiError(413, "This chunk goes past the declared video size.", expectedOffset=received)
            part = self._path(sid, f"upload-{version}.part")
            try:
                f = open(part, "r+b")
            except FileNotFoundError:
                if not os.path.isdir(self._dir(sid)):
                    raise ApiError(404, "This share link doesn't exist.")
                f = open(part, "w+b")
            with f:
                on_disk = os.fstat(f.fileno()).st_size
                if on_disk < offset:  # bytes we acknowledged are gone (crash): resume from what's there
                    with locks.meta:
                        meta = self._load(sid)
                        if meta.get("upload") and meta["upload"].get("version") == version:
                            meta["upload"]["received"] = on_disk
                            self._save_meta(sid, meta)
                    raise ApiError(409, "Part of the upload was lost; resume from the server's offset.",
                                   expectedOffset=on_disk)
                f.seek(offset)
                f.truncate(offset)
                written = 0
                try:
                    while written < n:
                        block = body.read(min(UPLOAD_BLOCK, n - written))
                        if not block:
                            break
                        f.write(block)
                        written += len(block)
                    if written < n:
                        raise ApiError(400, "The chunk was cut off.", expectedOffset=offset)
                    f.flush()
                    os.fsync(f.fileno())
                except BaseException:
                    try:
                        f.truncate(offset)
                    except OSError:
                        pass
                    raise
            with locks.meta:
                meta = self._load(sid)
                up = meta.get("upload")
                if not up or up.get("version") != version:
                    raise ApiError(410, "This upload is no longer active. Start a new one.")
                up["received"] = offset + n
                self._save_meta(sid, meta)
        finally:
            locks.upload.release()
        self._json(handler, 200, {"received": offset + n})

    def r_video_complete(self, handler, qs, sid):
        meta = self._load(sid)
        self._require_owner(handler, meta)
        version = _qint(qs, "version")
        locks = self._acquire_upload(sid)
        try:
            with locks.meta:
                meta = self._load(sid)
                up = meta.get("upload")
                if not up or up.get("version") != version:
                    if meta.get("video") and int(meta.get("version") or 0) == version:
                        # Already completed (a retry whose first response got lost).
                        self._json(handler, 200, self.owner_view(handler, meta))
                        return
                    raise ApiError(410, "This upload is no longer active. Start a new one.")
                part = self._path(sid, f"upload-{version}.part")
                try:
                    actual = os.path.getsize(part)
                except OSError:
                    actual = 0
                size = int(up["size"])
                received = int(up.get("received") or 0)
                if received != size or actual != size:
                    resume = min(received, actual)
                    if resume != received:
                        up["received"] = resume
                        self._save_meta(sid, meta)
                    raise ApiError(409, "The upload isn't complete yet.", expectedOffset=resume)
                with open(part, "rb") as f:
                    sniffed = _sniff_video(f.read(16))
                if sniffed is None:
                    self._remove_files(sid, videos=False)
                    meta["upload"] = None
                    if not meta.get("video"):
                        meta["status"] = "failed"
                    meta["updatedAt"] = now_ms()
                    self._save_meta(sid, meta)
                    raise ApiError(415, "The uploaded file isn't an MP4 or WebM video.")
                mime = sniffed  # trust the bytes over the declared type
                ext = VIDEO_TYPES[mime]
                final_name = f"video-{version}.{ext}"
                had_video = bool(meta.get("video"))
                old_start = meta.get("sourceStart")
                if not _is_num(old_start):
                    old_start = up.get("prevSourceStart")
                new_start = up.get("sourceStart")
                os.replace(part, self._path(sid, final_name))
                meta["video"] = {"mimeType": mime, "size": size, "ext": ext, "width": up.get("width") or 0,
                                 "height": up.get("height") or 0, "duration": up.get("duration") or 0}
                meta["version"] = version
                meta["status"] = "ready"
                meta["upload"] = None
                if not meta.get("duration"):
                    meta["duration"] = up.get("duration") or 0
                if _is_num(new_start):
                    meta["sourceStart"] = float(new_start)
                else:  # unknown for this video: the next upload falls back to its prevSourceStart
                    meta.pop("sourceStart", None)
                meta["updatedAt"] = now_ms()
                self._save_meta(sid, meta)
                self._remove_files(sid, keep=final_name)
                if had_video:
                    shift = float(old_start) - float(new_start) if _is_num(old_start) and _is_num(new_start) else 0.0
                    self._retime_comments(sid, shift, float(up.get("duration") or 0))
        finally:
            locks.upload.release()
        self._json(handler, 200, self.owner_view(handler, meta))

    def _retime_comments(self, sid: str, shift: float, duration: float) -> None:
        """After a new video replaced a ready one: move timed comments and reactions by `shift`
        seconds (old trim start - new trim start), so they point at the same moment of the
        recording. A time that lands outside the new video (that part was trimmed away) becomes
        null: the comment stays, untimed. Caller holds the share's meta lock."""
        comments = self._read_list(sid, "comments.json")
        changed = False
        for c in comments:
            if not isinstance(c, dict) or not _is_num(c.get("time")):
                continue
            t = round(float(c["time"]) + shift, 3)
            if t < -COMMENT_TIME_SLACK or (duration > 0 and t > duration + COMMENT_TIME_SLACK):
                t = None
            elif duration > 0:
                t = min(duration, max(0.0, t))
            else:
                t = max(0.0, t)
            if t != c["time"]:
                c["time"] = t
                changed = True
        if changed:
            self._write_list(sid, "comments.json", comments)

    def r_video_fail(self, handler, qs, sid):
        """Reports a render/upload that won't finish. `version` names the upload the caller
        started: only that one is dropped (another tab's newer upload is never touched; without
        a version no upload in flight is). `cancelled: true` (the owner stopped it) leaves the
        status alone, so a new link stays 'processing' instead of telling viewers it failed."""
        meta = self._load(sid)
        self._require_owner(handler, meta)
        data = self._read_json(handler, SMALL_BODY_LIMIT)
        _clean_text(data.get("error"), 500, "error")  # validated, not stored
        version = data.get("version")
        version = None if version is None else _int(version, 0, 2 ** 53, "version")
        cancelled = _bool(data.get("cancelled"), "cancelled", False)
        locks = self._acquire_upload(sid)
        try:
            with locks.meta:
                meta = self._load(sid)
                up = meta.get("upload")
                changed = False
                if up and version is not None and up.get("version") == version:
                    self._remove_files(sid, videos=False)
                    meta["upload"] = None
                    up = None
                    changed = True
                if not up and not meta.get("video") and not cancelled and meta.get("status") != "failed":
                    meta["status"] = "failed"
                    changed = True
                if changed:
                    meta["updatedAt"] = now_ms()
                    self._save_meta(sid, meta)
        finally:
            locks.upload.release()
        self._json(handler, 200, self.owner_view(handler, meta))

    def r_poster(self, handler, qs, sid):
        meta = self._load(sid)
        self._require_owner(handler, meta)
        body: _Body = handler._dolly_body
        if not body.declared:
            raise ApiError(411, "Content-Length is required.")
        if body.length > POSTER_LIMIT:
            raise ApiError(413, "Posters can be at most 5 MB.", maxBytes=POSTER_LIMIT)
        if body.length == 0:
            raise ApiError(400, "The poster is empty.")
        data = body.read_all()
        if not data.startswith(b"\xff\xd8\xff"):
            raise ApiError(415, "Posters must be JPEG images.")
        with self._locks_for(sid).meta:
            meta = self._load(sid)
            try:
                _write_atomic(self._path(sid, "poster.jpg"), data)
            except (FileNotFoundError, NotADirectoryError):
                raise ApiError(404, "This share link doesn't exist.")
            meta["poster"] = True
            meta["posterAt"] = now_ms()
            self._save_meta(sid, meta)
        self._no_content(handler)

    # ---------------------------------------------------------------- routes: viewers

    def r_unlock(self, handler, qs, sid):
        meta = self._load(sid)
        data = self._read_json(handler, SMALL_BODY_LIMIT)
        password = data.get("password")
        if not isinstance(password, str) or len(password) > PASSWORD_MAX:
            raise ApiError(400, "Enter the password.")
        record = (meta.get("settings") or {}).get("password")
        if not record:
            self._json(handler, 200, {"access": self.make_access(meta)})
            return
        wait = self.unlock_limiter.hit(self._rate_key(handler))
        if wait:
            raise ApiError(429, "Too many attempts. Try again in a minute.",
                           headers={"Retry-After": str(int(math.ceil(wait)))})
        # Per share, whatever the source addresses: at most 30 wrong passwords per 10 minutes.
        wait = self.unlock_share_limiter.wait(sid)
        if wait:
            raise ApiError(429, "Too many attempts. Try again later.",
                           headers={"Retry-After": str(int(math.ceil(wait)))})
        ok = False
        if password:
            if not _PBKDF2_SLOTS.acquire(timeout=5):
                raise ApiError(429, "The server is busy. Try again in a moment.", headers={"Retry-After": "5"})
            try:
                ok = check_password(password, record)
            finally:
                _PBKDF2_SLOTS.release()
        if not ok:
            self.unlock_share_limiter.hit(sid)
            time.sleep(self.unlock_fail_delay)
            raise ApiError(403, "That password isn't right.")
        self._json(handler, 200, {"access": self.make_access(meta)})

    def r_view(self, handler, qs, sid):
        meta = self._load(sid)
        self._access(handler, meta, qs)
        data = self._read_json(handler, SMALL_BODY_LIMIT)
        viewer = data.get("viewerId")
        if not isinstance(viewer, str) or not 1 <= len(viewer) <= VIEWER_ID_MAX:
            raise ApiError(400, "viewerId must be a non-empty string.")
        if self.view_limiter.hit(self._rate_key(handler)):
            self._json(handler, 200, {"views": int(meta.get("views") or 0)})
            return
        digest = hashlib.sha256(viewer.encode("utf-8", "replace")).hexdigest()
        with self._locks_for(sid).meta:
            meta = self._load(sid)
            viewers = self._read_list(sid, "viewers.json")
            if digest not in set(viewers):
                # Past the cap new viewers still count; only their dedupe hash isn't kept.
                if len(viewers) < VIEWERS_MAX:
                    viewers.append(digest)
                    self._write_list(sid, "viewers.json", viewers)
                meta["views"] = int(meta.get("views") or 0) + 1
                self._save_meta(sid, meta)
        self._json(handler, 200, {"views": int(meta.get("views") or 0)})

    def _comments_etag(self, sid: str) -> str:
        # Every write is a tmp + rename (new inode, new mtime, usually a new size).
        try:
            st = os.stat(self._path(sid, "comments.json"))
            return f'W/"c{st.st_ino:x}-{st.st_mtime_ns:x}-{st.st_size:x}"'
        except OSError:
            return 'W/"c0"'

    def r_comments(self, handler, qs, sid):
        meta = self._load(sid)
        self._access(handler, meta, qs)
        if not (meta.get("settings") or {}).get("allowComments") and not self._is_owner(handler, meta):
            etag = 'W/"c-off"'  # a different representation: never matches a list's tag
            if self._etag_matches(handler, etag):
                self._send(handler, 304, headers={"ETag": etag, "X-Robots-Tag": "noindex"})
                return
            self._json(handler, 200, {"comments": []}, headers={"ETag": etag})
            return
        # Viewers poll this: answer an unchanged list with a bodiless 304 (stat, no parse).
        etag = self._comments_etag(sid)
        if self._etag_matches(handler, etag):
            self._send(handler, 304, headers={"ETag": etag, "X-Robots-Tag": "noindex"})
            return
        comments = [c for c in self._read_list(sid, "comments.json") if isinstance(c, dict)]
        comments.sort(key=lambda c: c.get("createdAt") or 0)
        self._json(handler, 200, {"comments": comments}, headers={"ETag": etag})

    def r_comment_create(self, handler, qs, sid):
        meta = self._load(sid)
        self._access(handler, meta, qs)
        if not (meta.get("settings") or {}).get("allowComments"):
            raise ApiError(403, "Comments are turned off for this video.")
        data = self._read_json(handler, COMMENT_BODY_LIMIT)
        kind = data.get("kind") or "comment"
        if kind not in ("comment", "reaction"):
            raise ApiError(400, "kind must be 'comment' or 'reaction'.")
        name = _clean_text(data.get("name"), COMMENT_NAME_MAX, "name") or "Guest"
        if kind == "reaction":
            emoji = data.get("emoji")
            if emoji == "❤":
                emoji = "❤️"
            if emoji not in REACTIONS:
                raise ApiError(400, "That reaction isn't supported.", allowed=list(REACTIONS))
            text = ""
        else:
            text = _clean_text(data.get("text"), COMMENT_TEXT_MAX, "text", multiline=True, strict=True)
            if not text:
                raise ApiError(400, "Write a comment first.")
            emoji = ""
        t = data.get("time")
        when = None
        if _is_num(t):
            limit = float((meta.get("video") or {}).get("duration") or meta.get("duration") or 0) or MAX_DURATION
            when = round(min(limit, max(0.0, float(t))), 3)
        for limiter, key in ((self.comment_limiter, self._rate_key(handler)), (self.comment_share_limiter, sid)):
            wait = limiter.hit(key)
            if wait:
                raise ApiError(429, "You're commenting too fast. Try again in a moment.",
                               headers={"Retry-After": str(int(math.ceil(wait)))}, retryAfter=int(math.ceil(wait)))
        comment = {"id": _random_id(COMMENT_ID_LENGTH), "kind": kind, "name": name, "text": text,
                   "emoji": emoji, "time": when, "createdAt": now_ms()}
        with self._locks_for(sid).meta:
            self._load(sid)
            # Byte budget first: at the cap this costs a stat(), not a parse of the whole file.
            try:
                size = os.path.getsize(self._path(sid, "comments.json"))
            except OSError:
                size = 0
            if size + len(_dump(comment)) + 1 > COMMENTS_MAX_BYTES:
                raise ApiError(403, "This video can't take any more comments.", limitReached=True)
            comments = self._read_list(sid, "comments.json")
            if len(comments) >= COMMENTS_MAX:
                raise ApiError(403, "This video can't take any more comments.", limitReached=True)
            comments.append(comment)
            self._write_list(sid, "comments.json", comments)
        self._json(handler, 201, comment)

    def r_comment_delete(self, handler, qs, sid, cid):
        meta = self._load(sid)
        self._require_owner(handler, meta)
        if not COMMENT_ID_RE.fullmatch(cid or ""):
            raise ApiError(404, "Comment not found.")
        with self._locks_for(sid).meta:
            self._load(sid)
            comments = self._read_list(sid, "comments.json")
            kept = [c for c in comments if not (isinstance(c, dict) and c.get("id") == cid)]
            if len(kept) == len(comments):
                raise ApiError(404, "Comment not found.")
            self._write_list(sid, "comments.json", kept)
        self._no_content(handler)

    # ---------------------------------------------------------------- routes: media

    @staticmethod
    def _etag_matches(handler, etag: str) -> bool:
        inm = handler.headers.get("If-None-Match")
        if not inm:
            return False
        return inm.strip() == "*" or etag in [t.strip() for t in inm.split(",")]

    def r_media_video(self, handler, qs, sid):
        meta = self._load(sid)
        self._access(handler, meta, qs)
        video = meta.get("video")
        if not video or video.get("ext") not in VIDEO_TYPES.values():
            raise ApiError(404, "This video isn't ready yet.")
        version = int(meta.get("version") or 0)
        wanted = qs.get("v")
        if wanted not in (None, "") and wanted != str(version):
            raise ApiError(404, "This video was updated. Reload the page to watch the new version.",
                           currentVersion=version)
        download = qs.get("download") in ("1", "true")
        if download and not (meta.get("settings") or {}).get("allowDownload"):
            raise ApiError(403, "Downloads are turned off for this video.")
        try:
            f = open(self._path(sid, f"video-{version}.{video['ext']}"), "rb")
        except (FileNotFoundError, NotADirectoryError):
            raise ApiError(404, "This video isn't available.")
        with f:
            size = os.fstat(f.fileno()).st_size
            etag = f'"{sid}-{version}-{size}"'
            headers = {"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600",
                       "ETag": etag, "X-Robots-Tag": "noindex"}
            if download:
                headers["Content-Disposition"] = _attachment_header(meta.get("title") or "", video["ext"])
            mime = video.get("mimeType") if video.get("mimeType") in VIDEO_TYPES else "application/octet-stream"
            range_header = handler.headers.get("Range")
            if_range = handler.headers.get("If-Range")
            if range_header and if_range and if_range.strip() != etag:
                range_header = None  # the client's copy is stale: send the whole new file
            if not range_header and self._etag_matches(handler, etag):
                self._send(handler, 304, headers=headers)
                return
            rng = parse_range(range_header, size) if range_header else None
            if rng == _UNSATISFIABLE:
                self._json(handler, 416, {"error": "Requested range not satisfiable."},
                           headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"})
                return
            if rng is None:
                status, start, length = 200, 0, size
            else:
                start, end = rng
                status, length = 206, end - start + 1
                headers["Content-Range"] = f"bytes {start}-{end}/{size}"
            handler.send_response(status)
            handler.send_header("Content-Type", mime)
            handler.send_header("Content-Length", str(length))
            for key, value in headers.items():
                handler.send_header(key, value)
            handler.end_headers()
            handler._dolly_responded = True
            if handler.command == "HEAD":
                return
            f.seek(start)
            remaining = length
            while remaining > 0:
                block = f.read(min(STREAM_BLOCK, remaining))
                if not block:
                    break
                handler.wfile.write(block)
                remaining -= len(block)
            if remaining > 0:  # file shrank under us; the client will notice the short body
                handler.close_connection = True

    def r_media_poster(self, handler, qs, sid):
        meta = self._load(sid)
        self._access(handler, meta, qs)
        if not meta.get("poster"):
            raise ApiError(404, "This video has no poster.")
        try:
            with open(self._path(sid, "poster.jpg"), "rb") as f:
                data = f.read(POSTER_LIMIT + 1)
        except (FileNotFoundError, NotADirectoryError):
            raise ApiError(404, "This video has no poster.")
        etag = f'"{sid}-p{int(meta.get("posterAt") or 0)}"'
        headers = {"Cache-Control": "private, max-age=3600", "ETag": etag, "X-Robots-Tag": "noindex"}
        if self._etag_matches(handler, etag):
            self._send(handler, 304, headers=headers)
            return
        self._send(handler, 200, data, "image/jpeg", headers)

    # ---------------------------------------------------------------- routes: pages

    def _template(self) -> str:
        try:
            with open(self.template_path, "r", encoding="utf-8") as f:
                return f.read()
        except OSError:
            return FALLBACK_TEMPLATE

    def render_page_html(self, handler, sid: str, mode: str):
        """(status, html) for /s/<id> or /embed/<id>."""
        sid = sid if valid_id(sid) else ""
        meta = self.read_meta(sid) if sid else None
        base = self.public_base(handler)
        values = {
            "TITLE": "Video not found",
            "DESCRIPTION": "",
            "URL": f"{base}/s/{sid}" if sid else f"{base}/",
            "OG_IMAGE": "",
            "OG_VIDEO": "",
            "OG_VIDEO_TYPE": "",
            "SHARE_ID": sid,
            "MODE": mode,
        }
        if meta is not None:
            if (meta.get("settings") or {}).get("password"):
                values["TITLE"] = "Password-protected video"
            else:
                values["TITLE"] = meta.get("title") or DEFAULT_TITLE
                if (meta.get("settings") or {}).get("showSummary"):  # the description is the TL;DR
                    values["DESCRIPTION"] = meta.get("description") or ""
                video = meta.get("video")
                if meta.get("status") == "ready" and video:
                    values["OG_VIDEO"] = f"{base}/media/{sid}/video?v={int(meta.get('version') or 0)}"
                    values["OG_VIDEO_TYPE"] = video.get("mimeType") if video.get("mimeType") in VIDEO_TYPES else ""
                    if meta.get("poster"):
                        values["OG_IMAGE"] = f"{base}/media/{sid}/poster.jpg?v={int(meta.get('posterAt') or 0)}"

        def fill(m):
            key = m.group(1)
            return html.escape(values[key], quote=True) if key in values else m.group(0)

        page = _PLACEHOLDER_RE.sub(fill, self._template())
        return (200 if meta is not None else 404), page

    def _render_page(self, handler, sid: str, mode: str) -> None:
        status, page = self.render_page_html(handler, sid, mode)
        handler._dolly_allow_framing = mode == "embed"
        self._send(handler, status, page.encode("utf-8"), "text/html; charset=utf-8",
                   {"X-Robots-Tag": "noindex"})

    def r_watch_page(self, handler, qs, sid):
        self._render_page(handler, sid, "watch")

    def r_embed_page(self, handler, qs, sid):
        self._render_page(handler, sid, "embed")

    # ---------------------------------------------------------------- startup

    def startup_lines(self, port: int) -> list:
        lines = []
        if self.public_url:
            lines.append(f"Share links: {self.public_url}/s/…")
        elif self._bound_to_all() and self.in_container():
            lines.append("Share links: set DOLLY_PUBLIC_URL to the https:// address people will use "
                         "(see README → \"Sharing publicly\").")
        elif self._bound_to_all():
            lan = self._lan_ip()
            if lan:
                lines.append(f"On your network: http://{lan}:{port}")
                lines.append(f"Share links: http://{lan}:{port}/s/… (people on your network can open them)")
            else:
                lines.append("Share links: local only (no network address found)")
        elif _is_loopback_name(self.host):
            lines.append("Share links: local only — they open on this computer only. "
                         "To share with others see README → \"Sharing publicly\".")
        else:
            lines.append(f"Share links: http://{self.host}:{port}/s/…")
        if self.share_key:
            lines.append("Creating links: needs the share key (DOLLY_SHARE_KEY) in every browser, this computer's too")
        lines.append(f"Share data: {self.data_dir}")
        return lines
