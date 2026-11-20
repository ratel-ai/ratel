"""A stdio MCP server with one tool, wrapped with `instrument_mcp_server` from `ratel-ai`.

Every MCP message the client sends becomes one OpenTelemetry SERVER span
(`initialize`, `notifications/initialized`, `tools/list`, `tools/call get_forecast`).

The host owns the OpenTelemetry provider (Ratel registers none). This one exports to:
- `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP/HTTP, `/v1/traces` appended), when set;
- the file named by `MCP_SPANS_FILE`, one JSON line per span, when set.

Nothing goes to stdout: on stdio, stdout is the MCP protocol channel.
"""

from __future__ import annotations

import atexit
import json
import os
from collections.abc import Sequence
from typing import Any

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SimpleSpanProcessor,
    SpanExporter,
    SpanExportResult,
)
from ratel_ai import instrument_mcp_server

SERVICE_NAME = "weather-mcp"
SERVICE_VERSION = "1.0.0"
SPANS_FILE_ENV = "MCP_SPANS_FILE"


class JsonLinesExporter(SpanExporter):
    """Writes each span as one JSON line: the part a reader checks, not the full OTLP shape."""

    def __init__(self, path: str) -> None:
        """Append to the file at `path`."""
        self._path = path

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        """Write one JSON line per span."""
        with open(self._path, "a", encoding="utf-8") as out:
            for span in spans:
                parent = span.parent
                line = {
                    "name": span.name,
                    "kind": span.kind.name,
                    "traceId": f"{span.context.trace_id:032x}",
                    "spanId": f"{span.context.span_id:016x}",
                    "parentSpanId": f"{parent.span_id:016x}" if parent else None,
                    "status": span.status.status_code.name,
                    "scope": getattr(span.instrumentation_scope, "name", None),
                    "attributes": dict(span.attributes or {}),
                }
                out.write(json.dumps(line) + "\n")
        return SpanExportResult.SUCCESS


def start_tracing() -> TracerProvider:
    """Register the provider with the exporters the env vars ask for."""
    provider = TracerProvider(resource=Resource.create({"service.name": SERVICE_NAME}))
    if os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )

        # Reads OTEL_EXPORTER_OTLP_ENDPOINT / _HEADERS itself and appends `/v1/traces`.
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    spans_file = os.environ.get(SPANS_FILE_ENV)
    if spans_file:
        provider.add_span_processor(SimpleSpanProcessor(JsonLinesExporter(spans_file)))
    trace.set_tracer_provider(provider)
    atexit.register(provider.shutdown)  # flush the batch on exit
    return provider


def new_server() -> Any:
    """`MCPServer` on mcp 2.x, `FastMCP` (which takes no version) on 1.x."""
    try:
        from mcp.server.mcpserver import MCPServer
    except ImportError:
        from mcp.server.fastmcp import FastMCP

        return FastMCP(SERVICE_NAME)
    return MCPServer(SERVICE_NAME, version=SERVICE_VERSION)


start_tracing()
server = instrument_mcp_server(new_server())


@server.tool()
def get_forecast() -> str:
    """Get today's weather forecast for Rome."""
    return "Rome: sunny, 24°C, light wind."


if __name__ == "__main__":
    server.run("stdio")
