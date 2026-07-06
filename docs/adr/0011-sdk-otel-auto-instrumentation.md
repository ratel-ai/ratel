# 11. SDK auto-instrumentation: emit the OTel funnel from the SDK, wire the exporter opt-in

Date: 2026-07-06

## Status

Accepted

Extends [ADR-0007](0007-telemetry-two-streams.md) (the two-stream model and the `gen_ai.*` /
`ratel.*` remote vocabulary). ADR-0007 defined the wire; this ADR decides where the SDK
*creates* the spans and how a host turns the export on.

## Context

ADR-0007 established that the remote path **is** OpenTelemetry: LLM calls are `gen_ai.*`
spans, the gateway/skill funnel is a `ratel.*` overlay, and the `@ratel-ai/telemetry`
packages ship the vocabulary (`@ratel-ai/telemetry`, OTel-free constants) and the exporter
wiring (`@ratel-ai/telemetry-otlp`, `init()` / `ratelSpanProcessor`).

But those packages **create no spans** — they are plumbing plus a constant vocabulary. Until
now the main SDKs (`@ratel-ai/sdk`, `ratel-ai`) emitted only the *local* trace stream
(`recordEvent` into the core sink); no `ratel.*` / `gen_ai.*` span was ever produced. A
customer already running OpenTelemetry got nothing from Ratel on their traces, and Ratel Cloud
(which ingests stock OTLP at `/v1/traces`) had no emitter feeding it from the SDK.

The gap is *emission*: the SDK must open spans at its funnel boundaries. The open questions
were (a) where the spans attach, (b) whether emission is opt-in or always-on, and (c) whether
the base SDK install should pull the OpenTelemetry SDK.

## Decision

### The SDK always emits; the host decides where spans go

The catalog / gateway / skill / MCP paths open a span at each funnel boundary using
`@opentelemetry/api` and the `@ratel-ai/telemetry` constants — **alongside** the existing
`recordEvent` calls, never replacing them. Emission is unconditional but **free by default**:
`@opentelemetry/api` returns a non-recording span until a provider is registered, so an SDK
with no telemetry wired pays ~nothing and the local stream is byte-for-byte unchanged. This
mirrors how the Vercel AI SDK instruments: the library emits, the application owns the
destination.

Attach points (one span each, TS and Python identical):

| Site | Span | Key attributes |
|---|---|---|
| `ToolCatalog.invoke` | `execute_tool {id}` | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `ratel.tool.args_size_bytes` |
| `ToolCatalog.search` / `SkillCatalog.search` | `ratel.search` | `ratel.search.target` (tool/skill), `ratel.search.top_k`, `ratel.origin`, `ratel.search.hit_count` |
| `SkillCatalog.invoke` | `ratel.skill.load` | `ratel.skill.id` |
| `registerMcpServer` | `ratel.upstream.register` | `ratel.upstream.server` / `transport` / `tool_count` |
| gateway `needs_auth` | `ratel.auth.flow` | `ratel.auth.outcome=needs_auth`, `ratel.upstream.server` |

Tool invocation is the standard OTel `execute_tool` operation enriched with `ratel.*` (the
2026-07-05 decision in ADR-0007), not a bespoke span. Errors set OTel span status `ERROR` +
an exception event. Message/tool content (`ratel.search.query`, `gen_ai.tool.call.arguments`
/ `.result`) rides span attributes **only** when the ecosystem gate
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` selects a span mode — default off.

### Two wiring paths; base install stays OTel-SDK-free

- **Greenfield** — `configureTelemetry({ apiKey })`, exported from the SDK, lazily imports the
  optional peer `@ratel-ai/telemetry-otlp` and calls its `init()` to register a Ratel-owned
  OTLP exporter at `RATEL_URL`. The exporter package (which pulls the OpenTelemetry SDK) is an
  **optional peer dependency**, so the base SDK install adds only `@opentelemetry/api` (the
  no-op-capable API) and `@ratel-ai/telemetry` (zero-dependency constants) — honoring ADR-0007's
  "importing the vocabulary never pulls the OTel SDK".
- **Coexistence** — a host already running OpenTelemetry (Langfuse, the Vercel AI SDK, its own
  collector) skips `configureTelemetry` entirely: the SDK's spans already flow to the active
  global provider. It adds `ratelSpanProcessor` from `@ratel-ai/telemetry-otlp` to dual-export
  the `ratel.*` / `gen_ai.*` cut to Ratel Cloud.

## Consequences

- A customer on OpenTelemetry sees Ratel's retrieval/invoke funnel on their existing traces
  with zero Ratel-specific setup; pointing it at Ratel Cloud is one processor or one
  `configureTelemetry` call.
- The base SDK stays lightweight: no OTLP exporter, no OTel SDK, in a default install. The
  heavy dependency is pulled only when a caller opts into Ratel-owned export.
- Two channels now describe each operation — the local core stream (best-effort, offline
  inspector / savings) and the OTel span (remote, standards-based). They are independent by
  design (ADR-0007); the span additions do not touch local-stream shapes.
- The attach points are fixed vocabulary: adding a span or attribute is non-breaking; renaming
  or removing one is breaking and needs a superseding note (the ADR-0007 discipline).
- Content capture is off by default; a flat/empty `query`/`arguments` on spans is expected,
  not a bug — enabling it is the host's explicit choice via the ecosystem env var.
