# Ratel

The **Context Engineering platform for AI agents** — the layer that decides what ends up in an agent's context.

v1 ships two things: **smart, telemetry-driven tool selection** and **OAuth/auth lifecycle** as table-stakes infrastructure. Usable both as an in-process library and as a self-hostable server. One concrete integration is an MCP gateway (`ratel-mcp-server`), but the core is generic and works for agents that use internal APIs, function calls, or any tool surface — not just MCP servers.

The lib runs with **zero infra dependencies** in local mode (SQLite + FTS5 + sqlite-vec + bundled local embeddings via fastembed-rs). The server unlocks fleet-scale features that lib-only can't deliver — central token vault with shared refresh, cross-session telemetry-driven learning, fleet observability — while keeping a single `Backend` interface so the local↔remote distinction is one config switch, not a code change.

## Status

**v1 in active development on the `revamp` branch.** The current `main` branch runs the prior prototype (`agentified-*` packages) and stays untouched until the cutover at the end of Phase 7.

Phase 0 (scaffold + lock cross-cutting decisions) is in progress. See [`docs/RATEL_PHASE_0.md`](docs/RATEL_PHASE_0.md) for the operational plan and [`docs/adr/`](docs/adr/) for the resulting decisions.

Install instructions, code samples, and the demo will land at the end of Phase 2 / Phase 3.

## Pointers

- **v1 plan:** [`docs/RATEL_V1_PLAN.md`](docs/RATEL_V1_PLAN.md) — thesis, competitive landscape, architecture, locked decisions, phase-by-phase implementation plan.
- **Phase 0 plan:** [`docs/RATEL_PHASE_0.md`](docs/RATEL_PHASE_0.md) — scaffold + decision-locking workstream.
- **Architecture decision records:** [`docs/adr/`](docs/adr/) — the durable record of cross-cutting choices.

## Repo layout

```
src/
├── core/          # primary product surface — ratel-core lib + ratel-server (Rust)
├── integrations/  # wrapper tier — ratel-mcp-server, ratel-cli (binary `ratel`)
└── sdks/          # language SDKs — TS first (@ratel-ai/sdk), Python second (Phase 5)
docs/              # planning + ADRs
scratch/           # research spikes (eval harnesses, throwaway code)
```

## License

Source-available under the **Elastic License 2.0**, with an additional grant making it free to use in OSI-approved open-source projects. Non-open-source / commercial production use requires a commercial license. See [LICENSE.md](LICENSE.md) for the full terms.
