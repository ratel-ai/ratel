"""Shared external-boundary fixtures for Python SDK tests."""

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


@pytest.fixture
def controlled_embedding_endpoint() -> Iterator[tuple[str, threading.Event, threading.Event]]:
    request_started = threading.Event()
    send_response = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length))
            request_started.set()
            if not send_response.wait(timeout=5):
                self.send_response(504)
                self.end_headers()
                return
            data = [
                {"embedding": [1.0, float(index + 1)], "index": index}
                for index, _ in enumerate(payload["input"])
            ]
            body = json.dumps({"data": data, "model": payload["model"]}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield (
            f"http://127.0.0.1:{server.server_port}/embeddings",
            request_started,
            send_response,
        )
    finally:
        send_response.set()
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()
