<div align="center">
  <h1>@ratel-ai/cli</h1>
  <h4>The <code>ratel</code> CLI — manage MCP servers across scopes and front Claude Code with Ratel.</h4>

  <p>
    <a href="../../../docs/">Docs</a> •
    <a href="../../../docs/roadmap.md">Roadmap</a> •
    <a href="https://discord.gg/hdKpx69NR">Discord</a>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@ratel-ai/cli"><img src="https://img.shields.io/npm/v/@ratel-ai/cli?label=npm&color=cb3837" alt="npm" /></a>
    <a href="https://github.com/ratel-ai/ratel/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel?style=social" alt="GitHub stars" /></a>
    <a href="https://discord.gg/hdKpx69NR"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&color=7289da&label=discord" alt="Discord" /></a>
    <a href="../../../LICENSE.md"><img src="https://img.shields.io/badge/license-ELv2-blue" alt="license" /></a>
  </p>
</div>

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
| `remove [--scope <s>] --name <n>` | Remove an entry from a scope. `--scope` defaults to `user`. |
| `list` | List MCP servers configured across Ratel scopes. |
| `get <name> [--scope <s>]` | Print one entry's resolved details. Without `--scope`, walks local → project → user. |
| `edit [--scope <s>] --name <n>` | Edit fields on an existing entry. `--scope` defaults to `user`. Pass any subset of `--description`, `--type`, `--command`, `--arg` (repeatable), `--env KEY=VAL` (repeatable; `KEY=` clears one), `--cwd`, `--url`, `--header KEY=VAL`. `--entry-json '{...}'` does a full replacement. With no flags, prompts interactively. |
| `import` | Migrate Claude Code's existing MCP servers into Ratel. Two stages: (a) pick which upstreams to migrate, optionally describe each (each prompt is pre-filled with the upstream's MCP `instructions` if it exposes one), then confirm Ratel writes; (b) confirm the Claude rewrite that points Claude at `ratel mcp serve`. Deselected entries stay in Claude untouched. Decline Stage B and re-run `import` (or run `link`) later. |
| `link` | Stage B alone: rewrites Claude's config to point at Ratel for entries already present in Ratel scopes. Useful after a declined Stage B or hand-authored Ratel configs. |
| `auth [<name>] [--check]` | Refresh-or-reauth HTTP/SSE upstreams. **Refresh-first**: if a `refresh_token` is on disk, rotates silently — no browser pops. Falls back to PKCE only when refresh is impossible or fails. The output annotates each row as `authorized (refreshed)` or `authorized (re-authed)` so you know which path ran. With `--check`, prints expiry status per upstream without touching the network: `[ok] expires in 23h 12m`, `[expired] expired 5h ago, refresh available`, `[needs auth]`, `[n/a]` for stdio. |

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
| `--scope user\|project\|local` | Which Ratel scope to write to. Defaults to `user`. |
| `--env KEY=VALUE` / `-e KEY=VALUE` | Environment variable for stdio entries. Repeatable. |
| `--header "Name: Value"` | HTTP header for http/sse entries. Repeatable. |
| `--client-id <id>` / `--client-secret <s>` / `--callback-port <n>` / `--oauth-scope <s>` | OAuth client config for http/sse entries. `--client-id` / `--client-secret` are for upstreams that don't support Dynamic Client Registration (DCR is preferred — pass `--client-id` only when you must). `--callback-port` pins the loopback redirect port (required when the auth server expects a fixed redirect URI). `--oauth-scope` is the initial requested scope; the SDK handles 403-upscope independently. `--client-secret` is stored as plaintext in the Ratel config — a warning is logged when set. |
| `--description <text>` | Ratel-only: human description of the server. Wins over the auto-fetched upstream instructions. |
| `--no-fetch-description` | Skip the auto-probe entirely — no connect, no description fetch, no OAuth flow. |
| `--force` | Overwrite an existing entry of the same name in the chosen scope. |

By default, after the entry is assembled, `mcp add` connects to the upstream and stores its server-level `instructions` (per the MCP spec) as the entry's `description`. Behavior by transport:

- **stdio**: silent connect → read instructions → close.
- **http / sse**: drives the OAuth 2.1 / PKCE flow against the upstream (browser opens to authorize), persists tokens to `~/.ratel/oauth/<name>.json`, then reads instructions. After this, the entry is fully usable by `ratel mcp serve` — no follow-up `ratel mcp auth` required.

Pass `--description` to override the fetched text (the OAuth flow still runs for http/sse so tokens get persisted). Pass `--no-fetch-description` to skip the probe entirely (useful in CI / headless boxes — you can run `ratel mcp auth <name>` from a workstation later). A failed probe / declined authorization is logged with a hint to retry via `ratel mcp auth <name>` and does not fail the add.

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

## OAuth flow

HTTP and SSE upstreams that require OAuth authorization are handled at the gateway layer ([`@ratel-ai/mcp-server`'s OAuth section](../mcp-server/README.md#oauth-protected-upstreams) has the architectural detail). From the CLI:

1. `ratel mcp add --scope user my-upstream https://mcp.example/mcp [--client-id <id>] [--callback-port <n>] [--oauth-scope "<s>"]` — records the entry **and** drives the OAuth flow inline: opens your default browser to the upstream's authorization URL, captures the redirect on `127.0.0.1:<port>`, exchanges the code for tokens, persists them at `~/.ratel/oauth/my-upstream.json` (mode 0600). Most upstreams support Dynamic Client Registration; only pass `--client-id` if yours doesn't. Pass `--no-fetch-description` to defer auth (handy on headless boxes — see step 2).
2. `ratel mcp auth my-upstream` — refresh-first. If a `refresh_token` is on disk, rotates silently with no browser involvement (output: `authorized (refreshed)`). Falls back to PKCE — opens the browser, completes the loopback redirect — only when no refresh token is available or the auth server rejects the refresh (output: `authorized (re-authed)`). With no `<name>`, runs against every upstream the merged config marks `needsAuth`.
3. `ratel mcp auth --check` — read-only status report. Walks the merged config and prints, per upstream, whether tokens are present, whether a refresh token is available, and the time-to-expiry (or "expired N ago"). No network calls, no flow.
4. `ratel mcp list` — single-line auth column for each entry: `ok` / `expired` / `needs auth` / `n/a`.

When the gateway boots, every HTTP/SSE upstream with stored tokens runs through a proactive refresh — expired access tokens are rotated up front so the catalog comes online with fresh credentials. If the auth server rejects the refresh (e.g. revoked refresh token), the upstream is flagged `needsAuth: true` rather than blocking the boot — the agent can call the `auth` MCP tool, or you can run `ratel mcp auth <name>`, to recover. A 401 during a live `invoke_tool` returns `{ error: "needs_auth", upstream }` so the agent can branch and call `auth` itself.

Token state is per-user-per-machine (`~/.ratel/oauth/`), not per-config-scope. Multiple Ratel gateways running on the same host (e.g. several Claude Code sessions, or a CLI invocation overlapping a `serve`) refresh through a cross-process file lock so they cannot race on the same `refresh_token` — only one process performs the network refresh; the rest read the rotated tokens from disk under the same lock.

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
