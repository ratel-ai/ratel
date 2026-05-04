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
ratel-mcp-server [<subcommand>] [--config <path> ...]
```

### Subcommands

| Subcommand | Purpose |
|---|---|
| (default) / `run` | Start the gateway over stdio. Pass one or more configs via `--config` (or a single positional path); right-most wins on key collision. |
| `import` | Migrate Claude Code's existing MCP servers into Ratel. Two stages: (a) pick which upstreams to migrate, optionally describe each, then confirm Ratel writes; (b) confirm the Claude rewrite that points Claude at Ratel for the migrated entries. Deselected entries stay in Claude's config untouched. Decline Stage B and re-run `import` (or run `link`) later. |
| `link` | Stage B alone: rewrites Claude's config to point at Ratel for entries already present in Ratel scopes. Useful after a declined Stage B or hand-authored Ratel configs. Entries Ratel doesn't know about are left alone in Claude. |
| `add --scope <s> --name <n>` | Add an entry to a Ratel scope. Use `--command <cmd>` for a stdio entry, or `--entry-json '{...}'` for full control. Optional `--description <text>`. `--force` to overwrite. |
| `edit --scope <s> --name <n>` | Edit fields on an existing Ratel entry. Pass any subset of `--description`, `--type`, `--command`, `--arg` (repeatable), `--env KEY=VAL` (repeatable; `KEY=` clears one), `--cwd`, `--url`, `--header KEY=VAL` (repeatable). `--entry-json '{...}'` does a full replacement. With no flags, prompts interactively. |
| `remove --scope <s> --name <n>` | Remove an entry from a Ratel scope. |
| `list` | List backup sets created under `~/.ratel/backups/`. |
| `undo` | Restore the most recent backup set. Prompts for confirmation. |
| `help` / `--help` / `-h` | Show usage. |

### Three-scope hierarchy

Ratel mirrors Claude Code's MCP scoping with three logical configs:

| Scope | Path | Notes |
|---|---|---|
| global | `~/.ratel/config.json` | Per-user, applies everywhere. |
| project | `<root>/.ratel/config.json` | Committed alongside the repo. |
| local | `<root>/.ratel/config.local.json` | Per-user-per-project; **add to your project's `.gitignore`**. |

When you run the gateway with `--config a.json --config b.json --config c.json`, the configs are merged in order — last wins on `mcpServers` key collisions. The `import` wizard wires the right `--config` chain into Claude Code at each scope:

| Claude scope | Ratel entry's `--config` chain |
|---|---|
| global (`~/.claude.json` root `mcpServers`) | `[global]` |
| project (`<root>/.mcp.json`) | `[global, project]` |
| local (`~/.claude.json` `projects[<root>].mcpServers`) | `[global, project, local]` |

### Backups & undo

Every `import`, `link`, `add`, `edit`, and `remove` snapshots the files it touches into `~/.ratel/backups/<ISO>/` (with a `manifest.json` describing what was captured). `ratel-mcp-server undo` restores the most recent set byte-for-byte. `ratel-mcp-server list` shows what's available.

### Agent discoverability

The gateway pushes host agents to consult Ratel before reaching for built-in capabilities, on two channels:

- **Server-level `instructions`** (delivered in the MCP `initialize` response and surfaced by hosts as a system-prompt block, e.g. Claude Code's MCP-instructions block): prescriptive — "before reaching for any built-in capability, call `search_tools` first" — followed by the same upstream list. Most universal channel; fires before the agent picks its first tool.
- **`search_tools` tool description**: same upstream list, attached to the tool that consumes it.

Each upstream entry shows name, optional human description (from `description` set during `import`/`add`/`edit`), and the live tool count from `tools/list`. Both channels are derived from the same source — there's no separate config knob.

### Locating the binary for Claude Code

When the wizard writes the `ratel` entry into Claude's config, it has to record an absolute command. The cascade is: `$RATEL_MCP_BIN` → `which ratel-mcp-server` on PATH → walk up to `pnpm-workspace.yaml` and use the workspace's built `dist/bin.js` (run via `node`) → ask you. Set `RATEL_MCP_BIN` to skip the cascade.

### Config shape

The config mirrors Claude Code's `.claude.json` `mcpServers` shape so the import path is a near-passthrough:

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

`type` defaults to `"stdio"` when absent. `description` is optional Ratel-only metadata — used to seed the agent's awareness of each upstream via `search_tools`'s description, never sent over the upstream transport. `stdio` and `http` are wired up; `sse` and unknown types are accepted by the parser but skipped at runtime with a stderr warning. If any single upstream fails to start, the failure is logged and the rest still register — Ratel's own server stays up.

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
