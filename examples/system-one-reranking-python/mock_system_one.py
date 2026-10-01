"""A local stand-in for Ratel Cloud's ``POST /v1/systemone``, so the example
runs with no API key. It speaks the real wire contract (ADR-0026)::

    request  {"query", "candidates": [{"id", "text"}], "top_k"}
    response {"ranked": [{"id", "score"}], "provider", "model"}

The "model" is a hard-coded intent table, not a system-one model: it exists to
show the plumbing, not to rank well. Point RATEL_SYSTEM_ONE_URL at the real
endpoint to use one. The TypeScript twin is
``examples/system-one-reranking-ts/src/mock-system-one.ts``.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# Query phrases -> words a candidate should mention to satisfy that intent.
_INTENTS = [
    ("money back", ["refund", "return funds"]),
    ("charged twice", ["refund", "return funds"]),
    ("email", ["email"]),
]


def _rank(query: str, candidates: list[dict[str, str]], top_k: int) -> list[dict[str, Any]]:
    wanted = [w for phrase, words in _INTENTS if phrase in query.lower() for w in words]
    scored = []
    for c in candidates:
        hits = sum(1 for w in wanted if w in c["text"].lower())
        scored.append({"id": c["id"], "score": 0.01 if hits == 0 else min(0.95, 0.5 + 0.2 * hits)})
    scored.sort(key=lambda r: -r["score"])
    return scored[:top_k]


class MockSystemOne:
    def __init__(self) -> None:
        self.requests = 0
        mock = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - http.server API
                mock.requests += 1
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                payload = json.dumps(
                    {
                        "ranked": _rank(body["query"], body["candidates"], body["top_k"]),
                        "provider": "local-mock",
                        "model": "intent-table",
                    }
                ).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args: Any) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}/v1/systemone"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
