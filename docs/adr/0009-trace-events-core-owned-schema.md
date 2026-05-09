# 9. Trace events — core-owned schema, single stream, query-log semantics

Date: 2026-05-08

## Status

Accepted

## Context

v0.1.5 puts telemetry on the critical path: traces of tool usage end-to-end through `ratel-ai-core` → `@ratel-ai/sdk` → `@ratel-ai/mcp-server`, plus a UI inspector over the resulting stream. The same stream is the substrate for what comes next — XGBoost / LLM re-ranking (v0.1.14–15), LLM-driven catalog suggestions (v0.1.9), multi-agent decomposition hints (v0.1.10), and the optional self-hosted trace consolidation server (v0.1.x tail).

Two questions stack:

1. **Where does the trace data model live?** `ratel-ai-core` is intentionally tiny today — `Tool`, `ToolRegistry::register`, `ToolRegistry::search`, `SearchHit`, the schema-aware indexing walk. Everything else — execution dispatch (`ToolCatalog.invoke`), the `search_tools` / `invoke_tool` gateway tools, MCP ingest via `registerMcpServer`, OAuth / `needs_auth` semantics — lives in TypeScript. A reflexive "telemetry goes in the core" answer would only cover ranking events; the most interesting events (what the agent actually invoked, with which args, with what outcome) never cross into Rust.

2. **Are internal-feedback traces and external observability the same stream or two?** A natural framing splits them: an "oplog" that feeds rerankers and the suggestion analyzer (consumed *inside* the system) versus "telemetry" that drives the inspector (consumed *outside*). They overlap heavily — a search event with query, hits, scores, latency feeds both — so it's worth pinning whether they are one stream with multiple consumers or two parallel emission paths.

The mental model that drove this ADR: think of `ratel-ai-core` as a database, the trace stream as `pg_stat_statements` (not the WAL — see below), and downstream rerankers / suggestion analyzers as planner-like consumers of usage data. Inspector and external trace consolidation are additional consumers of the same data.

## Decision

### Schema and sink ownership

The **trace event data model and the sink trait live in `ratel-ai-core`**. Every host language (TS today, Python in v0.5.x) emits into the same shape; every consumer (reranker training, LLM-suggestion analyzer, inspector, future trace-consolidation server) reads the same shape. The schema is the cross-language contract; placing it anywhere else forces re-definition per host language and blocks training a single reranker on cross-host data.

Concrete events the schema covers from day one: search, invocation (start / end / error), gateway-tool calls (`search_tools`, `invoke_tool`), upstream-MCP ingest, auth / `needs_auth`. The set is open-ended; new event types are additions, not breaking changes.

### Single stream, multiple consumers

**One tagged event stream. Filtering happens at the consumer**, not at the producer. Reranker training subscribes to a cut (search ↔ invoke pairs with outcome); the inspector subscribes to everything; the suggestion analyzer subscribes to a different cut. This avoids double instrumentation and the drift between two pipes the "internal vs external" framing would have created.

### Query-log semantics, not oplog semantics

Tool invocations and search calls are **observations of usage**, not state mutations of the catalog. The closest database analogue is `pg_stat_statements` or a slow-query log, not the WAL. This pins the reliability profile:

- **Best-effort, sampleable, lossy on backpressure.** Losing a trace event is acceptable; corrupting the catalog is not.
- **Loose / causal ordering**, not strict serialization. Per-event timestamps are enough; total order is not required.
- **No synchronous durability on the hot path.** In-memory ring buffer in core, periodic flush. Sampling rate is a knob.

This is a deliberate departure from the oplog framing: oplog-grade reliability would over-engineer durability and ordering guarantees that aren't load-bearing for any consumer we have planned, and would pay that cost on every search and invoke.

### SDK → core communication: synchronous NAPI call per event

Because execution lives in the SDK, the SDK records invocation, gateway, and MCP-ingest events into the core sink via NAPI. **Synchronous call per event** for v0.1.5 — one NAPI hop is negligible against the LLM call that brackets each invocation, and keeping persistence / sampling / retention in one place (Rust) keeps the data-integrity story trivial. Async / batched emission is a future optimization, not a v0.1.5 concern.

