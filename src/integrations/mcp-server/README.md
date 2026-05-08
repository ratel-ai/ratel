<div align="center">
  <h1>@ratel-ai/mcp-server</h1>
  <h4>Expose a Ratel catalog over MCP — the host sees two tools instead of every upstream's full list.</h4>

  <p>
    <a href="../../../docs/">Docs</a> •
    <a href="../../../docs/roadmap.md">Roadmap</a> •
    <a href="https://discord.gg/hdKpx69NR">Discord</a>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@ratel-ai/mcp-server"><img src="https://img.shields.io/npm/v/@ratel-ai/mcp-server?label=npm&color=cb3837" alt="npm" /></a>
    <a href="https://github.com/ratel-ai/ratel/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel?style=social" alt="GitHub stars" /></a>
    <a href="https://discord.gg/hdKpx69NR"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&color=7289da&label=discord" alt="Discord" /></a>
    <a href="../../../LICENSE.md"><img src="https://img.shields.io/badge/license-ELv2-blue" alt="license" /></a>
  </p>
</div>

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

## OAuth-protected upstreams

HTTP and SSE upstreams that require OAuth 2.1 authorization run through the library's loopback PKCE flow. `buildGatewayFromConfig` attempts to register every upstream at boot:

- **Proactive refresh.** For each HTTP/SSE upstream with a token file at `~/.ratel/oauth/<name>.json`, the gateway checks `expires_at` and refreshes up front if the access token is expired or near expiry. The refresh runs through the SDK's `refreshAuthorization` helper using the stored refresh token, client information, and authorization-server metadata — no browser involvement.
- **Cross-process lock.** Refresh is wrapped in a double-checked-locking transaction over a [`proper-lockfile`](https://www.npmjs.com/package/proper-lockfile) file lock keyed on the token-store path. When several Ratel gateways are alive on the same host (e.g. multiple Claude Code sessions, or a CLI overlapping a `serve`) only one performs the network refresh; the rest read the rotated tokens from disk under the same lock. The same lock also protects every `RatelOAuthStore.save()` against the read-modify-write race that previously could drop interleaved partial updates.
- **Reactive refresh.** During live use, `StreamableHTTPClientTransport` still handles 401s by refreshing through the OAuth provider; in-process concurrency on a single transport is serialized by `transport-mutex.ts`.
- **Fall-through to `needsAuth`.** If proactive refresh fails (`invalid_grant`, network error, missing client information), or the boot register call throws an SDK auth-shaped error (e.g. the legacy `prepareTokenRequest` failure mode), the upstream is flagged `needsAuth: true` on `gateway.upstreamServers`, retained in the gateway's config map, and waits for an interactive flow. The boot does **not** open a browser autonomously.

The handle exposes:

```ts
const gateway = await buildGatewayFromConfig(config);

// Drive the interactive flow for one or every needs-auth upstream.
await gateway.runAuthFlow();              // every upstream marked needsAuth
await gateway.runAuthFlow({ name: "stripe" }); // a single upstream

// Wire `notifications/tools/list_changed` so hosts re-list after a successful flow.
gateway.setListChangedNotifier(async () => {
  await mcpServer.sendToolListChanged();
});
```

`createMcpServer` wires it for you: pass `runAuthFlow: gateway.runAuthFlow` and call `gateway.setListChangedNotifier(handle.notifyToolListChanged)`. The MCP server then exposes a third `auth` tool whose description recomputes on every list to reflect the live `needsAuth` state, declares the `tools.listChanged` capability, and translates `invoke_tool` 401s into a structured `{ error: "needs_auth", upstream }` payload (no exception out of the tool — the agent can branch on the field and call `auth` to recover).

`runAuthFlow` itself is **refresh-first**: when the upstream's store has a `refresh_token`, it attempts a silent refresh first (sharing the same cross-process lock as the boot path) and reports `mode: "refresh"` on success. Only when refresh is impossible or fails does it spin up the loopback callback server and run PKCE, reporting `mode: "interactive"`.

The CLI surface (`ratel mcp auth`, the OAuth columns in `ratel mcp list`) lives in [`@ratel-ai/cli`](../cli/README.md).

## Telemetry

Pass `trace` to `buildGatewayFromConfig` to forward it to the underlying `ToolCatalog` ([ADR 0009](../../../docs/adr/0009-trace-events-core-owned-schema.md)). The catalog emits search / invoke / gateway / upstream events; this library adds `auth_refresh`, `auth_needs`, `auth_flow_start`, and `auth_flow_end` around the OAuth boot and interactive paths.

```ts
const gateway = await buildGatewayFromConfig(config, {
  trace: {
    kind: "jsonl",
    sessionId: "session-1",
    path: "/tmp/ratel.jsonl",
  },
});
```

Default is no-op — opt in to capture. The CLI's `ratel mcp serve` defaults to a JSONL sink under `~/.ratel/telemetry/`; see [`@ratel-ai/cli`](../cli/README.md) for the flags.

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
