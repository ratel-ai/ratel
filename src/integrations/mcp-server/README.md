# `@ratel-ai/mcp-server`

Expose a Ratel [`ToolCatalog`](../../sdk/ts/README.md) as a Model Context Protocol server. Any MCP-speaking client (Claude Desktop, an agent framework, an `@modelcontextprotocol/sdk` `Client`) can drive Ratel's gateway — `search_tools` to rank the catalog by query, `invoke_tool` to dispatch a hit by id — over stdio, Streamable HTTP, SSE, or any other [transport](https://modelcontextprotocol.io) you wire up.

This is the inverse of `@ratel-ai/sdk`'s [`registerMcpServer`](../../sdk/ts/README.md#registermcpserver--index-an-mcp-servers-tools-into-the-catalog), which ingests an upstream MCP server's tools *into* a catalog. `createMcpServer` exposes a catalog *as* an MCP server.

Two ways to drive it: a CLI that aggregates a list of upstream MCP servers from a JSON config (the common case — you're replacing a multi-MCP setup behind one Ratel entry), or the library function for fully programmatic catalog construction.

## Install

```bash
pnpm add @ratel-ai/mcp-server @ratel-ai/sdk @modelcontextprotocol/sdk
```

## CLI

```bash
ratel-mcp-server <config.json>
```

The config mirrors Claude Code's `.claude.json` `mcpServers` shape so a future migration is a passthrough copy:

```json
{
  "mcpServers": {
    "ev": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"]
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer xyz" }
    }
  }
}
```

`type` defaults to `"stdio"` when absent. `stdio` and `http` are wired up; `sse` and unknown types are accepted by the parser but skipped at runtime with a stderr warning. If any single upstream fails to start, the failure is logged and the rest still register — Ratel's own server stays up.

Logs go to stderr only (stdout is reserved for stdio MCP traffic). The CLI handles `SIGINT` / `SIGTERM` for clean shutdown of every upstream.

Wire it into Claude Code, Claude Desktop, or any MCP host as the single MCP entry; pull your previous upstream MCPs into Ratel's config file. To poke at it manually with the [MCP Inspector](https://modelcontextprotocol.io):

```bash
npx @modelcontextprotocol/inspector ratel-mcp-server ./ratel-mcp.json
```

For local development inside the workspace (no `bin` symlink yet), invoke `node` against the built bin:

```bash
pnpm -F @ratel-ai/mcp-server build
node src/integrations/mcp-server/dist/bin.js ./ratel-mcp.json
```

## Library

For programmatic use without a config file:

```ts
import { ToolCatalog } from "@ratel-ai/sdk";
import { createMcpServer } from "@ratel-ai/mcp-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const catalog = new ToolCatalog();
catalog.register({
  id: "read_file",
  name: "read_file",
  description: "Read a file from local disk.",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  outputSchema: { type: "object", properties: { contents: { type: "string" } } },
  execute: async ({ path }) => ({ contents: await fs.readFile(path, "utf8") }),
});

const handle = await createMcpServer(catalog, {
  name: "ratel-gateway",
  version: "0.0.0",
  transport: new StdioServerTransport(),
});

// later, on shutdown:
await handle.close();
```

`parseConfig` and `buildGatewayFromConfig` are exported alongside `createMcpServer` if you want to drive the same config-aggregating path programmatically (e.g. from inside another Node process).

The MCP client connected to the other end will see exactly two tools: `search_tools` and `invoke_tool`. The catalog's tools are reachable through `invoke_tool`, never listed directly — that's the whole point (see [ADR 0003](../../../docs/adr/0003-tool-selection-replace-vs-suggest.md)).

## Result wrapping

Every `tools/call` response carries the gateway's return value as a JSON-serialized text block; plain-object returns are also surfaced as `structuredContent`:

```json
{
  "content": [{ "type": "text", "text": "{\"foo\":1}" }],
  "structuredContent": { "foo": 1 }
}
```

Arrays (e.g. the hits returned by `search_tools`) only travel in `content[0].text`, since MCP requires `structuredContent` to be a JSON object.

When `invoke_tool` drives a tool that was itself registered via `registerMcpServer`, the upstream's MCP-shaped result (`{ content, structuredContent }`) is nested inside our `structuredContent` one level deeper. Accepted as a layered artifact for now; revisit if telemetry surfaces real friction.

`invokeToolTool`'s wrapped error payload (`{ error: "..." }` for unknown ids or executor throws) flows through as an ordinary structured result rather than an MCP `isError: true` — clients can branch on the field.

## Build & test

Part of the pnpm workspace at the repo root. From this folder:

```bash
pnpm build       # tsc → dist/
pnpm typecheck
pnpm lint        # biome
pnpm test        # vitest
```
