# 15. Usage-estimation maths in the core; no separate rollup stream

Date: 2026-07-03

## Status

Proposed

## Context

`ratel-ai-core` can cheaply estimate the token footprint of the context it assembles — per-tool
and per-skill definitions, the full registered catalog vs. the selected top-K, and a coarse USD
cost from model + token counts. These are pure, network-free maths, useful to any SDK caller that
wants to show "what did selection save" or "what did this call cost".

An earlier design — the observability / usage-analytics spike (PRs #79–#81) — went further. It
defined a distinct **rollup** wire format: token spend broken down by five context sources
(`skills`/`tools`/`history`/`memory`/`user_input`), realized and potential savings, model, latency,
cost — shipped to `POST /api/v1/events` from a per-SDK background client. It also added a parallel
observability trace-tree to the core (`TraceRoot` / `ObservationStart` / `ObservationEnd` /
`Generation` / `TokensSaved`).

Since then, [ADR-0013](0013-cloud-telemetry-unified-schema.md) landed a **unified cloud-telemetry
Event** — the full request/response of an LLM call (provider, model, messages, tools, usage,
finish_reason) — as the one shape `POST /api/v1/events` accepts, shipped by the pure-language
`@ratel-ai/cloud` client. The rollup format and the Event format are two different schemas
contending for the same endpoint, and the Event has no home for a per-source / savings breakdown.
Carrying both would mean two wire contracts, two clients, and a second trace model in the core with
no consumer.

## Decision

Keep the **maths**; drop the **separate stream**.

- `ratel-ai-core` exposes the estimation primitives — `estimate_tokens`, `tool_footprint` /
  `skill_footprint`, `tool_tokens` / `skill_tokens`, `tokens_saved`, `estimate_cost_usd`, and the
  registry helpers `catalog_tokens()` / `tokens_for()` — bound directly into the TS and Python SDKs.
  `ToolCatalog({ observe })` records the full-catalog-vs-top-K saving in memory (`lastSavings`) as a
  convenience; it emits nothing to the wire and nothing to the trace stream.
- The standalone **rollup** wire format (`Rollup` / `SourceTokens` / `buildRollup` / the `Transport`
  seam) and the per-SDK rollup client are **not adopted**. Usage/cost telemetry rides ADR-0013's
  Event (`usage.{input,output,cached,reasoning}_tokens`) via `@ratel-ai/cloud`.
- The observability **trace-tree** variants proposed for the core (`TraceRoot`, `ObservationStart` /
  `ObservationEnd`, `Generation`, `TokensSaved`) are **not added**; the core trace stream
  ([ADR-0009](0009-trace-events-core-owned-schema.md)) is unchanged.

## Consequences

- One wire contract for cloud telemetry (ADR-0013), one client (`@ratel-ai/cloud`), one endpoint.
- The per-source spend / savings *breakdown* has no wire home today. Callers can still compute
  savings locally (`catalog_tokens` − `tokens_for`) and surface or attach it as they see fit. If a
  dashboard needs the breakdown on the wire later, that is an additive extension to the Event (or a
  new ADR), decided when there is a consumer for it — not carried speculatively.
- Withdraws the never-merged observability/usage-analytics ADR draft. The surviving maths ship as the
  reworked #79 (core) / #80 (`@ratel-ai/sdk`) / #81 (`ratel-ai`) stack.
