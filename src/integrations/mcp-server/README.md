# `@ratel-ai/mcp-server`

Library that exposes a Ratel [`ToolCatalog`](../../sdk/ts/README.md) as a Model Context Protocol server. Any MCP-speaking client (Claude Desktop, an agent framework, an `@modelcontextprotocol/sdk` `Client`) can drive Ratel's gateway — `search_tools` to rank the catalog by query, `invoke_tool` to dispatch a hit by id — over stdio, Streamable HTTP, SSE, or any other [transport](https://modelcontextprotocol.io) you wire up.

This is the inverse of `@ratel-ai/sdk`'s [`registerMcpServer`](../../sdk/ts/README.md#registermcpserver--index-an-mcp-servers-tools-into-the-catalog), which ingests an upstream MCP server's tools *into* a catalog. `createMcpServer` exposes a catalog *as* an MCP server.

`buildGatewayFromConfig` is the higher-level entry point: it takes a parsed Ratel config (an `mcpServers` map mirroring Claude Code's shape), spins up an upstream MCP `Client` per entry, registers each upstream's tools into a fresh catalog, and returns the catalog plus the per-upstream metadata used by `search_tools`'s description and the server-level `instructions` block.

For the user-facing CLI (`ratel mcp add` / `serve` / `import` / …), see [`@ratel-ai/cli`](../cli/README.md).

## Install

```bash
pnpm add @ratel-ai/mcp-server @ratel-ai/sdk @modelcontextprotocol/sdk
```

## Library

### `createMcpServer`

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

The MCP client connected to the other end will see exactly two tools: `search_tools` and `invoke_tool`. The catalog's tools are reachable through `invoke_tool`, never listed directly — that's the whole point (see [ADR 0003](../../../docs/adr/0003-tool-selection-replace-vs-suggest.md)).

### `buildGatewayFromConfig`

```ts
import { buildGatewayFromConfig, parseConfig } from "@ratel-ai/mcp-server";

const config = parseConfig(JSON.parse(await fs.readFile("./ratel-config.json", "utf8")));
const gateway = await buildGatewayFromConfig(config, {
  // optional: provide a custom transport factory
  // transportFactory: (name, entry) => myTransport(name, entry),
  logger: (m) => console.error(m),
});

// gateway.catalog       -> ToolCatalog with every upstream tool registered
// gateway.upstreamServers -> [{ name, description?, toolCount }] for the search-tools description block
// await gateway.close() -> tears down every upstream client
```

If an upstream has no `description` set in the Ratel config, the gateway falls back to the upstream's own server-level MCP `instructions` (read at `Client.connect` time). When neither is set, the per-upstream description is omitted from the `search_tools` listing.

Per-upstream descriptions are compacted at render time in `formatUpstreamLine` (newlines collapsed, capped at ~160 chars with a trailing ellipsis). The full text is preserved in storage and in the server-level `instructions` block; only the per-tool listing is shortened so a few verbose upstreams don't blow up `search_tools`'s description.

## Config shape

The config mirrors Claude Code's `.claude.json` `mcpServers` shape:

```json
{
  "mcpServers": {
    "ev": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "description": "filesystem & shell utilities"
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer xyz" }
    }
  }
}
```

`type` defaults to `"stdio"` when absent. `description` is optional Ratel-only metadata — used to seed the agent's awareness of each upstream via `search_tools`'s description, never sent over the upstream transport. `stdio` and `http` are wired up by `defaultTransportFactory`; `sse` and unknown types are accepted by `parseConfig` but skipped at runtime by the default factory (provide your own factory for sse).

If any single upstream fails to start, `buildGatewayFromConfig` logs the failure and the rest still register — the gateway stays available.

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
