# Ratel telemetry conventions

The wire contract for Ratel's **remote** telemetry. Ratel telemetry *is* OpenTelemetry:
LLM calls are `gen_ai.*` spans, Ratel's capability/skill funnel is a `ratel.*` overlay on the
same traces, and ingest is stock OTLP. This document is what every consumer (Ratel Cloud,
dashboards, a self-hosted receiver) reads against; the per-language helpers under
`core/`, `ts/`, `python/` codify the `ratel.*` half as constants.

Decision of record: [ADR-0007, Telemetry: core-owned local trace stream, OTel remote conventions](../../docs/adr/0007-telemetry-two-streams.md).
This spec is the concrete mapping that ADR locks; it does not re-decide anything the ADR decided.

Scope is the **remote** stream only. The local JSONL trace stream (ADR-0007: `src/core/src/trace/`,
consumed by the statusline / savings report) is untouched and is **not** part of
this contract. Local and remote are two streams on purpose.

## The pin

Ratel adopts **OpenTelemetry semantic conventions v1.42.0, `gen_ai` group**, and tracks it explicitly.
The pin is the contract; consumers read against the pinned version, not "latest".

Two facts about this baseline the pin maintainer must know:

- The `gen_ai.*` group is **`Development`** (not Stable). It will churn. Absorbing a `gen_ai.*` rename
  is a deliberate, reviewed bump of this baseline, never ambient drift.
- At the **v1.42.0** tag the `gen_ai` group was **relocated** out of `open-telemetry/semantic-conventions`
  (into the still-untagged `semantic-conventions-genai` repo) and left behind as a frozen snapshot under
  `model/gen-ai/deprecated/`. "Deprecated" here means *moved*, not *withdrawn*: the v1.42.0 definitions are
  that frozen YAML. The keys below were read from it and cross-checked against the last live rendered prose (v1.41.0).

**Bump process.** Changing the pin is a reviewed change with its own PR: diff the new baseline's `gen_ai.*`
registry against this table, update the mapping and the `ratel.*`-adjacent notes, bump the constant in each
helper, and note the move in a superseding ADR if the shape (not just keys) changed.

## Two tiers

| Tier | Namespace | Owner | Carries |
|---|---|---|---|
| Base | `gen_ai.*` | OpenTelemetry (pinned v1.42.0) | the LLM call: operation, provider, model, params, usage, finish; message/tool content on the details event |
| Overlay | `ratel.*` | this repo | the capability/skill funnel (the ADR-0007 local event set + the ADR-0005 skill events) as spans + attributes on the same trace |

`gen_ai.*` is adopted **verbatim**, not one key renamed or re-nested. `ratel.*` is the only vocabulary
Ratel designs and versions. A Ratel-instrumented agent and a plain-`gen_ai.*` agent land in the same trace,
told apart by namespace and joined on trace/span id.

`ratel.*` follows ADR-0007's schema discipline: **adding** a span or attribute is non-breaking; **renaming or
removing** one is breaking and needs a superseding note.

---

## Tier 1: the LLM call (`gen_ai.*`)

An LLM call is a `gen_ai` client span. Span kind `CLIENT` (`INTERNAL` allowed for in-process models).
Span name is `{gen_ai.operation.name} {gen_ai.request.model}` (e.g. `chat gpt-5.5`), falling back to
`{gen_ai.operation.name}` when the model is unknown.

### Legacy inventory to `gen_ai.*`

The `src/cloud/` schema at `961985d` (pre-compaction ADR-0013, deleted, never published; in git
history) is the concept inventory. Every field re-expresses in a standard v1.42.0 key, including
cached and reasoning tokens, which the earlier assumption held were missing:

