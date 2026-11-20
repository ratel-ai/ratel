# `examples/mcp-server-wrapper-ts` — trace an MCP server with `instrumentMcpServer` (TypeScript)

A stdio MCP server with one tool (`get_forecast`), built on the official MCP TypeScript SDK and wrapped with [`instrumentMcpServer`](../../src/sdk/ts/README.md#instrument-your-mcp-server) from `@ratel-ai/sdk`. Each MCP message the client sends becomes one OpenTelemetry SERVER span: `initialize`, `notifications/initialized`, `tools/list`, `tools/call get_forecast`. The spans carry the client (`mcp.client.name` / `.version`), the session (`mcp.session.id`) and `network.transport = pipe`.

## Setup

```bash
pnpm install
pnpm -F @ratel-ai/telemetry build && pnpm -F @ratel-ai/sdk build
```

The `start` script does not build the SDK: a stdio server must write nothing but MCP messages to stdout, and build output would break the protocol.

## Run it under a real client

The MCP client starts the server. The env vars select where the spans go:

- `MCP_SPANS_FILE=<path>`: one JSON line per span (name, kind, ids, status, attributes).
- `OTEL_EXPORTER_OTLP_ENDPOINT=<base url>`: OTLP/HTTP JSON to `<base url>/v1/traces` (`OTEL_EXPORTER_OTLP_HEADERS` for auth).

With Claude Code (from the repository root):

```bash
cat > /tmp/weather-mcp.json <<EOF
{"mcpServers":{"weather":{"command":"$PWD/examples/mcp-server-wrapper-ts/node_modules/.bin/tsx",
  "args":["$PWD/examples/mcp-server-wrapper-ts/src/index.ts"],
  "env":{"MCP_SPANS_FILE":"/tmp/weather-spans.jsonl"}}}}
EOF
claude -p "What is the weather in Rome? Use the weather tool." \
  --mcp-config /tmp/weather-mcp.json --strict-mcp-config \
  --allowedTools mcp__weather__get_forecast < /dev/null
cat /tmp/weather-spans.jsonl
```

## What it illustrates

- **One call.** `instrumentMcpServer(new McpServer(...))` before `connect()`. The server code does not change.
- **The host owns the provider.** The example registers a `NodeTracerProvider` with `service.name = weather-mcp`; Ratel Cloud names the MCP server from it. `@ratel-ai/sdk` registers no provider.
- **Nothing on stdout.** On stdio, stdout is the protocol channel, so the spans go to a file or an OTLP endpoint, never to the console.
- **No content by default.** Set `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY` in the server `env` to add `gen_ai.tool.call.arguments` / `.result`.

## Layout

```
src/index.ts   the server, the tool, the provider (OTLP + JSON-lines exporters) and the shutdown flush
```
