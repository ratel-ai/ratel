# `examples/mcp-server-wrapper-python` — trace an MCP server with `instrument_mcp_server` (Python)

A stdio MCP server with one tool (`get_forecast`), built on the official MCP Python SDK (`MCPServer` on mcp 2.x, `FastMCP` on 1.x) and wrapped with [`instrument_mcp_server`](../../src/sdk/python/README.md#instrument-your-mcp-server) from `ratel-ai`. Each MCP message the client sends becomes one OpenTelemetry SERVER span: `initialize`, `notifications/initialized`, `tools/list`, `tools/call get_forecast`. The spans carry the client (`mcp.client.name` / `.version`), the session (`mcp.session.id`) and `network.transport = pipe`. It is the Python twin of [`mcp-server-wrapper-ts`](../mcp-server-wrapper-ts/README.md).

## Setup

```bash
cd examples/mcp-server-wrapper-python
uv sync
```

`uv sync` builds the local `ratel-ai` wheel (maturin) once. Do it before the first client run: a stdio server must write nothing but MCP messages to stdout, and the client may time out on a first build.

## Run it under a real client

The MCP client starts the server. The env vars select where the spans go:

- `MCP_SPANS_FILE=<path>`: one JSON line per span (name, kind, ids, status, scope, attributes).
- `OTEL_EXPORTER_OTLP_ENDPOINT=<base url>`: OTLP/HTTP to `<base url>/v1/traces` (`OTEL_EXPORTER_OTLP_HEADERS` for auth).

With Claude Code (from the repository root):

```bash
cat > /tmp/weather-mcp-py.json <<EOF
{"mcpServers":{"weather":{"command":"$PWD/examples/mcp-server-wrapper-python/.venv/bin/python",
  "args":["$PWD/examples/mcp-server-wrapper-python/server.py"],
  "env":{"MCP_SPANS_FILE":"/tmp/weather-spans-py.jsonl"}}}}
EOF
claude -p "What is the weather in Rome? Use the weather tool." \
  --mcp-config /tmp/weather-mcp-py.json --strict-mcp-config \
  --allowedTools mcp__weather__get_forecast < /dev/null
cat /tmp/weather-spans-py.jsonl
```

## What it illustrates

- **One call.** `instrument_mcp_server(MCPServer(...))` before `run()`. The server code does not change.
- **One span per message, also with the SDK's own tracing.** mcp 2.x has its own OpenTelemetry middleware, on by default. The wrapper adds its attributes to that span (scope `mcp-python-sdk`) and makes no second span. On mcp 1.x the span is the wrapper's own (scope `ratel-ai`).
- **The host owns the provider.** The example registers a `TracerProvider` with `service.name = weather-mcp`; Ratel Cloud names the MCP server from it. `ratel-ai` registers no provider.
- **Nothing on stdout.** On stdio, stdout is the protocol channel, so the spans go to a file or an OTLP endpoint, never to the console. The provider is shut down (flushed) at exit.
- **No content by default.** Set `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY` in the server `env` to add `gen_ai.tool.call.arguments` / `.result`.

## Layout

```
server.py   the server, the tool, the provider (OTLP + JSON-lines exporters) and the exit flush
```