| Legacy field | `gen_ai.*` key (v1.42.0) | Notes |
|---|---|---|
| `provider` (resolved) | `gen_ai.provider.name` | Well-known enum, open to custom values. Replaces the deprecated `gen_ai.system`. Enum incl. `openai`, `anthropic`, `aws.bedrock`, `gcp.vertex_ai`, `azure.ai.openai`, `mistral_ai`, `x_ai`, ... |
| `model` (resolved) | `gen_ai.request.model` + `gen_ai.response.model` | request = asked, response = served |
| `ts` | span **start time** | not an attribute |
| `latency_ms` | span **duration** | also the `gen_ai.client.operation.duration` metric |
| `stream` | `gen_ai.request.stream` | boolean; cond. required iff streaming |
| `system` | `gen_ai.system_instructions` | on the details **event** (content), see Tier 1 content |
| `tools` (offered defs) | `gen_ai.tool.definitions` | Opt-In; list of JSON-schema-shaped defs |
| `messages` | `gen_ai.input.messages` / `gen_ai.output.messages` | on the details **event**, see Tier 1 content |
| `params.temperature` | `gen_ai.request.temperature` | double |
| `params.top_p` | `gen_ai.request.top_p` | double |
| `params.max_tokens` | `gen_ai.request.max_tokens` | int |
| `params.stop` | `gen_ai.request.stop_sequences` | string[] |
| `usage.input_tokens` | `gen_ai.usage.input_tokens` | **includes** cached tokens |
| `usage.output_tokens` | `gen_ai.usage.output_tokens` | **includes** reasoning tokens |
| `usage.cached_tokens` | `gen_ai.usage.cache_read.input_tokens` | subset of `input_tokens`. (`cache_creation.input_tokens` also exists for cache writes.) |
| `usage.reasoning_tokens` | `gen_ai.usage.reasoning.output_tokens` | subset of `output_tokens`; "when applicable" |
| `finish_reason` | `gen_ai.response.finish_reasons` | **array** (string[]), one per generation |

Additional v1.42.0 keys worth emitting when available: `gen_ai.response.id`, `gen_ai.conversation.id`,
`gen_ai.request.seed`, `gen_ai.request.top_k` (double), `gen_ai.request.frequency_penalty`,
`gen_ai.request.presence_penalty`, `gen_ai.request.choice.count`, `gen_ai.output.type`,
`server.address` / `server.port`, `error.type`.

**`finish_reason` value note.** The legacy enum was `stop | length | tool_call | content_filter | refusal`.
The v1.42.0 normative **output-message** schema (`gen-ai-output-messages.json`, the per-message
`finish_reason` field) is `stop | length | content_filter | tool_call | error`, with no `refusal`. Emit the
singular `tool_call` from that schema; do **not** emit `tool_calls` (plural), which is the value from the
*deprecated* `gen_ai.choice` event, not the message-part schema. The span-level
`gen_ai.response.finish_reasons` array is an open `string[]`, so emit `refusal` verbatim there rather than
lossily folding it into `content_filter`.

**Do not spec these stale keys:** `gen_ai.system` (to `provider.name`), `gen_ai.usage.prompt_tokens`
(to `input_tokens`), `gen_ai.usage.completion_tokens` (to `output_tokens`), `gen_ai.prompt` / `gen_ai.completion`
(to messages), `gen_ai.openai.request.seed` (to `request.seed`).

### Tier 1 content: on events, never span attributes

Message text and tool-call arguments ride the **`gen_ai.client.inference.operation.details`** event
(`gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages`), never span attributes.
Locked by ADR-0007: attributes are size-bounded and message content is not.

Message shape (v1.42.0): `{ role, parts[], name? }`; output messages also carry `finish_reason`.
Roles: `system | user | assistant | tool` (open). `system_instructions` is a bare `parts[]` (no role wrapper).

Legacy content blocks to v1.42.0 message parts:

| Legacy block | v1.42.0 part `type` | Notes |
|---|---|---|
| `Text { text }` | `text` (`content`) | |
| `ToolCall { id, name, arguments }` | `tool_call` (`id?, name, arguments`) | on an **assistant** message; `arguments` a parsed object |
| tool result (`Message::Tool { tool_call_id, content }`) | `tool_call_response` (`id?, response`) | on a **tool** message; normative field is `response` (the registry example shows `result`, a known upstream schema/example mismatch) |
| `Image { source, media_type }` (inline) | `blob` (`modality: image`, `mime_type`, `content` = base64) | |
| `Image { url, media_type }` | `uri` (`modality: image`, `uri`) | |
| `File { source, media_type }` | `blob` (`modality` per mime) or `file` (`file_id`) | |
| `File { url, media_type }` | `uri` | |
| (reasoning / thinking text) | `reasoning` (`content`) | new in v1.42.0; the legacy schema flagged this as the most sensitive surface |

Other v1.42.0 parts available but not in the legacy inventory: `server_tool_call` /
`server_tool_call_response` (provider-executed tools), `generic` (extensibility escape hatch).