`@ratel-ai/mcp-server` emits the auth-shaped events (refresh attempts, 401-driven `needs_auth`, OAuth flow start/finish) into the same sink via the same path.

### On-disk layout: per-project buckets

The CLI's default JSONL sink writes each session under `~/.ratel/telemetry/<project-slug>/<session-id>.jsonl`. The slug is `process.cwd()` at serve time with every `/` and `.` replaced by `-`, **mirroring Claude Code's `~/.claude/projects/<slug>/` convention bit-for-bit** so the bucket is recognisable to anyone who's seen CC's project directories. `ratel inspect` defaults to the bucket for the current cwd (strict — refuses to surface another project's telemetry), with `--all` to scan every bucket and `--project <abs-path>` to target one explicitly. The slugging logic lives entirely in the CLI; the core's `JsonlSink` accepts any path. `--telemetry-file` overrides skip slugging and write to the literal path. `RATEL_TELEMETRY_DIR` overrides the root that buckets nest under.

### Producer responsibilities by layer

| Layer | Events it produces |
|---|---|
| `ratel-ai-core` | search (query, hit ids, scores, latency); index churn |
| `@ratel-ai/sdk` | invoke start / end / error (toolId, args-shape, latency, outcome); gateway-tool calls; upstream MCP ingest |
| `@ratel-ai/mcp-server` | OAuth refresh, `needs_auth`, auth-flow start / completion |

The **inspector and the rerankers consume the same stream**, just with different filters. The optional self-hosted trace-consolidation server (v0.1.x tail) also consumes this stream — its existence is the strongest argument for the schema being cross-language and core-owned.

## Consequences

- **Cross-language reuse is built in.** A future Python SDK binds the same Rust trace API and emits the same shapes; a single reranker trains on the union of TS- and Python-emitted events without a schema-translation layer.
- **The data contract for v0.1.9 (suggestions), v0.1.14–15 (rerankers), and the consolidation server is locked at v0.1.5.** Adding events later is non-breaking; renaming or removing them is. Treat the schema with the same care as `Tool` and the `searchable_text` projection (per ADR-0004).
- **The inspector is a downstream concern, not a separate pipeline.** It consumes the same events the rerankers do, with a different cut. Build the producer once.
- **Sampling and retention are core-owned knobs.** Every host language inherits them; per-language overrides aren't planned.
- **Future move of execution into Rust pays off automatically.** If local executables / WASM tools ever run inside the core, they record into the same log with no second pipeline.
- **The "internal vs external" mental split survives as a consumer concern.** It's still useful for reasoning about which events feed the learning loop vs. the human surface, but it does not show up in the producer architecture.

## Rejected

- **Pure Rust-side telemetry.** Misses invoke, gateway, and auth events — the most interesting half of the surface — because execution and OAuth live in TS today. A telemetry milestone that omits invocation outcomes can't feed reranker training or the suggestion analyzer.
- **Pure SDK-side telemetry.** Duplicates the schema for the future Python SDK and for the trace-consolidation server, and forces every cross-language consumer to learn N event shapes. Also strands the search events (the only events Rust can natively observe) outside the trace pipeline.
- **Two parallel streams ("oplog" for internal, "telemetry" for external).** The producer-level event set overlaps heavily; the split is real at the *consumer* boundary, not the producer one. Two pipes means double instrumentation, two chances to forget, and two places for the schemas to drift.
- **Oplog-grade reliability for trace events.** Tool invocations don't mutate registry state — they're query-log shaped. Synchronous fsync per event, strict ordering, and no-loss durability would impose hot-path cost on every search and invoke for guarantees no consumer needs.
- **Async / batched NAPI emission for v0.1.5.** The hop cost is negligible against the LLM call bracketing each invocation, and JS-side buffering would split persistence ownership across the NAPI boundary. Revisit only if profiling surfaces real overhead.
