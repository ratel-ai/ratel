"""An in-process catalog source for loader tests: a real HTTP server that
implements the frozen protocol/v1 behavior — Bearer auth with the frozen 401
body, scope overlay, the real ETag algorithm (quoted strong header, bare-hex
`catalogVersion`), weak `If-None-Match` => 304, unauthenticated `/healthz` —
plus request recording and failure injection. Test-only; never shipped into a
runtime code path.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

from ..canonical import SKILL_FIELDS, etag_of, resolve

__all__ = ["MockSource", "RecordedRequest"]


@dataclass
class RecordedRequest:
    method: str
    path: str
    scope: str | None
    headers: dict[str, str]


@dataclass
class _InjectedFailure:
    status: int
    code: str
    times: int


def _opaque(tag: str) -> str:
    """Strip a `W/` weak prefix and surrounding quotes to the opaque value."""
    t = tag.strip()
    if t.startswith("W/"):
        t = t[2:].strip()
    if len(t) >= 2 and t.startswith('"') and t.endswith('"'):
        t = t[1:-1]
    return t


def _if_none_match_matches(header_value: str | None, current_etag: str) -> bool:
    """Weak comparison per RFC 7232 §3.2: tolerate `W/`, quotes, comma-lists,
    and `*` (matches any current representation)."""
    if header_value is None:
        return False
    value = header_value.strip()
    if value == "*":
        return True
    current = _opaque(current_etag)
    return any(
        _opaque(token) == current and _opaque(token) != ""
        for token in value.split(",")
    )


def _project(skill: Mapping[str, Any]) -> dict[str, Any]:
    """The frozen wire projection: exactly the seven fields, fixed key order —
    the structural guarantee that a secret-bearing field never leaves the source."""
    return {key: skill[key] for key in SKILL_FIELDS}


class _Handler(BaseHTTPRequestHandler):
    server: MockSourceServer

    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        source = self.server.source
        split = urlsplit(self.path)
        scope_values = parse_qs(split.query).get("scope")
        scope = scope_values[0] if scope_values else None
        headers = {k.lower(): v for k, v in self.headers.items()}
        with source._lock:
            source.requests.append(
                RecordedRequest(method="GET", path=split.path, scope=scope, headers=headers)
            )

        if split.path == "/healthz":
            self._respond(200, b"")
            return

        failure = source._take_failure()
        if failure is not None:
            self._error(failure.status, failure.code, "injected failure")
            return

        if headers.get("authorization") != f"Bearer {source.api_key}":
            self._error(401, "unauthorized", "missing or unknown key")
            return

        if split.path != "/v1/catalog":
            self._error(404, "not_found", f"no such resource: {split.path}")
            return

        with source._lock:
            layers = source._layers
        resolved = [_project(s) for s in resolve(layers, scope)]
        etag = etag_of(resolved)
        if _if_none_match_matches(headers.get("if-none-match"), etag.etag):
            self.send_response(304)
            self.send_header("ETag", etag.etag)
            self.end_headers()
            return
        body = json.dumps(
            {"catalogVersion": etag.hex, "skills": resolved}, ensure_ascii=False
        ).encode("utf-8")
        headers_out = {
            "ETag": etag.etag,
            "Cache-Control": "no-cache",
            "Content-Type": "application/json",
        }
        self._respond(200, body, extra=headers_out)

    def _error(self, status: int, code: str, message: str) -> None:
        body = json.dumps({"error": {"code": code, "message": message}}).encode("utf-8")
        self._respond(status, body, extra={"Content-Type": "application/json"})

    def _respond(self, status: int, body: bytes, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass  # keep test output clean


class MockSourceServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, source: MockSource) -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.source = source


@dataclass
class MockSource:
    """A conformant in-process catalog source on an OS-assigned port."""

    api_key: str = "test-key"
    requests: list[RecordedRequest] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._lock = threading.Lock()
        self._layers: dict[str, Any] = {"global": [], "subjects": {}}
        self._failure: _InjectedFailure | None = None
        self._server: MockSourceServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        if self._server is None:
            raise RuntimeError("MockSource is not started")
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def start(self) -> MockSource:
        self._server = MockSourceServer(self)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join()
            self._thread = None

    def __enter__(self) -> MockSource:
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.stop()

    def set_skills(self, skills: list[dict[str, Any]]) -> None:
        """Replace the global layer (subject layers untouched)."""
        with self._lock:
            self._layers = {**self._layers, "global": list(skills)}

    def set_layers(self, layers: dict[str, Any]) -> None:
        """Replace the full catalog: `{"global": [...], "subjects": {...}}`."""
        with self._lock:
            self._layers = {
                "global": list(layers.get("global") or []),
                "subjects": dict(layers.get("subjects") or {}),
            }

    def inject_failure(self, status: int, code: str = "unavailable", times: int = 1) -> None:
        """Fail the next `times` catalog requests with the frozen error body."""
        with self._lock:
            self._failure = _InjectedFailure(status=status, code=code, times=times)

    def _take_failure(self) -> _InjectedFailure | None:
        with self._lock:
            failure = self._failure
            if failure is None:
                return None
            failure.times -= 1
            if failure.times <= 0:
                self._failure = None
            return failure
