"""Minimal Python scaffolding for benchmark agents.

Provides HTTP server with /health, /setup, /send-message routes
and tool proxy via subprocess to bash scripts.
"""

import json
import os
import subprocess
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Any, Callable


def execute_tool(script: str, args: dict) -> Any:
    result = subprocess.run(
        ["bash", script],
        input=json.dumps(args),
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Tool script failed: {result.stderr}")
    return json.loads(result.stdout)


class AgentHandler(BaseHTTPRequestHandler):
    setup_cb: Callable = None
    send_message_cb: Callable = None
    tools: list = []

    def log_message(self, format, *args):
        pass  # suppress logs

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def _json_response(self, status: int, data: Any):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json_response(200, {"ok": True})
        self._json_response(404, {"error": "Not found"})

    def do_POST(self):
        try:
            body = self._read_body()

            if self.path == "/setup":
                tools = []
                for t in body.get("tools", []):
                    tool = dict(t)
                    tool["execute"] = lambda args, s=t["script"]: execute_tool(s, args)
                    tools.append(tool)
                AgentHandler.tools = tools
                AgentHandler.setup_cb(tools, body.get("config", {}))
                return self._json_response(200, {"ok": True})

            if self.path == "/send-message":
                result = AgentHandler.send_message_cb(body)
                return self._json_response(200, result)

            self._json_response(404, {"error": "Not found"})
        except Exception as e:
            self._json_response(500, {"error": str(e)})


def start_agent(
    setup: Callable,
    send_message: Callable,
    port: int | None = None,
):
    port = port or int(os.environ.get("AGENT_PORT", "9300"))
    AgentHandler.setup_cb = setup
    AgentHandler.send_message_cb = send_message

    server = HTTPServer(("", port), AgentHandler)
    print(json.dumps({"status": "ready", "port": port}), flush=True)
    server.serve_forever()