**Capture gating.** Content is Opt-In, **default off**. The gate is the ecosystem instrumentation
convention `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`. Note this is an *instrumentation-level*
convention, not a semconv-v1.42.0 attribute. Honor it rather than inventing a Ratel flag. Values:
legacy boolean, or the enum `NO_CONTENT` (default) | `SPAN_ONLY` | `EVENT_ONLY` | `SPAN_AND_EVENT`.

---

## Tier 2: the Ratel funnel (`ratel.*`)

The local trace event set (ADR-0007) plus the skill events (ADR-0005) are the mapping source: search, invoke (start/end/error), skill search/invoke,
upstream-MCP ingest, auth / `needs_auth`. Each becomes a span (or attributes on a `gen_ai` span) under `ratel.*`.

**Errors** use standard OTel span status (`ERROR`) + `error.type` and the exception event, not a bespoke
`ratel.*.error` attribute. **Origin** (agent-synthesized vs direct library call) is a shared attribute:

| Attribute | Type | On | Values |
|---|---|---|---|
| `ratel.origin` | enum | search, invoke | `direct \| agent` |

### `ratel.search`: capability search (unifies `search`, `gateway_search`, `skill_search`)

| Attribute | Type | Notes |
|---|---|---|
| `ratel.search.target` | enum | `tool \| skill` (folds tool-search and skill-search into one span shape) |
| `ratel.search.top_k` | int | requested result count |
| `ratel.search.hit_count` | int | results returned |
| `ratel.search.query` | string | **content, gated** like message content; may hold user/agent text |
| `ratel.origin` | enum | `direct \| agent` |

Hit ids + scores (and per-stage BM25 timing) ride an Opt-In span event **`ratel.search.results`**, gated with
the same content flag; the span itself carries only counts.

### tool invocation: `execute_tool` span + `ratel.*`

An `invoke_tool` call (unifying `invoke_start/end/error`, `gateway_invoke/error`, `upstream_invoke/error`)
is modelled as a standard **`gen_ai.operation.name = execute_tool`** span (interop: a generic OTel backend
already understands it) enriched with `ratel.*`:

| Attribute | Type | Notes |
|---|---|---|
| `gen_ai.tool.name` | string | the capability tool id |
| `gen_ai.tool.call.id` | string | when available |
| `ratel.tool.args_size_bytes` | int | argument payload size (from `invoke_start`) |
| `ratel.upstream.server` | string | upstream MCP server backing the tool, when the invoke proxies one |
| `ratel.origin` | enum | `direct \| agent` |

Span duration is the invoke latency; failure sets span status `ERROR`. Tool arguments/results are Opt-In
content on the span attributes `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` (distinct from the
`tool_call_response` message part's `response` field above), gated like messages.

> **Decided (2026-07-05):** invoke is modelled as an `execute_tool` span enriched with `ratel.*`, for
> OTel-backend interop, not a pure `ratel.invoke` span. The considered alternative (a pure `ratel.invoke`
> span, full tier separation, no interop) was rejected. Revisit only via a superseding note.

### `ratel.skill.load`: skill content load (`skill_invoke` / `get_skill_content`)

| Attribute | Type |
|---|---|
| `ratel.skill.id` | string |

### `ratel.upstream.register`: upstream-MCP ingest (`upstream_register`)

| Attribute | Type | Notes |
|---|---|---|
| `ratel.upstream.server` | string | |
| `ratel.upstream.transport` | string | `stdio \| http \| sse \| ...` |
| `ratel.upstream.tool_count` | int | tools ingested |

### `ratel.auth.flow`: MCP auth (`auth_refresh`, `auth_needs`, `auth_flow_start/end`)

| Attribute | Type | Notes |
|---|---|---|
| `ratel.upstream.server` | string | |
| `ratel.auth.outcome` | enum | `ok \| refreshed \| needs_auth \| failed` (`needs_auth` = the 401-driven `AuthNeeds`) |

### Out of the remote tier

`index_churn` / `skill_churn` are internal catalog-maintenance events with no consumer in this
mapping source. They stay **local-only** (the ADR-0007 JSONL stream) and are not expressed in `ratel.*`.

---

## Ingest bounds (informative, server-side)

The legacy schema's abuse/`int4` bounds (about 2 MB per text field, about 20 MB per blob, `int4` token ceilings,
at most 10k messages, at most 2k tool defs, cache <= input, reasoning <= output) are **enforced at ingest**
(Ratel Cloud), not re-implemented in the helpers. They are recorded here so the mapping is complete; a helper
does not reject an oversized span, the ingest endpoint does.

