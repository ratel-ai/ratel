# `@ratel-ai/cli`

The `ratel` CLI: manage MCP servers across Ratel scopes, run the Ratel MCP gateway, and import Claude Code's existing MCP setup. The CLI is a thin orchestrator over [`@ratel-ai/mcp-server`](../mcp-server/README.md) (gateway + config types) and [`@ratel-ai/sdk`](../../sdk/ts/README.md) (catalog + upstream registration).

## Install

```bash
pnpm add -g @ratel-ai/cli
# or in a workspace:
pnpm add @ratel-ai/cli
```

## Usage

```bash
ratel <group> <verb> [args...]
ratel --help                 # top-level usage
ratel mcp                    # mcp group usage
ratel backup                 # backup group usage
```

### `ratel mcp`

| Verb | Purpose |
|---|---|
| `serve` | Start the gateway over stdio. Pass one or more configs via `--config`; right-most wins on `mcpServers` collisions. |
| `add` | Add an MCP server entry to a Ratel scope. **Mirrors `claude mcp add`** (see below). |
| `remove --scope <s> --name <n>` | Remove an entry from a scope. |
| `list` | List MCP servers configured across Ratel scopes. |
| `get <name> [--scope <s>]` | Print one entry's resolved details. Without `--scope`, walks local → project → user. |
| `edit --scope <s> --name <n>` | Edit fields on an existing entry. Pass any subset of `--description`, `--type`, `--command`, `--arg` (repeatable), `--env KEY=VAL` (repeatable; `KEY=` clears one), `--cwd`, `--url`, `--header KEY=VAL`. `--entry-json '{...}'` does a full replacement. With no flags, prompts interactively. |
| `import` | Migrate Claude Code's existing MCP servers into Ratel. Two stages: (a) pick which upstreams to migrate, optionally describe each (each prompt is pre-filled with the upstream's MCP `instructions` if it exposes one), then confirm Ratel writes; (b) confirm the Claude rewrite that points Claude at `ratel mcp serve`. Deselected entries stay in Claude untouched. Decline Stage B and re-run `import` (or run `link`) later. |
| `link` | Stage B alone: rewrites Claude's config to point at Ratel for entries already present in Ratel scopes. Useful after a declined Stage B or hand-authored Ratel configs. |

### `ratel backup`

| Verb | Purpose |
|---|---|
| `list` | List backup sets created under `~/.ratel/backups/`. |

(`ratel backup undo` exists and restores the most recent set, but is deliberately hidden from `--help`. Use it when you need to roll back the last `import`/`add`/`edit`/`remove`/`link`.)

## `ratel mcp add` — Claude-compatible

The positional and flag layout matches `claude mcp add`, so any invocation that works there works here unchanged.

```
ratel mcp add [flags] <name> -- <command> [args...]      # stdio
ratel mcp add [flags] <name> <url>                       # http / sse
```

| Flag | Meaning |
|---|---|
| `--transport stdio\|http\|sse` | Force a transport. Inferred otherwise (URL → http, `--` → stdio). |
| `--scope user\|project\|local` | Which Ratel scope to write to. Default: prompted / required. |
| `--env KEY=VALUE` / `-e KEY=VALUE` | Environment variable for stdio entries. Repeatable. |
| `--header "Name: Value"` | HTTP header for http/sse entries. Repeatable. |
| `--client-id <id>` / `--client-secret` / `--callback-port <n>` | OAuth client config. Captured but **not yet wired** (deferred to v0.1.4). A note is logged when set. |
| `--description <text>` | Ratel-only: human description of the server. Wins over the auto-fetched upstream instructions. |
| `--no-fetch-description` | Skip the auto-fetch step (see below). |
| `--force` | Overwrite an existing entry of the same name in the chosen scope. |

By default, after the entry is assembled, `mcp add` briefly connects to the upstream (5s timeout), reads the server-level `instructions` field (per the MCP spec), and stores it as the entry's `description`. Pass `--description` to override, or `--no-fetch-description` to skip the probe entirely. A failed probe is silent and leaves the description blank; you can fill it in later with `ratel mcp edit --description`.

Examples:

```bash
ratel mcp add --scope user stripe https://mcp.stripe.com \
  --transport http --header "Authorization: Bearer $STRIPE_KEY"

ratel mcp add --scope project airtable -e API_KEY=xyz -- npx -y airtable-mcp-server

ratel mcp add --scope user --description "filesystem & shell utilities" \
  ev -- npx -y @modelcontextprotocol/server-everything
```

## Three-scope hierarchy

Ratel mirrors Claude Code's MCP scoping with three logical configs:

| Scope | Path | Notes |
|---|---|---|
| user | `~/.ratel/config.json` | Per-user, applies everywhere. |
| project | `<root>/.ratel/config.json` | Committed alongside the repo. |
| local | `<root>/.ratel/config.local.json` | Per-user-per-project; **add to your project's `.gitignore`**. |

When you run `ratel mcp serve --config a.json --config b.json --config c.json`, the configs are merged in order — last wins on `mcpServers` key collisions. The `import` wizard wires the right `--config` chain into Claude Code at each scope:

| Claude scope | Args of the `ratel` entry written into Claude's config |
|---|---|
| user (`~/.claude.json` root `mcpServers`) | `["mcp", "serve", "--config", <user>]` |
| project (`<root>/.mcp.json`) | `["mcp", "serve", "--config", <user>, "--config", <project>]` |
| local (`~/.claude.json` `projects[<root>].mcpServers`) | `["mcp", "serve", "--config", <user>, "--config", <project>, "--config", <local>]` |

## Backups & undo

Every `import`, `link`, `add`, `edit`, and `remove` snapshots the files it touches into `~/.ratel/backups/<ISO>/` (with a `manifest.json` describing what was captured). `ratel backup undo` restores the most recent set byte-for-byte. `ratel backup list` shows what's available.

## Locating the binary for Claude Code

When the wizard writes the `ratel` entry into Claude's config, it has to record an absolute command. The cascade is: `$RATEL_BIN` → `which ratel` on PATH → walk up to `pnpm-workspace.yaml` and use the workspace's built `src/integrations/cli/dist/bin.js` (run via `node`) → ask you. Set `RATEL_BIN` to skip the cascade.

## Build & test

Part of the pnpm workspace at the repo root. From this folder:

```bash
pnpm build       # tsc → dist/
pnpm typecheck
pnpm lint        # biome
pnpm test        # vitest
```
