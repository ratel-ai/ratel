# 2. V1 scope and trajectory

Date: 2026-04-29

## Status

Accepted

## Context

Codifies the v1 scope decisions reached in `docs/RATEL_V1_PLAN.md` §1 and §4.1. Phase 0's job is to lock the perimeter so Phase 1+ doesn't drift into adjacent ambitions (chat/memory management, ML-trained ranking, federated tool catalogs, etc.).

## Decision

**v1 ships the Context Engineering wedge, narrowly:**

- **Smart tool selection** — two-stage retrieve→rerank pipeline with a telemetry-weighting layer. Local lib does the basic version; the server unlocks cross-session learning across fleets.
- **Auth lifecycle** — token cache, proactive refresh with jitter, refresh-on-401, vault adapter, OAuth 2.1 + PATs.
- **Telemetry emission** — sink-agnostic event emission feeding the data flywheel.
- **One concrete integration** (`ratel-mcp-server`) and one alternate operator UX (`ratel-cli`).
- **Two SDKs:** TS first, Python second.
- **Library *and* server**, with the lib as the primary product surface and the server justified by deployment shapes the lib can't serve (serverless, multi-instance, fleet learning).

**Explicit non-goals for v1** (deferred to v1.1+):

- Chat/conversation/memory management — compaction, message persistence, navigation across pruned messages. The architecture leaves room via a reserved `context/` module slot in the SDK and the backwards-compatible `Backend` interface (ADR 0004), so the v1.1 add is additive, not a rewrite.
- ML-trained ranking, RL on outcome signals, custom reranker fine-tuning. v1 commits to the *data flywheel* and a simple weighted-boost ranker; algorithm exploration follows the accumulated telemetry.
- Multi-tenant policy enforcement, RFC 8693 token exchange, fleet observability dashboards (see ADR 0012 for the RFC 8693 punt rationale), Postgres backend.
- LangChain / OpenAI Agents / Vercel AI SDK integrations beyond the core MCP integration.

## Consequences

- A bug fix or feature request that falls outside the wedge is a "v1.1 conversation," not a "let me just add this real quick" decision. Phase reviews check against this perimeter.
- The `context/` SDK module slot (RATEL_V1_PLAN.md §3) is intentionally empty in v1. Phase 0 work and Phase 1 modules must not pre-fill it.
- Operator-facing value (token vault, catalog management, audit log) sells separately from the builder-facing wedge — different demos, different audiences. The Phase 7 launch plan reflects this split.
