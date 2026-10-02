"""A local stand-in for the two Ratel Cloud endpoints a cloud catalog uses, so
the example runs with no API key. It speaks the real wire contracts
(ADR-0026, ADR-0027)::

    PUT  /api/v1/catalog/snapshot  {source_id, tools}     -> {sourceId, catalogVersion, tools, unchanged}
    POST /v1/tools/pick            {query, mode, top_k}   -> {mode, tools: [{id, name, description, score}], confident}

Its "ranking" is a toy: word overlap for ``instant``, plus a hard-coded intent
table standing in for the system-one judge in ``precise`` / ``exhaustive``. It
shows the plumbing, not ranking quality. Set RATEL_CLOUD_URL to use Cloud. The
TypeScript twin is ``examples/cloud-tool-picker-ts/src/local-cloud.ts``.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# Query phrases -> words a tool should mention to satisfy that intent.
_INTENTS = [
    ("money back", ["refund", "return funds"]),
    ("charged twice", ["refund", "return funds"]),
]


def _words(text: str) -> set[str]:
    return set(re.findall(r"[a-z]+", text.lower()))


def _rank(query: str, mode: str, tools: list[dict[str, Any]], top_k: int) -> list[dict[str, Any]]:
    q = _words(query)
    wanted = [w for phrase, words in _INTENTS if phrase in query.lower() for w in words]
    ranked = []
    for t in tools:
        text = f"{t['name'].replace('_', ' ')} {t['description']}".lower()
        overlap = len(_words(text) & q) / max(len(q), 1)
        judged = 0.9 if any(w in text for w in wanted) else 0.05 * overlap
        score = overlap if mode == "instant" else judged
        if score > 0:
            ranked.append({**t, "score": score})
    ranked.sort(key=lambda r: (-r["score"], r["id"]))
    return ranked[:top_k]


class LocalCloud:
    def __init__(self) -> None:
        catalogs: dict[str, tuple[str, list[dict[str, Any]]]] = {}

        class Handler(BaseHTTPRequestHandler):
            def _reply(self, status: int, payload: Any) -> None:
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_PUT(self) -> None:  # noqa: N802 - http.server API
                raw = self.rfile.read(int(self.headers["content-length"]))
                body = json.loads(raw)
                version = hashlib.sha256(raw).hexdigest()[:12]
                unchanged = catalogs.get(body["source_id"], ("", []))[0] == version
                catalogs[body["source_id"]] = (version, body["tools"])
                self._reply(
                    200,
                    {
                        "sourceId": body["source_id"],
                        "catalogVersion": version,
                        "tools": len(body["tools"]),
                        "unchanged": unchanged,
                    },
                )

            def do_POST(self) -> None:  # noqa: N802 - http.server API
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                tools = [t for _, synced in catalogs.values() for t in synced]
                if not tools:
                    self._reply(409, {"error": {"message": "no tools in the runtime catalog"}})
                    return
                self._reply(
                    200,
                    {
                        "mode": body["mode"],
                        "tools": _rank(body["query"], body["mode"], tools, body["top_k"]),
                        "confident": None if body["mode"] == "instant" else True,
                    },
                )

            def log_message(self, *_args: Any) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
