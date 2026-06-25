# 13. Python observability layer — hybrid core/Python schema, background exporter

Date: 2026-06-24

## Status

Superseded by [ADR-0016](0016-lean-usage-rollups-rust-core.md)

## Context

ADR-0009 locked a core-owned trace stream: `ratel-ai-core` defines `TraceEvent` and the `TraceSink`
trait, every host language emits the same shapes, every consumer reads them, and the reliability
profile is query-log (best-effort, lossy on backpressure, no synchronous durability on the hot path).
Today the stream covers retrieval, invocation, gateway, upstream-MCP, and auth events, and it lands in
local JSONL via the CLI's `JsonlSink`.

That covers *Ratel's own* tool-selection surface. It does not cover the thing a customer running an
agentic system in Python actually spends tokens on: their **LLM calls**. We want Ratel to be the layer
a customer routes their whole stack through — comparable to how a team adopts Langfuse — but feeding
**Ratel's cloud** (built in a separate repo; out of scope here). Concretely the Python SDK must:

1. Capture LLM generations (model, prompt, output, token usage) with near-zero friction — drop-in
   provider wrappers, an `@observe` decorator that forms a nested trace tree, and manual
   span/generation context managers — including for customers who never touch Ratel's tool catalog.
2. Ship those observations to Ratel's cloud, authenticated with a dashboard-issued API key,
   without ever blocking or breaking the customer's app.
