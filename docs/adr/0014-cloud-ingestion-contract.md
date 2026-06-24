# 14. Cloud ingestion contract — the SDK→cloud wire interface

Date: 2026-06-24

## Status

Accepted

## Context

ADR-0013 puts the rich observation payload and the cloud exporter in the Python SDK, shipping to
Ratel's cloud. The cloud platform is built in a **separate repository** and is not yet implemented.
For the SDK to be built and tested now, the SDK↔cloud boundary needs a contract that exists
independently of the cloud's implementation.

Two paths: let the cloud team define the endpoint and have the SDK conform, or define the contract in
this repo as the interface the cloud must implement. The SDK is the side that emits, the payload model
is already owned here (ADR-0013's dataclass models), and the SDK must be testable against a fixed shape
before the cloud exists. So the contract is defined here.

## Decision

The stdlib dataclass models in `src/sdk/python/ratel_ai/observability/models.py` (each with a
`to_wire()` method) are the **source of truth** for the wire format. The separately-built cloud **must implement this contract**; this ADR is the
human-readable specification.

### Transport

- **Endpoint:** `POST {RATEL_HOST}/v1/ingest` — `RATEL_HOST` defaults to `https://cloud.ratel.sh`.
- **Auth:** `Authorization: Bearer <RATEL_API_KEY>`. A missing/invalid key yields a 401/403; the SDK
  logs once and drops the batch (it never retries a 4xx and never raises into the caller).
- **Body:** one JSON object per request — a versioned envelope wrapping a batch of events (below).
- **Content-Type:** `application/json`.

### Envelope

```jsonc
{
  "schema_version": 1,
  "sdk": { "name": "ratel-ai-python", "version": "<package version>" },
  "batch": [ /* one or more events, each with a unique idempotency id */ ]
}
```

`schema_version` is an integer bumped only on a breaking change to this contract. The cloud must
accept any batch whose `schema_version` it recognizes and reject (400) one it does not.

### Events

Every event carries `id` (a per-event **idempotency key**, a UUID — retries reuse it so the cloud can
dedupe), `type`, `timestamp` (epoch ms), and `trace_id`. Three `type`s in v1:

**`trace-create`** — opens/updates a trace (root of a tree):

```jsonc
{ "id": "evt_...", "type": "trace-create", "timestamp": 1750800000000,
  "trace_id": "trc_...", "session_id": "sess-42", "name": "handle_ticket",
  "user_id": "user-123", "tags": ["prod"], "version": "1.4.0",
  "metadata": { "tenant": "acme" }, "release": "git-sha-abc" }
```

**`observation-create`** — a span, generation, or event within a trace:

```jsonc
{ "id": "evt_...", "type": "observation-create", "timestamp": 1750800000010,
  "trace_id": "trc_...", "observation_id": "obs_...", "parent_observation_id": null,
  "observation_type": "generation",            // "span" | "generation" | "event"
  "name": "openai.chat.completions",
  "start_time": 1750800000010, "end_time": 1750800000420,
  "status": "ok",                              // "ok" | "error"
  "status_message": null,
  "level": "default",                          // "default" | "warning" | "error"
  "input":  { "captured": true, "value": [ {"role":"user","content":"..."} ] },
  "output": { "captured": true, "value": {"role":"assistant","content":"..."} },
  "metadata": {},
  "gen_ai": {                                  // present only for generations; OTel-GenAI-named
    "system": "openai",
    "request":  { "model": "gpt-4o", "temperature": 0.2, "max_tokens": 1024 },
    "response": { "model": "gpt-4o-2024-08-06", "finish_reasons": ["stop"] },
    "usage":    { "input_tokens": 812, "output_tokens": 96, "total_tokens": 908 } } }
```

**Capture toggles:** when input/output capture is disabled, the field carries metadata only —
`{ "captured": false, "length": 1234 }` — never the content.

**Cost** is intentionally absent from every event. The cloud resolves cost from `gen_ai.response.model`
(falling back to `gen_ai.request.model`) and `gen_ai.usage.*` against its own price table.

### Langfuse mapping (cloud-side, normative for the forwarder)

| Ratel wire | Langfuse |
|---|---|
| `trace-create` | trace |
| `observation-create` (`span` / `generation` / `event`) | observation / generation / event |
| `trace_id`, `observation_id`, `parent_observation_id` | trace id, observation id, parent id |
| `gen_ai.request.model` (or `response.model`) | model |
| `gen_ai.usage.{input,output,total}_tokens` | usage |
| `input` / `output` `.value` | input / output |
| `user_id`, `session_id`, `tags`, `version`, `metadata` | same |

### Reliability (inherits ADR-0009)

Best-effort, lossy on backpressure. The SDK batches by size or interval, retries 5xx/network with
capped exponential backoff + jitter, drops on 4xx or after retries, and drops oldest on queue
overflow. Idempotency keys make any retry safe to dedupe cloud-side.

## Consequences

- The SDK is buildable and fully testable today against a fixed shape (mocked transport), before the
  cloud exists; the cloud team implements `POST /v1/ingest` to this spec.
- Bumping `schema_version` is the explicit, versioned path for any future breaking change; additive
  fields within a version are non-breaking, matching ADR-0009's treatment of the core schema.
- Idempotency keys + best-effort retries give at-least-once delivery with cloud-side dedupe, without
  oplog-grade durability on the SDK hot path.

## Rejected

- **Conform to a cloud-defined endpoint.** The cloud does not exist yet and the payload model is owned
  here; defining the contract SDK-side unblocks development and keeps one source of truth.
- **Per-event POSTs.** N requests per agent turn; batching amortizes egress and matches the queue-log
  reliability profile.
- **Cost in the payload.** See ADR-0013 — price tables go stale in a pip-installed SDK.
