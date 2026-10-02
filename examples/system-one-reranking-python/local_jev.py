"""A local stand-in for Jev's ``POST /v1/systemone``, so the example runs with no
TypeSafe key. It speaks Jev's wire format::

    request  {"model", "state", "questions": {"tool": {"type": "choice", "criteria": {"t0": "…"}}}}
    response {"model", "answers": {"tool": {"type": "choice", "probabilities": {"t0": 0.9}}}}

Its "judge" is a hard-coded intent table: it shows the plumbing, not ranking
quality. Set TYPESAFE_API_KEY to call Jev itself. The TypeScript twin is
``examples/system-one-reranking-ts/src/local-jev.ts``.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# Query phrases -> words an option should mention to satisfy that intent.
_INTENTS = [
    ("money back", ["refund", "return funds"]),
    ("charged twice", ["refund", "return funds"]),
]


def _judge(query: str, criteria: dict[str, str]) -> dict[str, float]:
    wanted = [w for phrase, words in _INTENTS if phrase in query.lower() for w in words]
    raw = {
        key: 0.9 if any(w in text.lower() for w in wanted) else 0.01
        for key, text in criteria.items()
    }
    total = sum(raw.values()) or 1.0
    return {key: value / total for key, value in raw.items()}


class LocalJev:
    def __init__(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - http.server API
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                # The question id is the kind being ranked: "tool", "skill", ….
                kind, question = next(iter(body["questions"].items()))
                probabilities = _judge(body["state"], question["criteria"])
                data = json.dumps(
                    {
                        "model": body["model"],
                        "answers": {kind: {"type": "choice", "probabilities": probabilities}},
                    }
                ).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args: Any) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