3. Stay one unified stream with the existing ADR-0009 events, and rich/structured enough that the
   cloud can forward to Langfuse (customer pastes their Langfuse keys into Ratel's dashboard).

Two design questions stack, mirroring ADR-0009's framing:

- **Where does the LLM/observation data model live?** Pushing full LLM semantics — prompt strings,
  model params, free-form metadata — into a tool-retrieval core bloats the enum with concerns the
  core never reads, and risks PII flowing through the 0600 on-disk JSONL that ADR-0009 designed for
  `pg_stat_statements`-shaped data. Keeping it purely in Python re-creates the "N event shapes per
  host language" problem ADR-0009 rejected, and strands trace-tree identity outside the cross-language
  contract.
- **Where does the network egress live?** `ratel-ai-core` is deliberately dependency-light
  (`bm25`, `serde`, `serde_json`) and in-process by design (ADR-0011, roadmap "out of scope: hosted
  runtime"). Adding an HTTP client to it would betray that.

## Decision

### Hybrid schema — identity/usage in core, rich payload in Python

The trace **identity and coarse usage facts** are added **additively to `ratel-ai-core`'s
`TraceEvent`** (extending ADR-0009, which already declares new variants non-breaking): `TraceRoot`,
`ObservationStart`, `ObservationEnd`, `Generation`, `TokensSaved`. These carry trace-tree linkage
(`trace_id`, `observation_id`, `parent_observation_id`), non-PII trace attributes (`name`, `tags`,
`version`; `session_id` already lives on the envelope), provider/model, and integer token counts.
They carry **no prompt/output text, no free-form metadata, no `user_id`, and add no dependency** — they
stay within the existing `serde`/`serde_json` budget. `user_id` and the rich payload live only in the
Python cloud stream, so the core and its 0600 on-disk JSONL stay PII-free. A future TS SDK and the reranker inherit this contract for
free, and the Python binding's existing `record_event(dict)` accepts them with no binding change.

The **rich observation payload** — prompt/output content, model parameters, metadata dicts, OTel-named
attributes, capture toggles — lives in **Python stdlib dataclass models** (`ratel_ai/observability/
models.py`, each with a `to_wire()` that emits the JSON shape) and is the canonical SDK→cloud wire
model. Dataclasses keep the tracing core dependency-free (no pydantic); the only third-party dependency
the layer pulls is `httpx`, for the exporter's network egress. It is keyed by the same `trace_id`/`observation_id` the
core events carry, so the local query-log stream and the cloud payload are joinable cloud-side without
prompt text ever entering Rust or on-disk JSONL.

### Network egress lives in Python, off the hot path

The cloud exporter is pure Python (`ratel_ai/observability/exporter.py`), using `httpx` behind an
optional `ratel-ai[observability]` extra so the base SDK stays dependency-free (same discipline as the
`mcp` extra — see lessons.md 2026-06-08). `httpx` is lazily imported inside the exporter, so the
tracing core (`@observe`, context managers, client) works on a bare `ratel-ai[observability]` install
even before a single byte is sent. The hot path only enqueues to a bounded in-process queue
(O(1), drops oldest on overflow — query-log semantics per ADR-0009); a daemon thread batches by size
or interval and POSTs. The core never gains a network dependency.

### Wire format — Ratel-native, Langfuse-shaped, OTel-GenAI-named

The cloud envelope is structurally isomorphic to Langfuse's trace/observation/generation model (so
cloud-side Langfuse forwarding is a near-mechanical field map), while LLM attributes are named after
OpenTelemetry GenAI semantic conventions (`gen_ai.system`, `gen_ai.request.model`,
`gen_ai.usage.input_tokens`, …) inside a `gen_ai` sub-object. No `opentelemetry-sdk` dependency in v1;
an optional OTel exporter is a possible v2 addition. The exact batch envelope is ADR-0014.

### Token usage and savings

Generation token counts are read **from the provider response** (`usage.prompt_tokens` /
`completion_tokens` for OpenAI; `usage.input_tokens` / `output_tokens` for Anthropic); the estimator is
a fallback only when the provider reports nothing (e.g. streaming without usage). The Ratel
**savings metric** (`TokensSaved`) is computed at the `ToolCatalog.search` boundary: estimated tokens
of the full registered catalog vs the selected top-K. The estimator is pluggable (`TokenEstimator`
Protocol); the default is a dependency-free `len(text)//4` heuristic (savings is a ratio/delta where
the bias largely cancels), with an optional `tiktoken`-backed estimator behind a separate
`observability-tiktoken` extra (3.9 wheel gaps — keep it isolated). **Cost ($) is computed
cloud-side** from `(model, tokens)`; the SDK never ships a price table (it would ship stale).

### Never break the customer's app

Every public entry point (`@observe`, provider wrappers, context managers, savings) swallows its own
observability errors and lets the wrapped work proceed; the exporter logs at most one structured
`logging` warning per failure class (never `print`) and is fork-safe. Absent an API key and explicit
config, the client runs in no-op mode: captures nothing, raises nothing.

## Consequences

- The unified-stream and cross-language-contract guarantees of ADR-0009 extend to LLM observability
  with no second producer pipeline; a future TS SDK emits the same identity/usage shapes.
- PII never enters `ratel-ai-core` or its on-disk JSONL — prompt/output content stays in the Python
  payload shipped only to the configured cloud endpoint, gated by capture toggles.
- The base `pip install ratel-ai` stays dependency-free; observability is an opt-in extra, preserving
  the abi3-py39 floor.
- The existing `ToolCatalog` / `TraceSinkConfig` / `drain_trace_events` behavior is unchanged when the
  new `observe` opt-in is not used.
- Cloud-side Langfuse forwarding is a field map, not a translation layer, because the wire model is
  Langfuse-shaped by construction.

## Rejected

- **Full LLM semantics in the Rust core.** Bloats a tool-retrieval enum with concerns it never reads
  and risks prompt text in the 0600 JSONL ADR-0009 built for query-log data.
- **Pure-Python schema, core untouched.** Strands trace-tree identity and token usage outside the
  cross-language contract — exactly the "N shapes per host language" outcome ADR-0009 rejected.
- **HTTP egress in `ratel-ai-core`.** Betrays the dependency-light, in-process core (ADR-0011); the
  exporter belongs in the host language where the provider SDKs and the event payloads already live.
- **Client-side cost computation.** Price tables change weekly; a pip-installed table guarantees
  staleness. The SDK ships model + tokens; the cloud resolves cost.
- **OpenTelemetry SDK dependency in v1.** Heavy for the zero-friction goal; OTel-aligned *naming* gets
  the interoperability without the weight, and an optional OTel exporter stays open for v2.
