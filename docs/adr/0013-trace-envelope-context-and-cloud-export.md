# 13. Trace envelope context, per-session seq, search attribution, and Cloud export

Date: 2026-07-01

## Status

Accepted

Extends [ADR-0009](0009-trace-events-core-owned-schema.md) (which stays Accepted; this ADR exercises the
additive evolution it planned for and discharges its deferred "ring buffer + periodic flush" note).

## Context

Ratel Cloud now ingests the SDK's trace stream (`POST /api/v1/trace-events`): per-item validation,
batches ≤ 1000, idempotency via an optional `client_event_id`, and pre-provisioned optional envelope
columns (`search_id`, `catalog_version`, `harness`, `environment`, token/cost fields). The stream the SDK
emits today cannot answer the questions Cloud's self-improvement engine asks:

- **No search→invoke correlation.** `session_id` is the only key; a `gateway_invoke` cannot be joined to
  the search that surfaced the tool, so the offered→picked funnel is invisible.
- **No catalog attribution.** Nothing scopes a metric to "catalog version N", so a description edit can't
  be proven to have improved retrieval.
- **No ordering/idempotency identity.** Two identical events in one flush collapse under a content hash;
  dropped flushes are undetectable.
- **Free-form errors only.** `error` is a raw string; transient vs. permanent is unrecoverable downstream.
- **`gateway_search` hits is a bare count**, the one search event that cannot feed per-hit analysis.
- **No exporter.** The only sinks are noop/memory/jsonl; nothing ships events to Cloud, and each catalog
  builds its own sink, so two sinks sharing a `session_id` would double-count any per-session counter.

Two hard constraints: ADR-0009 makes schema evolution additive-only (Cloud rejects a *known* event type
that fails its published schema, so changing `hits`' type is out), and the core is sans-IO (HTTP cannot
live in `ratel-ai-core`).

## Decision

### Envelope: context + seq, stamped by core

`TraceEnvelope` gains optional fields, serialized only when present (`v` stays 1; old streams parse
unchanged): `seq` (per-session monotonic, stamped by core), `harness`, `environment`, `sdk_version`
(static context set at construction), and `catalog_version` (re-settable mid-session by the sync layer).
`client_event_id` and `occurred_at` are *export* concerns: the exporter derives them at flush time
(`client_event_id = "<session_id>:<seq>"`), keeping Cloud semantics out of core and local JSONL unchanged.

A core `EnvelopeStamper` owns `session_id`, the context fields, the mutable `catalog_version`, and an
atomic `seq` counter. Sinks stamp through it. A `TraceSession` (exposed over FFI) wraps one **bounded**
`MemorySink` (drop-oldest, `dropped_count`) around a single stamper and attaches to both `ToolRegistry`
and `SkillRegistry`: one seq counter, one drain point. The legacy per-registry `set_trace_sink` path
stays; `(session_id, seq)` uniqueness is guaranteed only through a shared `TraceSession`.

### Events: additive fields

- `search_id` on `search` / `skill_search` / `gateway_search` (identity) and on `invoke_start/end/error`,
  `gateway_invoke`, `skill_invoke` (attribution). Core generates it (UUID v4 — first randomness dependency
  in core; a future wasm target needs the `js` feature) inside registry search via a new `search_traced`
  method returning the id with the hits; plain `search` delegates and still emits an id-stamped event.
- `gateway_search` gains `tool_hits` / `skill_hits` arrays (`{id, score, rank}`, rank explicit) **alongside
  the untouched `hits` count** — Cloud's schema pins `hits` as an int, and additive-only forbids the type
  change. The arrays ride Cloud's payload JSONB until promoted. On `search`/`skill_search`, array order
  *is* rank (documented; no rank field added there).
- `invoke_end` gains `result_size_bytes` (mirror of `args_size_bytes`).
- The three error events gain `error_code` (machine string; existing sentinels `unknown_tool_id`,
  `needs_auth` are *duplicated* into it, `error` stays untouched) and `error_kind` (`transient` |
  `permanent`).

### Attribution: SDK-side last-writer map

The catalog keeps a `tool_id → most recent search_id that surfaced it` map, read by the invoke paths.
Rejected: threading ids through the agent loop (the model controls the loop and won't echo ids) and
Cloud-side time-window joins (brittle; pushes producer knowledge into the consumer). Known ambiguity —
a tool surfaced by two searches attributes its invoke to the latest — is acceptable under ADR-0009's
lossy query-log semantics. No TTL in v1.

### Export: drain-timer in TypeScript, not a core batching sink

The Cloud exporter lives in `@ratel-ai/cloud` (see [ADR-0014](0014-cloud-catalog-sync-and-suggestions.md))
and polls `TraceSession.drain()` on a timer: batches ≤ 1000, capped exponential backoff on network/5xx/429
(idempotent retries via `client_event_id`), 202-rejected items logged and never retried, 401/403 stops the
timer, best-effort flush on `beforeExit`. Rejected: a core batching sink with an FFI flush callback —
ThreadsafeFunction/GIL machinery in both bindings for no reliability gain the query-log contract cares
about, and core stays sans-IO. The bounded `MemorySink` is the ring buffer ADR-0009 deferred.

## Consequences

- Cloud can compute the search→invoke funnel, catalog-version A/Bs, gap detection (seq), and
  transient-vs-permanent error splits from the same single stream; no parallel schema.
- A session should have exactly one drainer: a host manually draining while an exporter runs steals
  events. Documented in the exporter README.
- Hosts on the legacy two-sink path get per-sink seq counters; the exporter therefore only accepts a
  `TraceSession`.
- Hard kills lose the in-memory buffer — acceptable, and stated, per query-log semantics.
- Cloud-side promotion of `tool_hits`/`skill_hits`/`search_id` to typed columns is a later, non-blocking
  change; one staging check that extra keys on `gateway_search` are preserved gates the exporter release.
