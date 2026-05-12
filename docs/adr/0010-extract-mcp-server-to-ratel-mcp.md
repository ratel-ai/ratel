# 10. Extract `@ratel-ai/mcp-server` to a sibling repo

Date: 2026-05-12

## Status

Accepted

## Context

`@ratel-ai/mcp-server` was added in v0.1.2 as a workspace package inside this repo, alongside `@ratel-ai/cli` which drives it. As of v0.1.5 the MCP-server library has acquired its own surface area worth maintaining independently:

- A library API (`createMcpServer`, `buildGatewayFromConfig`, `parseConfig`, `runAuthFlow`, an `auth` tool) plus an OAuth 2.1 / PKCE subsystem with cross-process locking that has a lifecycle of its own.
- A planned CLI front (`npx @ratel-ai/mcp-server serve` / `mcp add` / `mcp list` / …) that takes over the MCP-management UX currently bolted onto the `ratel` binary. The split frees `@ratel-ai/cli` to become the long-term CLI for *ratel artifacts* (telemetry inspection today; future trace-consolidation server, etc.) without the MCP-host UX riding inside.
- Different consumers, different cadence: the MCP-server library tracks MCP spec evolution (transports, OAuth-DCR, `tools/list_changed` semantics, …) which is largely orthogonal to BM25 retrieval, the SDK loader, or the CLI's telemetry verbs.

Co-located lockstep versioning (one bump touches four artifacts) has been forcing unrelated releases: a CLI-only telemetry fix had to ride a no-op `@ratel-ai/mcp-server` bump, and vice versa.

Three options were considered:

1. **Keep everything in-tree** — simplest, but the coupling tax compounds and the planned MCP-server CLI would make this repo's package layout misleading (a CLI named "MCP server" alongside a CLI named just "CLI").
2. **Promote `@ratel-ai/mcp-server` into a feature flag inside `@ratel-ai/cli`** — collapses two artifacts but doubles the surface area of the cli and conflates two product stories.
3. **Move `@ratel-ai/mcp-server` to a sibling repo `ratel-ai/ratel-mcp`** — independent release cadence, room for the MCP-server CLI, and the cli's coupling shrinks to "consumes a published npm package."

ADR-0008 (per-package CHANGELOGs) was written assuming four lockstep artifacts shipped from this repo. That assumption is now wrong; this ADR supersedes it on that specific point.

## Decision

1. `@ratel-ai/mcp-server` is hosted in a sibling repo, [`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-mcp), and published independently to npm. The package name is unchanged.
2. The companion example (`examples/mcp-server/` — Claude Code + Ratel gateway + an upstream MCP) moves with it.
3. This repo publishes three lockstep artifacts: `ratel-ai-core`, `@ratel-ai/sdk`, `@ratel-ai/cli`. The release workflow, the publish-rc bootstrap script, the changelog skill, and the docs are updated accordingly.
4. `@ratel-ai/cli` in this repo consumes `@ratel-ai/mcp-server` from npm as an ordinary dependency, pinned to a published version range. The cli's own source, command surface, and version are otherwise untouched by this extraction.
5. `@ratel-ai/sdk`'s `registerMcpServer` — the *ingestion* side, where Ratel acts as an MCP client — stays in this repo. It depends on `@modelcontextprotocol/sdk` directly, not on `@ratel-ai/mcp-server`, and serves a distinct use case (pulling upstream MCP tools into a `ToolCatalog`).
6. A follow-up will peel the `mcp`/`serve`/`backup` verbs out of `@ratel-ai/cli` and into a `ratel-mcp` CLI in the sibling repo. That refactor is deferred and not part of this ADR's decision.

## Consequences

- This repo's footprint shrinks; the release pipeline pack/publishes one fewer artifact (seven npm tarballs + one crate, down from eight + one).
- The cli's `@ratel-ai/mcp-server` workspace-protocol dep becomes a real npm range, so cli builds and tests in this workspace exercise the *published* MCP-server, not a local checkout. Local iteration on MCP-server behavior happens in `ratel-mcp`; cli integration is verified by bumping the consumed range here when needed.
- Lockstep enforcement in `release.yml`'s `tag-version-check` now covers three manifests; the CHANGELOG gate enforces three CHANGELOGs. ADR-0008's "four artifacts" framing is superseded on this point only; the per-package CHANGELOG mechanism itself is unchanged.
- Until the follow-up cli refactor lands, `ratel mcp …` / `ratel serve` / `ratel backup` keep working — they run against published `@ratel-ai/mcp-server`. User-visible behavior is unchanged.
- The `ratel-mcp` repo carries its own CI, releases, ADRs, and roadmap. Coordination between repos is by published versions; there is no submodule, monorepo workspace link, or shared lockfile.
