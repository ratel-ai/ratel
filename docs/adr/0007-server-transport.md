# 7. Server transport

Date: 2026-04-29

## Status

Accepted

## Context

`ratel-server` is the optional server tier that unlocks fleet/cross-session features (per `docs/RATEL_V1_PLAN.md` §3, §4.2). It exposes two distinct surfaces:

1. **An MCP-facing surface** for `ratel-mcp-server` and any future MCP integration to talk to upstream agents — the gateway's downstream-facing protocol must speak MCP.
2. **A control-plane surface** for catalog management, token CRUD, telemetry ingestion, and ops admin — used by the lib's `RemoteBackend`, the `ratel-cli`, and (eventually) ops tooling.

The MCP specification (verified during Phase 0 research, sources current as of April 2026) defines two standard transports: **stdio** and **Streamable HTTP** (the latter introduced in spec version 2025-03-26, replacing the deprecated HTTP+SSE transport). Stdio dominates local/desktop deployments; Streamable HTTP is the remote-capable transport. Existing MCP gateways (MetaMCP, MCP Router, Enkrypt Secure MCP Gateway, IBM ContextForge MCP Gateway) expose Streamable HTTP upstream.

There is **no emerging standard** for the control-plane API across MCP gateway projects — each rolls its own.

## Decision

**Two protocols, two surfaces, no overlap:**

- **MCP-facing surface: Streamable HTTP** (per the current MCP spec). The `ratel-mcp-server` integration speaks Streamable HTTP upstream to agents. Wraps downstream MCP servers regardless of their individual transports (stdio for local-launched downstreams, Streamable HTTP for remote ones).
- **Control plane: REST + JSON.** Catalog upsert, token CRUD, telemetry ingestion, and admin endpoints. Versioned at `/api/v1/...`. Deliberately *not* MCP-on-the-wire because (a) those endpoints aren't tool calls, (b) MCP doesn't standardize control-plane operations anyway, (c) REST is what the CLI, the lib's `RemoteBackend`, and any future ops UI will all speak.

The two surfaces share authentication (bearer token in v1 per `docs/RATEL_V1_PLAN.md`, full OAuth on the server's own surface in v2) and may share an HTTP listener for operational simplicity, but route ownership is split.

## Consequences

- `ratel-server` ships as a Rust HTTP server (axum or similar — implementation choice deferred to Phase 3) that mounts both surfaces. No protocol bridging needed at the framework level since both are HTTP; the MCP-protocol semantics live in the handler layer.
- The lib's `RemoteBackend` (ADR 0004) talks to the REST control plane. Telemetry forwarding uses the same control-plane REST endpoint (batched POSTs).
- `ratel-mcp-server` does not invoke control-plane endpoints during request hot-path — it reads its catalog from the lib's local cache and only calls control-plane on startup (catalog reflection per ADR 0006) and on background reconciliation.
- Adding alternative MCP transports (e.g., a future MCP-over-WebSocket if the spec adds one) is additive — a new handler on the same listener, no architectural break.
- Ops tooling (CLI, future admin UI) only needs to learn one surface (REST). No clients are forced to speak MCP outside the agent path.
- We are explicitly *not* trying to standardize the control-plane API across MCP gateways. If a standard emerges, this ADR is supersedable.
