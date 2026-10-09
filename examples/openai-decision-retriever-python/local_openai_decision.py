"""A local stand-in for OpenAI's ``POST /v1/decisions``, so the example runs
with no OpenAI key. It speaks the Decisions wire format::

    request  {"model", "input", "questions": [{"type": "choice", "name": "tool",
              "instructions", "choices": [{"value": "t0", "description": "…"}]}]}
    response {"answers": [{"type": "choice", "name": "tool", "choice": "t3",
              "probabilities": [{"value": "t0", "probability": 0.01}], "confidence"}]}

Its "judge" is a hard-coded intent table: it shows the plumbing, not ranking
quality. Set OPENAI_API_KEY to call OpenAI itself. The TypeScript twin is
``examples/openai-decision-retriever-ts/src/local-openai-decision.ts``.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# Query phrases -> words a choice should mention to satisfy that intent.
_INTENTS = [
    ("money back", ["refund", "return funds"]),
    ("charged twice", ["refund", "return funds"]),
]


def _judge(query: str, choices: list[dict[str, str]]) -> list[dict[str, Any]]:
    wanted = [w for phrase, words in _INTENTS if phrase in query.lower() for w in words]
    raw = [
        (c["value"], 0.9 if any(w in c["description"].lower() for w in wanted) else 0.01)
        for c in choices
    ]
    total = sum(p for _, p in raw) or 1.0
    return [{"value": value, "probability": p / total} for value, p in raw]


class LocalDecisions:
    def __init__(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - http.server API
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                question = body["questions"][0]
                probabilities = _judge(body["input"], question["choices"])
                best = max(probabilities, key=lambda p: p["probability"])
                data = json.dumps(
                    {
                        "answers": [
                            {
                                "type": "choice",
                                "name": question["name"],
                                "choice": best["value"],
                                "probabilities": probabilities,
                                "confidence": best["probability"],
                            }
                        ]
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
