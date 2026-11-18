"""A wrapped MCP server on stdio, for `test_mcp_server.py` (run as a child process).

It writes each finished span as one JSON line to the file in `MCP_SPANS_FILE`.
`MCP_NATIVE_OTEL=0` removes the mcp 2.x SDK's own OpenTelemetry middleware.
Nothing goes to stdout: stdout is the MCP pipe.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
from collections.abc import Sequence
from typing import Any

from opentelemetry import trace
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult

from ratel_ai import instrument_mcp_server

MCP_MAJOR = int(importlib.metadata.version("mcp").split(".", maxsplit=1)[0])


class JsonLinesExporter(SpanExporter):
    def __init__(self, path: str) -> None:
        self._path = path

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        with open(self._path, "a", encoding="utf-8") as out:
            for span in spans:
                record = {
                    "name": span.name,
                    "kind": span.kind.name,
                    "scope": span.instrumentation_scope.name if span.instrumentation_scope else "",
                    "attributes": dict(span.attributes or {}),
                    "trace_id": f"{span.context.trace_id:032x}",
                    "parent_span_id": f"{span.parent.span_id:016x}" if span.parent else None,
                }
                out.write(json.dumps(record) + "\n")
        return SpanExportResult.SUCCESS


def sunny(city: str = "", query: str = "") -> str:
    return "sunny"


def main() -> None:
    provider = TracerProvider()
    provider.add_span_processor(
        SimpleSpanProcessor(JsonLinesExporter(os.environ["MCP_SPANS_FILE"]))
    )
    trace.set_tracer_provider(provider)

    server: Any
    if MCP_MAJOR >= 2:
        from mcp.server.mcpserver import MCPServer

        server = MCPServer("weather-mcp", version="1.0.0")
        lowlevel = server._lowlevel_server
    else:
        from mcp.server.fastmcp import FastMCP

        server = FastMCP("weather-mcp")
        lowlevel = server._mcp_server
    for name in ("get_forecast", "search_notes"):
        server.tool(name=name, description=f"The {name} tool.")(sunny)
    if os.environ.get("MCP_NATIVE_OTEL") == "0" and hasattr(lowlevel, "middleware"):
        lowlevel.middleware[:] = [
            m for m in lowlevel.middleware if type(m).__name__ != "OpenTelemetryMiddleware"
        ]
    instrument_mcp_server(server)
    server.run("stdio")


if __name__ == "__main__":
    main()
