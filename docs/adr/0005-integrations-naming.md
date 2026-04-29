# 5. Integrations naming

Date: 2026-04-29

## Status

Accepted

## Context

The wrapper tier above `core/` (currently `ratel-mcp-server`, `ratel-cli`; future LangChain / OpenAI Agents / Vercel AI SDK adapters) needs a directory name that:

1. Doesn't collide with "gateway" — that word belongs to a *role* users assign to `ratel-mcp-server` deployments, not to a code category.
2. Doesn't collide with "adapter" — too generic; downstream `Backend` impls and `Embedder` impls would equally qualify.
3. Extends naturally to non-MCP wrappers as the integration surface grows.

See `docs/RATEL_V1_PLAN.md` §3.

## Decision

Use **`integrations/`** as the directory name for the wrapper tier. v1 ships:

- `integrations/mcp-server/` — `ratel-mcp-server`, the MCP gateway integration.
- `integrations/cli/` — `ratel-cli`, the operator CLI (binary alias `ratel`).

Future integrations live as siblings: `integrations/langchain/`, `integrations/openai-agents/`, `integrations/vercel-ai-sdk/`, etc.

## Consequences

- Naming consistency: any wrapper that *integrates Ratel core into something external* lives under `integrations/`.
- `core/` stays reserved for the primary product surface (lib + server).
- `sdks/` stays reserved for language bindings (TS, Python).
- The Cargo workspace lists `../integrations/*` (relative to the workspace root at `src/core/Cargo.toml`) as members alongside `lib` and `server`, with `package.workspace = "../../core"` in each integration crate to point Cargo at the workspace root.
