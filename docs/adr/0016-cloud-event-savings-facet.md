# 16. Cloud Event: optional Ratel-savings facet

Date: 2026-07-03

## Status

Proposed

## Context

[ADR-0013](0013-cloud-telemetry-unified-schema.md) defined the cloud telemetry **Event** — the
request/response of a single LLM call (provider, model, messages, tools, usage, finish reason) — as
the one shape `POST /api/v1/events` accepts, shipped by the pure-language `@ratel-ai/cloud` /
`ratel-ai-cloud` clients. It is deliberately *provider-shaped*: it describes what a developer already
assembles for a provider SDK, and it has no notion of Ratel's own context engineering.

[ADR-0015](0015-usage-estimation-in-core.md) kept the token/cost/savings **maths** in the core+SDKs
(`estimate_tokens`, `catalog_tokens`/`tokens_for`, `ToolCatalog(observe) → lastSavings`) but withdrew
the standalone rollup wire format, noting: *"if a dashboard needs the per-source breakdown on the wire
later, that is an additive extension to the Event (or a new ADR), decided when there is a consumer for
it."*

There is now a consumer. We want **users of Ratel** — developers running the context-engineering SDK
— to send their savings (what selection kept out of the prompt, per source) to Ratel Cloud, and it must
travel in the shape the endpoint already accepts (the Event), not a second stream. That is the
additive extension ADR-0015 anticipated.

## Decision

Add an **optional `savings` facet** to the Event. It is additive and backward-compatible — the schema
already ignores unknown fields on read and omits absent optionals on write, so existing producers and
the shipped clients are unaffected.

```jsonc
"savings": {
  "tokens_by_category":   { "skills": 0, "tools": 0, "history": 0, "memory": 0, "user_input": 0 },
  "saved_by_category":    { /* SourceTokens, optional — realized savings */ },
  "saveable_by_category": { /* SourceTokens, optional — potential (observe-only) savings */ }
}
```

- **`SourceTokens`** carries the five context sources Ratel breaks spend/savings down by
  (`skills`, `tools`, `history`, `memory`, `user_input`), each a non-negative `int4` count defaulting
  to `0`. Ratel's SDK computes `tools` / `skills` from its own registries; the host supplies
  `history` / `memory` / `user_input`.
- **`tokens_by_category`** is the spend actually sent; **`saved_by_category`** is realized savings;
  **`saveable_by_category`** is potential savings in observe-only mode.
- It lands in the canonical Rust crate `ratel-ai-cloud` (source of truth), the TS and Python mirrors,
  the shared conformance fixtures, and `validate` (per-source `int4` bound; the mirrors also re-check
  non-negativity/integrality that Rust's `u64` gives for free).

Wiring: usage/cost still ride the Event's existing `usage`; `savings` is Ratel-specific and optional.
Non-Ratel producers simply omit it. It does **not** duplicate `model` / `latency_ms` / `usage` — those
stay on the Event proper.

## Consequences

- One wire contract and one endpoint remain (ADR-0013); this is a strictly additive field, so the
  shipped `@ratel-ai/cloud` / `ratel-ai-cloud` clients keep working unchanged.
- A Ratel SDK user can populate `savings` (from `ToolCatalog.lastSavings` + their own per-source
  counts) and send it via `sendEvent`. A convenience helper that reads `lastSavings` automatically is
  a follow-up, gated on the usage-estimation SDK work (ADR-0015 / PRs #80, #81) landing.
- The **ingest side** (ratel-websites: Zod schema, DB storage, dashboard rendering) is a separate,
  follow-up change; until it lands, a sent `savings` field is accepted-and-ignored by the endpoint,
  not stored or rendered. This ADR covers only the client-side schema in this repo.
- Extends ADR-0013 (does not supersede it — the Event core is unchanged) and realizes the extension
  ADR-0015 deferred.