---

## Conformance

The OTel re-founding (ADR-0007) retired the legacy schema's three-way golden-JSON round-trip. That
machinery existed to stop three hand-mirrored schemas from drifting; with one borrowed schema
(`gen_ai.*`) and one owned overlay (`ratel.*`), that reason is gone.

**Decided (2026-07-05):** keep a conformance suite but re-scope it as below. This resolves the phrase
"rebuild the conformance-vector pattern" carried over from the task brief, which predates that
retirement of the cross-mirror fixtures.

Conformance is re-scoped to **contract-against-the-pin**: a shared fixture set of
`(known input -> expected emitted keys/values)`, asserted per language against an in-memory span/event
exporter. Each helper, given a fixture, must emit the exact `gen_ai.*` keys this spec pins and the `ratel.*`
keys it owns, at the pinned semconv version. This tests "does the helper emit the convention correctly",
not "do three schemas agree". The `ratel.*` constants are the unit under test; `gen_ai.*` keys are asserted
against the v1.42.0 table above.

## `init()` surface (recorded; implemented in the helpers)

Each helper is `init()` sugar over the standard OTel SDK plus the `ratel.*` constants: no transport, no FFI,
no schema crate. `init()`:

- Resolves the endpoint from `RATEL_OTLP_ENDPOINT` in TypeScript and `RATEL_URL` in Python;
  explicit `endpoint` / `endpoint=` values win over the environment. Resolves auth from
  `RATEL_API_KEY`; explicit `apiKey` / `api_key=` values win. Custom `headers` compose with either
  form. An explicit API key sets `Authorization: Bearer ...`; the `RATEL_API_KEY` fallback applies
  only when neither an explicit API key nor an explicit `Authorization` header is given, so ambient
  env never clobbers auth the caller set on purpose.
- On first setup, accepts `enabled: false` (`enabled=False`) before resolving configuration or
  registering a provider, returning a no-op shutdown handle (in Python this also avoids importing
  the OTel SDK at all; the TS package statically imports the SDK at module load either way). The
  composable span-processor has the same switch. If Ratel already owns the global provider,
  idempotence wins and every later `init()` call returns the original handle regardless of options.
- Exports every span by default on the turnkey path; `spanFilter` (`span_filter`) narrows that set
  without requiring callers to construct their own provider.
- Is idempotent to itself: while the Ratel-owned provider is active, repeated calls (including
  module reloads) return the exact original handle and the first call's configuration remains
  authoritative; because that handle is shared, shutting it down stops export for every caller. A
  foreign global provider still raises with processor-based coexistence guidance.
- Shutdown is terminal: OTel's global provider registers once per process, so after the handle's
  `shutdown()` a later `init()` raises rather than return a dead handle (TS callers can
  `trace.disable()` first to re-initialize; Python has no equivalent).
- Wires an OTLP **`http/protobuf`** exporter with sane batching + resource defaults; everything else is the
  untouched OTel SDK the caller can configure directly.
- Exposes the `ratel.*` attribute/span constants so callers emit the vocabulary without stringly-typed keys.
- Honors `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` for content capture (default off).

A caller who already runs the OTel SDK skips `init()` and adds `ratelSpanProcessor()` /
`ratel_span_processor()` to that provider. The processor defaults to the `gen_ai.*` / `ratel.*`
signal filter and can be overridden. Installing `@ratel-ai/telemetry-otlp` or the Python `[otlp]`
extra supplies the complete exporter/SDK implementation; callers do not assemble the individual
OpenTelemetry packages themselves.

**Composition on the owned provider (TS).** The TS turnkey entry is now `startTelemetry`
(`init` retained as a back-compat alias). Beyond `spanFilter`, it accepts host `spanProcessors`
registered alongside Ratel's on the same owned provider — one span stream fans out to all of
them, each applying its own filter — so a greenfield caller dual-exports (e.g. to Langfuse)
without ceding the global provider to a foreign one. The returned handle adds `forceFlush()`
(drain every registered processor; for serverless/jobs) beside `shutdown()`. Additive per
ADR-0007 schema discipline; the Python helper keeps the `init()` surface until it follows.
