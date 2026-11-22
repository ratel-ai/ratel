# 2. Products and repositories

## Status

Accepted

## Context

Ratel decides what enters an agent's context window. The engine runs inside the agent
process, and a platform reads what agents do and serves their catalogs. These parts have
different toolchains, release cadences and audiences.

## Decision

| Product | What it is | Repository |
|---|---|---|
| Ratel SDK | the engine (`ratel-ai-core`), the TypeScript and Python SDKs, the framework adapters, the telemetry packages and the catalog protocol | [ratel-ai/ratel-sdk](https://github.com/ratel-ai/ratel-sdk) (open source) |
| Ratel Platform (OSS) | the self-hosted application in `src` (`@ratel/platform`) and the UI packages in `packages/` | this repository (open source) |
| Ratel Cloud | the managed edition of the platform: this repository plus private modules ([ADR-0003](0003-two-editions-one-application.md)) | `ratel-ai/ratel-platform` (private) |
| ratel-local | the local MCP gateway (`@ratel-ai/mcp-server`) | [ratel-ai/ratel-mcp](https://github.com/ratel-ai/ratel-mcp) (open source) |
| ratel-bench | the benchmark harness and its results | [ratel-ai/ratel-bench](https://github.com/ratel-ai/ratel-bench) (open source) |

**A component gets its own repository only when both are true:** it couples to the others
through a protocol or a published package (not shared source), and its toolchain or audience
is different. The platform uses the SDK as published npm packages and speaks to it through the
wire contracts of [ADR-0007](0007-sdk-wire-contracts.md), so the SDK lives apart. Ratel Cloud
is the one exception: it shares source with the platform, for the reasons in ADR-0003.

## Consequences

- This repository builds, tests and ships the platform only. An SDK change is released from
  `ratel-sdk` and reaches the platform through a version bump (`RELEASING.md`).
- A change to a wire contract starts in `ratel-sdk`; the platform follows.
- A new component is measured against the same two conditions before it gets a repository.
