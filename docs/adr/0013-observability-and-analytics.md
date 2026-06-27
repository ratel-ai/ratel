# 13. Observability and usage-analytics layer

Date: 2026-06-25

## Status

Accepted

Extends [ADR-0009](0009-trace-events-core-owned-schema.md).

## Context

Ratel is a context-engineering library. To show customers the value it delivers, and to power a cloud
dashboard, the SDK needs to report, per agent interaction, how many tokens went into the prompt
(broken down by context source), how many Ratel's selection kept out, and the model / latency / cost.
This must work in both SDKs (Python and TS), must never slow down or break the host app, and must keep
prompt/output text out of the core (no PII on the core's on-disk JSONL, per ADR-0009).

The branch first prototyped a heavier, Langfuse-shaped design: a rich trace/observation/generation
tree shipped to a bespoke `POST /v1/ingest`, plus drop-in OpenAI/Anthropic wrappers, with the
token/savings/cost logic living in Python. That was discarded before merge for three reasons: the
analytics logic belongs in the shared Rust core (not duplicated per language, and not Python-only);
the cloud dashboard already ingests a leaner per-interaction *rollup* at `POST /api/v1/events` that the
prototype never spoke; and monkey-patching provider clients is a large surface to own before the
pipeline is proven. This ADR records the design we kept.

## Decision

**1 — The analytics logic lives in `ratel-ai-core` (`usage` module), pure and network-free.**
`estimate_tokens`, tool/skill footprints, `ToolRegistry`/`SkillRegistry::catalog_tokens` and
`tokens_for`, `tokens_saved`, `estimate_cost_usd`, and the `SourceTokens` / `Rollup` types. It carries
only counts and identity, never prompt/output text, so the core and its on-disk JSONL stay PII-free. It
binds identically into Python (PyO3) and TS (napi); the SDKs are thin orchestration over one
implementation.

The core trace schema (ADR-0009) also carries additive, PII-free identity/usage variants (`TraceRoot`,
`ObservationStart`, `ObservationEnd`, `Generation`, `TokensSaved`) so trace consumers can correlate
interactions; `ToolCatalog(observe=True)` emits `TokensSaved` on each search.

**2 — One SDK→cloud contract: `POST {host}/api/v1/events`.** `Authorization: Bearer <key>`; the body is
a single rollup object or a JSON array of them. A rollup is one agent interaction:

```jsonc
{
  "tokens_by_category": { "skills": 120, "tools": 2000, "history": 3400, "memory": 260, "user_input": 340 },
  "saved_by_category":  { "tools": 7200 },        // kept OUT of the prompt this run (optional)
  "saveable_by_category": { "tools": 7000 },      // could save in observe-only mode (optional)
  "input_tokens": 6120, "output_tokens": 180,
  "model": "claude-sonnet-4-6", "latency_ms": 420,
  "cost_usd": 0.0231,                             // optional; estimated in-core from model + tokens if absent
  "occurred_at": "2026-06-25T09:12:00Z"           // optional; server uses receipt time otherwise
}
```

The context sources are exactly `skills, tools, history, memory, user_input`.

**3 — The host SDK is a lean, best-effort shipper.** A background, batched client (`RatelClient.track(...)`
plus `flush()`) ships the array; it retries 5xx, drops 4xx, samples by `sample_rate`, never blocks or
raises into customer code, and absent an API key is a no-op. `ToolCatalog(observe=True)` records savings
from the native registry onto the local trace stream and `last_savings`, ready to fold into a `track()`
call.

**4 — No provider wrappers.** Integration is manual and documented, driven by a Claude Code skill
(`/ratel-observability`), rather than monkey-patching provider clients.

## Consequences

- **The cloud renders SDK data with zero translation** — the SDK emits exactly the shape the dashboard
  reads, so observability is real end-to-end (the SDK seeds the dashboard's adoption story directly).
- **Parity by construction** — Python and TS get the same numbers from one Rust implementation; a new
  language inherits the contract.
- **Smaller, safer surface** — no provider-SDK dependencies or monkey-patching; the existing
  tool-catalog behavior is unchanged when `observe` is unset.
- **Lost (for now):** a Langfuse-isomorphic per-call observation tree and automatic LLM-call capture.
  These can return later as an *additive* layer that emits alongside rollups, without changing this
  contract. Cloud-side Langfuse forwarding, if wanted, maps from rollups.
- The in-core cost table is coarse and demo-grade; callers with real pricing pass `cost_usd` explicitly.
