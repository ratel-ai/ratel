# 16. Lean usage rollups — Rust-core analytics, one cloud endpoint

Date: 2026-06-25

## Status

Accepted

Supersedes [ADR-0013](0013-python-observability-layer.md) and
[ADR-0014](0014-cloud-ingestion-contract.md). Extends
[ADR-0009](0009-trace-events-core-owned-schema.md).

## Context

ADR-0013/0014 added a Langfuse-style observability layer to the **Python** SDK: a rich
trace/observation/generation tree, OpenAI/Anthropic drop-in wrappers (ADR-0015), and a background
exporter shipping a Langfuse-shaped batch to a bespoke `POST /v1/ingest`. The analytics *logic*
(token estimation, savings, payload assembly) lived in Python.

Three problems surfaced in review:

1. **Wrong layer.** The core value — token accounting, full-catalog-vs-selected savings, cost — was
   computed in Python. Ratel is a Rust-core library bound into TS and Python; that logic should live
   in the core and be shared, not re-derived per language. The build was also Python-only.
2. **Two contracts.** The cloud dashboard (separate repo) already ingests a lean *per-interaction
   rollup* at `POST /api/v1/events` — token spend broken down by context source, plus realized and
   potential savings — and renders it directly. The SDK's Langfuse `/v1/ingest` payload spoke a
   different language the cloud never implemented, so the SDK couldn't actually light up the dashboard.
3. **Premature surface.** Monkey-patching provider clients (OpenAI/Anthropic) is a large surface to
   own before the event pipeline is proven. Manual, explicit integration is leaner and good enough to
   start; a Claude Code skill can drive it.

## Decision

**1 — The analytics logic moves into `ratel-ai-core` (`usage` module), pure and network-free.**
`estimate_tokens`, `tool_footprint`/`skill_footprint`, `ToolRegistry`/`SkillRegistry::catalog_tokens`
and `tokens_for`, `tokens_saved`, `estimate_cost_usd`, and the `SourceTokens` / `Rollup` types. It
carries only counts and identity — never prompt/output text — so the core and its on-disk JSONL stay
PII-free (ADR-0009/0013 invariant preserved). It is bound identically into Python (PyO3) and TS
(napi); the SDKs are thin orchestration over one implementation.

**2 — One SDK→cloud contract: `POST {host}/api/v1/events`.** `Authorization: Bearer <key>`; the body
is a single rollup object or a JSON array of them. A rollup is one agent interaction:

```jsonc
{
  "tokens_by_category": { "skills": 120, "tools": 2000, "history": 3400, "memory": 260, "user_input": 340 },
  "saved_by_category":  { "tools": 7200, "skills": 520 },   // kept OUT of the prompt this run (optional)
  "saveable_by_category": { "tools": 7000 },                // could save in observe-only mode (optional)
  "input_tokens": 6120, "output_tokens": 180,
  "model": "claude-sonnet-4-6", "latency_ms": 420,
  "cost_usd": 0.0231,                                       // optional; estimated in-core from model+tokens if absent
  "occurred_at": "2026-06-25T09:12:00Z"                     // optional; server uses receipt time otherwise
}
```

The context sources are exactly `skills, tools, history, memory, user_input`.

**3 — The host SDK is a lean, best-effort shipper.** A bounded-queue background thread batches by
size/interval and POSTs the array; retries 5xx, drops 4xx, never blocks or raises into customer code;
absent an API key it is a no-op. The public surface is `RatelClient.track(...)` (assemble + enqueue a
rollup) plus `flush()`. `ToolCatalog(observe=True)` records savings from the native registry onto the
local trace stream and `last_savings`, ready to fold into a `track()` call.

**4 — Retire the Langfuse path and the provider wrappers.** The `/v1/ingest` batch, the rich
observation tree, the OpenAI/Anthropic wrappers, and ADR-0015's transparent in-call selection are
removed from this line. Manual integration is documented and driven by a Claude Code skill. The full
prior implementation is preserved on branch `feat/python-observability` for reference.

## Consequences

- **The cloud renders SDK data with zero translation** — the SDK emits exactly the shape the dashboard
  already reads, so observability is real end-to-end (verified: the SDK seeds the dashboard's adoption
  story directly).
- **Parity by construction** — Python and TS get the same numbers from one Rust implementation; a new
  language inherits the contract.
- **Smaller, safer surface** — no provider-SDK dependencies or monkey-patching; the existing
  tool-catalog behavior is unchanged when `observe` is unset.
- **Lost (for now):** the Langfuse-isomorphic per-call observation tree and automatic LLM-call
  capture. These were the wrappers' main draw; they can return later as an *additive* layer that emits
  alongside rollups, without changing this contract. Cloud-side Langfuse forwarding, if wanted, maps
  from rollups instead of from `/v1/ingest`.
- The in-core cost table is coarse and demo-grade; callers with real pricing pass `cost_usd` explicitly.
