# Client-facts fixtures (RC-773)

Real OTLP/JSON trace export bodies, as each MCP SDK's server process sent them
to a local sink on 2026-11-18. Each file is one export request (a
`forceFlush` after one MCP step). Nothing in a span was written or edited by
hand. The only change is whitespace: the bodies are pretty-printed.

Only the server process exports spans. The clients have no OpenTelemetry SDK,
so they put no `traceparent` in `params._meta` (like an uninstrumented harness).
IPs and ports are loopback.

The generator scripts are in `.beluga/scratch/client-facts-fixtures/` (git-ignored):
`collector.mjs` (the sink: `POST /label/<name>` names the next body),
`ts/` and `py/`.

## TypeScript: MCP TS SDK v2, Streamable HTTP, stateful

- SDK: `@modelcontextprotocol/server` + `@modelcontextprotocol/client` 2.4.0,
  `@modelcontextprotocol/node` 2.1.2, BUILT FROM `main` at commit
  `919bb8ea88b6e10e72c2f8b6218fad4cfdc40b2c` (2026-11-10). The native OpenTelemetry
  instrumentation (PR #3115, merged 2026-10-31) is not in any npm release yet
  (2.4.0 on npm predates it), so the packages are `pnpm pack` tarballs of `main`.
- OTel: `@opentelemetry/api` 1.10.0, `sdk-trace` 3.1.1, `context-async-hooks` 3.1.1,
  `exporter-trace-otlp-http` 0.301.2 (JSON), `instrumentation-http` 0.301.2. Node 24.12.0.
- Server: service `weather-mcp`, plain `node:http` server, one
  `NodeStreamableHTTPServerTransport` per session (`sessionIdGenerator: randomUUID`),
  tool `get_forecast`. `HttpInstrumentation` makes the HTTP SERVER span. With no
  `_meta` trace context, the MCP SERVER span is a child of the HTTP span (same trace).
- Client: default (legacy) version negotiation, so `initialize` with protocol `2025-11-25`.
  `client.close()` runs before the tools-call flush, so the standalone `GET /mcp`
  SSE stream span of that session ends up in the tools-call file.

| File | Client sent | Spans |
| --- | --- | --- |
| `ts-http-claude-code-initialize.otlp.json` | clientInfo `claude-code` / `2.1.3`, `User-Agent: claude-code/2.1.3 (external, cli)` | `initialize`, `notifications/initialized`, 2 × HTTP `POST` |
| `ts-http-claude-code-tools-call.otlp.json` | same session | `tools/call get_forecast`, HTTP `POST`, HTTP `GET` (SSE stream) |
| `ts-http-cursor-initialize.otlp.json` | clientInfo `cursor-vscode` / `1.7.0`, `User-Agent: Cursor/1.7.0` | as above |
| `ts-http-cursor-tools-call.otlp.json` | same session | as above |

Regenerate: `.beluga/scratch/client-facts-fixtures/ts/run.sh` (writes `out/ts-http-*.json`),
then pretty-print into this folder as `<name>.otlp.json`.

## Python: official MCP Python SDK, stdio

- SDK: `mcp` 2.3.0 (`mcp-types` 2.3.0), native OTel (`OpenTelemetryMiddleware`, on by default).
- OTel: `opentelemetry-sdk` 1.45.2, `opentelemetry-exporter-otlp-json-http` 0.66b2 (JSON). Python 3.12.8.
- Server: service `notes-mcp`, `MCPServer.run("stdio")`, tool `search_notes`.
- Client: `ClientSession(..., client_info=Implementation(name="codex", version="0.50.0"))`,
  protocol `2025-11-25`. No User-Agent (stdio). After `call_tool` the SDK client
  sends `tools/list` by itself (to read output schemas), so that span is in the tools-call file.

| File | Client sent | Spans |
| --- | --- | --- |
| `py-stdio-codex-initialize.otlp.json` | clientInfo `codex` / `0.50.0` | `initialize`, `notifications/initialized` |
| `py-stdio-codex-tools-call.otlp.json` | same session | `tools/call search_notes`, `tools/list` |

Regenerate: `.beluga/scratch/client-facts-fixtures/py/run.sh` (writes `out/py-stdio-*.json`),
then pretty-print into this folder as `<name>.otlp.json`.

## What the spans do not carry

- No SDK records the client name or version (`clientInfo`) on any span.
- TS: `mcp.session.id` is on every MCP span, `initialize` included. The HTTP spans
  have `user_agent.original` and `client.address` but no `mcp.session.id`.
- Python: no `mcp.session.id`, no `network.transport`, no parent span. Every
  request is its own root trace.
