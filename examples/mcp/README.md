# `examples/mcp` — Ratel + an upstream MCP server

Minimal demo of `registerMcpServer` from `@ratel-ai/sdk`. Spawns an MCP server as a stdio subprocess, indexes its tools into a `ToolCatalog`, runs BM25 search against your query, and invokes one of the tools over `tools/call` — all without an LLM in the loop, so no API key is required.

## Setup

```bash
pnpm install
pnpm -F @ratel-ai/example-mcp start
# or with a custom query:
pnpm -F @ratel-ai/example-mcp start "long running operation"
```

The first run downloads `@modelcontextprotocol/server-everything` via `npx -y` (one-time fetch).

Expected output: 13 namespaced tool ids, top-5 BM25 hits for the query, and the `tools/call` payload from `ev__echo`.

## Pointing at a different MCP server

The defaults spawn `npx -y @modelcontextprotocol/server-everything`. Override with env vars:

```bash
MCP_COMMAND=/path/to/server MCP_ARGS="--flag value" MCP_SERVER_NAME=fs \
  pnpm -F @ratel-ai/example-mcp start "read a file"
```

`MCP_ARGS` is space-split; quote-aware parsing is left as an exercise. For more complex transports (Streamable HTTP, SSE), edit `src/index.ts` and swap `StdioClientTransport` for the relevant transport from `@modelcontextprotocol/sdk` — `registerMcpServer` accepts any MCP `Transport`.

## What this proves

- `tools/list` discovery → BM25-rankable Ratel catalog entries
- Server-namespaced ids (`<name>__<toolName>`) survive multi-server registration without collisions
- `catalog.invoke` round-trips through `tools/call` over the live MCP connection
- `handle.close()` shuts the subprocess down cleanly

The same code path is unit-tested via `InMemoryTransport` in `src/sdk/ts/src/mcp.test.ts`; this example is the equivalent run against a real subprocess.

## Why it's a separate workspace package

Examples don't ship with `@ratel-ai/sdk`. Keeping the upstream MCP SDK out of the published artifact's runtime deps narrows the public surface — apps that don't use MCP shouldn't pay for it.
