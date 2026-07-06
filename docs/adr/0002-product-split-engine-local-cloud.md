# 2. Product split: engine / local / cloud

Date: 2026-07-05

## Status

Accepted

Compacted 2026-07 from the earlier product-split and MCP-server-extraction decisions, and
reframed by the catalog-source pivot ([ADR-0003](0003-catalog-source-interface.md)): a
standalone server product is deferred, not decided-and-coming. Git history holds the
pre-compaction records.

## Context

Ratel is one engine that decides what enters an agent's context window. The real variable is
where that engine runs and how an agent reaches it: linked in-process as a library, packaged
as a local distribution, or reached as a managed service. Those are three products with
different release cadences and audiences, so the boundaries between them need to be decided
rather than left implicit.

## Decision

### Three products, one engine, one catalog contract

| Product | What it is | Ships as | Repo |
|---|---|---|---|
| **ratel** (the platform) | the context-engineering engine and its embeddings into agent processes | `ratel-ai-core` crate + TS/Python SDKs + the [`protocol/`](../../protocol/README.md) catalog-source contract + the OTel telemetry conventions | this repo (OSS) |
| **ratel-local** | the local distribution shell: single-user gateway over MCP, editor/host integration, config, upstream OAuth | today `@ratel-ai/mcp-server` / the `ratel-mcp` CLI | sibling [`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-mcp) (OSS) |
| **ratel-cloud** | the managed product: the first catalog source ([ADR-0003](0003-catalog-source-interface.md)) plus the intelligence surfaces (suggestions, analytics, ranking) | hosted endpoint reached via `RATEL_URL` | closed |

`ratel-bench` (the benchmark harness and its published results) is a sibling OSS repo,
[`ratel-ai/ratel-bench`](https://github.com/ratel-ai/ratel-bench).

The adoption gradient is **in-process SDK → local distribution → managed cloud**. A
self-hosted server rung is deferred until real demand; if one ships it implements the
published `protocol/` contract ([ADR-0003](0003-catalog-source-interface.md)).

### One SDK API, two transports

The SDKs expose one API surface. Embedded FFI is the default and the floor: the engine linked
in-process, no infra. Setting `RATEL_URL` selects a remote **catalog source**: a loader pulls
the published catalog and hydrates the same local registries, and retrieval still runs
in-process ([ADR-0003](0003-catalog-source-interface.md)). Application code calling
`search` / `invoke` / `get_skill` does not change between transports.

### Repo-boundary rule

Default to the monorepo. A component ejects to its own repo only when **both** hold: its
coupling has dropped to protocol level (a wire contract or a published package, not shared
source or FFI), and its toolchain and audience diverge. Applied: the SDKs stay in-tree (FFI
coupling to the engine); `ratel-local` is ejected and stays ejected (protocol-level coupling,
app/editor toolchain, end-user audience); the cloud is closed in its own repo.

### The ratel-local boundary

- The `@ratel-ai/mcp-server` package lives in `ratel-ai/ratel-mcp` and publishes
  independently. Its *identity* is `ratel-local`, the local product; the package/binary/repo
  rename is deferred because the current names are load-bearing for real installs.
- The SDK's `registerMcpServer` (the ingestion side, where Ratel acts as an MCP client pulling
  upstream tools into a catalog) stays in this repo; it depends on the MCP SDK, not on
  `@ratel-ai/mcp-server`.
- Upstream OAuth 2.1 / PKCE (tokens under `~/.ratel/oauth/`) lives in the shell, never the
  engine, and never syncs ([ADR-0003](0003-catalog-source-interface.md)).

### Top-level product folders

`protocol/` sits at the repo top level beside `src/`: it is a product surface (the
catalog-source contract), not a code module. The folder-README convention covers top-level
product folders like any other.

## Consequences

- The product story is honest: what ships today is the library, the local distribution, and
  (privately) the cloud. No OSS server exists, and docs must not imply one does.
- `ratel-local` carries a name it does not publish under until the rename; docs state both.
- The repo-boundary rule is testable, not vibes; future components get measured against the
  same two gates.
- The catalog contract (`protocol/`) is the compatibility surface between the products;
  keeping the cloud's catalog half on-contract is what keeps a future server or third-party
  source cheap ([ADR-0003](0003-catalog-source-interface.md)).
