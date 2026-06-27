# `src/integrations/`

Auxiliary tooling that sits on top of the library (`@ratel-ai/sdk` / `ratel-ai-core`) — packages that wrap, surface, or inspect what the library produces, without adding library functionality. The first canonical *external-protocol surface* (MCP) used to live here too; it now ships from the **showcase** sibling repo [`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-mcp) as `@ratel-ai/mcp-server` (library + `ratel-mcp` CLI), and the `cli/` below depends on its published npm artifact.

## Layout

```
cli/           @ratel-ai/cli       — `ratel` CLI: inspect telemetry, manage MCP scopes (transitional), front Claude Code
cloud/         @ratel-ai/cloud     — cloud analytics client: batch + ship usage rollups to the Ratel dashboard
```

## `cli/` — `@ratel-ai/cli`

The `ratel` binary. Two roles:

1. **Library-side, long-term.** Inspect the artifacts the library produces. `ratel inspect` summarizes the most recent telemetry session into ASCII tables; `ratel inspect ls` lists what's on disk per project bucket. As the library's telemetry / suggestion / trace-server surface widens (see the [roadmap](../../docs/roadmap.md)), new verbs land here.
2. **Showcase-adjacent, transitional.** `ratel serve` / `ratel mcp …` / `ratel backup …` keep working — they consume the same published `@ratel-ai/mcp-server` that the showcase repo's `ratel-mcp` CLI uses. Over time these verbs migrate to `ratel-mcp`; the local `ratel` binary narrows to library artifacts.

For the canonical MCP UX (`mcp import` / `add` / `auth` / `serve`), reach for `npx -y @ratel-ai/mcp-server` from [`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-mcp). See [`cli/README.md`](cli/README.md) for the full verb reference of `@ratel-ai/cli` as it stands today.

## `cloud/` — `@ratel-ai/cloud`

The cloud analytics client. Batches the *usage rollups* `@ratel-ai/sdk` assembles (`buildRollup`) and ships them to `{host}/api/v1/events` — the shape the Ratel dashboard renders. Env-configured (`RATEL_API_KEY`, `RATEL_HOST`), best-effort, a no-op without an API key. See [`cloud/README.md`](cloud/README.md). Design: [ADR-0013](../../docs/adr/0013-observability-and-analytics.md).
