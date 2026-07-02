# 15. Cloud-derived analytics from raw agent events

Date: 2026-07-02

## Status

Accepted

Supersedes the SDK→cloud **contract** and the **derivation-location** decision of
[ADR-0013](0013-observability-and-analytics.md) (Decisions 1 and 2). Everything else in
ADR-0013 — the PII-free principle, the single `POST /api/v1/events` endpoint, the
best-effort batched shipper — still holds. Aligned with the privacy posture of
[ADR-0014](0014-chat-ingestion-contract-and-privacy.md).

## Context

ADR-0013 shipped a **pre-computed rollup**: the SDK sent `tokens_by_category` /
`saved_by_category` etc., derived in `ratel-ai-core`, and the cloud stored them as-is
("renders SDK data with zero translation"). Two problems surfaced as the dashboard grew:

- **The split is a moving target.** How input tokens divide across skills / tools /
  history / memory / user-input — and the used-vs-unused-tools and cached-vs-uncached-history
  breakdowns the dashboard is now built around — are heuristics that we want to tune
  frequently and **restate over history**. Baking them into every SDK release (and every
  language binding) makes iteration slow and leaves old data frozen at the version that
  produced it.
- **The rollup can't answer new questions.** "Which tools were actually called," cache
  attribution, per-tool footprints — none of it is recoverable from a rollup after the
  fact, because the raw signal was thrown away at the edge.

We considered keeping derivation in the core and expanding the rollup, but that couples
dashboard product decisions to the core's release cadence and still can't restate history.

## Decision

**1 — The SDK ships the raw agent event; the cloud derives the analytics.** The
`POST /api/v1/events` body becomes one LLM call: `{ provider, model, ts, system?,
messages, tools?, usage?, params?, … }` (a single object or an array). The cloud stores it
verbatim in `events.payload` and derives the dashboard categories with a **versioned
categorizer** (`CATEGORIZER_VERSION`) into `event_metrics`. Metrics are **re-derivable**:
bump the version and run the backfill to restate history.

**2 — Derivation logic is cloud-owned, not core-owned.** The token *estimation primitives*
may still live in `ratel-ai-core`, but the *attribution/categorization* (the volatile,
product-facing heuristics) lives in the cloud (`lib/categorize.ts`). This reverses
ADR-0013 Decision 1 for the split logic only; parity across languages is preserved because
there is now exactly **one** derivation, cloud-side, that every SDK feeds.

**3 — Privacy: the SDK redacts before sending; the cloud stores redacted-only.** The raw
event carries prompt/tool text, so — exactly as [ADR-0014](0014-chat-ingestion-contract-and-privacy.md)
requires for chats — **the SDK MUST redact message / system / tool content at the sending
level** (the same best-effort secret-scrubber), so raw text never leaves the customer's
machine and the cloud only ever holds redacted text. Redaction preserves the structure the
categorizer needs (message roles, `tool_call` blocks and names, skill/memory markers, and
approximate sizes), so cloud-side derivation still works on redacted input. Event capture
is **opt-in / configurable**, consistent with ADR-0014. The Rust core stays off the text
road (ADR-0009 / ADR-0013): it never handles the raw event.

**4 — Ingest is bounded and idempotent.** The endpoint validates against the schema
(`cloud-schema.ts`) with explicit size/token caps (rejecting abuse with a 400, never an
overflow-as-500), dedupes on `sha256(provider, model, ts, system, tools, messages)` via a
unique `(project_id, dedupe_hash)` index, and derives cost from a cloud-side price table
(the event no longer carries `cost_usd`).

## Consequences

- **Fast, restate-able analytics.** Tuning the split is a cloud deploy + backfill, not an
  SDK release; history is restated to the new categorizer version.
- **New breakdowns are possible** (used/unused tools, cached/uncached history, per-tool
  footprints) because the raw signal is retained.
- **A larger, more sensitive payload.** `events.payload` holds the (redacted) raw call, not
  a handful of counts — bounded at ingest, and gated on the SDK-side redaction in Decision 3.
- **Gating follow-up (SDK):** the redaction in Decision 3 is an SDK change and is **not yet
  shipped**. Until it is, event capture must be treated as potentially storing sensitive
  text and kept off / restricted to trusted/opt-in projects. The cloud + derivation side
  (this contract) lands first; the SDK redaction ships in lockstep before capture is enabled
  broadly.
- **Pre-ADR-0013 rows are inert.** Existing rollup rows have no raw payload, so they can't be
  re-derived; they remain as history and simply don't appear in the raw-derived views. No
  data is deleted in the migration.
- **ADR-0013's rollup contract is retired.** SDKs and docs stop sending `tokens_by_category`
  / `saved_by_category`; the "savings" (saved/saveable) story is dropped from the dashboard.
