# 15. Telemetry re-founding on OpenTelemetry conventions

Date: 2026-07-04

## Status

Accepted

Supersedes [ADR-0013 — Cloud telemetry, unified strict schema](0013-cloud-telemetry-unified-schema.md)
**fully**: its bespoke unified cloud-event schema, the `ratel-ai-cloud` crate, and the
`@ratel-ai/cloud` / `ratel_ai-cloud` pure-language clients. That work was implemented (see `src/cloud/`
at commit `961985d39cb10a17eefb5d585f7fc403d1e91590`) but **never published**; nothing downstream depends
on it. That SHA is pinned here as the **concept-inventory / mapping reference** for the Phase 3 build:
its canonical field table (system / provider / model / messages / tool calls / tool results / usage /
finish) is exactly the set we now re-express in `gen_ai.*` terms.

Amends [ADR-0009 — Trace events, core-owned schema](0009-trace-events-core-owned-schema.md) on the
**remote** stream only. The local JSONL trace stream 0009 owns — the `ratel-mcp` statusline / savings
report and `ratel inspect` — is untouched and stays as-is. Converging local and remote onto one stream is
an **explicit non-goal here** (see Rejected). ADR-0009 stays **Accepted**.

## Context

ADR-0013 designed a *cloud* library: a bespoke canonical LLM-call event, rooted as a Rust spec crate,
with hand-mirrored pure-language clients that carried their own HTTP transport, batching, retry, and
auth, plus conformance fixtures to keep the three copies from drifting. The design was sound for a
green-field wire protocol. But the product it serves — Ratel Cloud — is a telemetry **backend**, and the
market it lands in already standardized the exact thing ADR-0013 was defining from scratch.

Three facts, all post-dating ADR-0013, invalidate the build-it-ourselves premise:

1. **The industry converged on a standard for precisely this payload.** OpenTelemetry's Generative AI
   semantic conventions (semconv **v1.42.0**; the `gen_ai.*` group is `Development`, not yet Stable)
   model an LLM call as a span with `gen_ai.operation.name`, `gen_ai.provider.name`,
   `gen_ai.request.model` / `gen_ai.response.model`, `gen_ai.request.*` sampling params,
   `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`, and `gen_ai.response.finish_reasons`.
   Message and tool-call **content** rides a separate opt-in event,
   `gen_ai.client.inference.operation.details`, carrying `gen_ai.system_instructions`,
   `gen_ai.input.messages`, and `gen_ai.output.messages` as structured message parts (tool calls are
   `type: "tool_call"`, tool results `type: "tool_call_response"`). This is ADR-0013's concept inventory,
   already ratified, already emitted by upstream instrumentations, already ingested by every observability
   backend a customer runs (Langfuse, Grafana, Datadog, Arize, ...).

2. **A bespoke schema makes Ratel Cloud an island.** ADR-0013 would have every dev hand-map their
   provider SDK into *our* shape, and would make our stored data non-interoperable with the traces those
   same devs already emit. Adopting `gen_ai.*` inverts both: a customer who already instruments with OTel
   **dual-exports existing traces to us as a config change** — a second OTLP exporter pointed at the Ratel
   endpoint — with zero remapping.

3. **The transport was never ours to build.** ADR-0013's clients reimplemented batching / retry / backoff
   / auth per language. That is the OTel SDK's job, in every language, already hardened. Our
   pure-language, edge-capable, non-blocking requirements (ADR-0013's rationale for *not* using FFI) are
   satisfied verbatim by the standard OTel SDK — which is pure-language and runs on Vercel Edge /
   Cloudflare Workers.

What ADR-0013 got right and we keep: telemetry is a **separate concern from the gateway core** (no BM25 /
tool-retrieval code pulled in), it must be **pure-language and edge-capable** (no FFI, no per-platform
native binary), and it must be **non-blocking** on the host's own async runtime. OTel satisfies all three
by construction. What we drop: the custom schema, the custom transport, and the three-way conformance-
fixture machinery — all subsumed by the standard.

The open question this ADR answers is therefore *not* "what shape" (OTel decides that) but **"what does
Ratel add on top of a raw OTel SDK, and where is the Ratel-specific vocabulary?"**

## Decision

### Re-found telemetry on OpenTelemetry semantic conventions, pinned

Ratel's remote telemetry **is** OpenTelemetry. LLM calls are recorded as `gen_ai.*` spans; message and
tool-call content rides the `gen_ai.client.inference.operation.details` **event**, not span attributes
(see below). We pin a specific semconv baseline — **v1.42.0, `gen_ai` group** — and track it explicitly.
Because the `gen_ai.*` group is still `Development`, the pin is load-bearing: a bump is a reviewed change,
not an ambient drift, and the pinned version is the contract every consumer (Ratel Cloud, dashboards)
reads against.

### Two tiers: `ratel.*` on top of `gen_ai.*`

The convention layer is two tiers, layered not forked:

| Tier | Namespace | Owner | Content |
|---|---|---|---|
| Base | `gen_ai.*` | OpenTelemetry (pinned v1.42.0) | the LLM call: operation, provider, model, params, usage, finish; message/tool content on the details event |
| Ratel | `ratel.*` | this repo | Ratel's own gateway/skill vocabulary — the ADR-0009/0012 event set expressed as OTel spans/attributes |

Tier 1 is adopted verbatim; we do not rename or re-nest a single `gen_ai.*` field. Tier 2 is where
Ratel's distinctive signal lives: the capability-tool search / invoke / skill funnel. The ADR-0009 event
set (search, invoke start/end/error, upstream-MCP ingest, auth / `needs_auth`) and the ADR-0012 additions
(`gateway_search`, `skill_search`, `skill_invoke`) are the **mapping source**: each
becomes a `ratel.*`-namespaced OTel span or attribute set, so a Ratel-instrumented agent and a plain
`gen_ai.*` agent land in the same trace, distinguishable by namespace and joinable on trace/span id. We
own `ratel.*`; we borrow `gen_ai.*`.

### Content rides gen_ai message/log EVENTS, not attributes

Full message text and tool-call arguments are recorded on the `gen_ai.client.inference.operation.details`
**event** (`gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions`), never as
span attributes. This is not a stylistic preference — it is forced by the data:

- **Span attributes are size-bounded; message content is not.** ADR-0013's payload is unbounded text and
  parsed-object tool arguments. That is exactly what OTel attribute limits (default 128-attribute /
  length caps, backend truncation) are built to reject. Events / logs are the sanctioned channel for
  large, structured payloads, decoupled from the span's attribute budget.
- **Content is opt-in and separable.** The details event is gated (upstream:
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`), so PII-heavy content can be captured, sampled,
  routed, or dropped independently of the metrics-bearing span — which matches ADR-0013's own instinct
  that reasoning/thinking content is the most sensitive, least-portable surface.

This resolves, by adopting the standard's answer, the one place ADR-0013's "everything on one strict
struct" model would have collided with real telemetry limits.

### Thin per-language helper packages: `init()` sugar over the standard OTel SDK

We ship one thin helper per language whose entire job is `init()` sugar over the standard OTel SDK plus
the `ratel.*` convention constants. It is **not** a transport, **not** a schema crate, **not** an FFI
binding:

- Wires an OTLP exporter to `RATEL_URL` (or a caller-supplied endpoint) with the correct headers.
- Registers the pinned semconv version and exposes the `ratel.*` attribute/span constants so callers
  emit the Ratel vocabulary without stringly-typed keys.
- Sets sane batching / resource defaults; everything else is the untouched OTel SDK the caller can
  configure directly.

Consequences of "thin over standard": **no FFI, no transport code, pure-language, edge-capable** — the
Rust helper is a conventions crate (constants + a builder over `opentelemetry-otlp`); the TS and Python
helpers are pure-language wrappers over the OTel SDK already installed for any observability. A caller who
already runs the OTel SDK can skip our helper entirely and just add our endpoint as a second exporter —
the "dual-export your existing traces" path — with the `ratel.*` constants as the only thing they'd want
from us. There is no per-platform native binary matrix, and no `@ratel-ai/sdk` dependency.

### Ratel Cloud ingests plain OTLP; no custom scheme

Ratel Cloud speaks **OTLP over HTTP with protobuf encoding (`http/protobuf`) and a `Bearer` token**. No
custom wire format, no custom auth scheme, no Ratel-specific client required. This is the decision that
makes the two-tier layering pay off: because the ingest is stock OTLP, *any* OTel SDK in any language — ours, the
customer's existing setup, a collector in front of both — can point at Ratel Cloud by setting an endpoint
and an auth header. Adopting Ratel Cloud as a telemetry destination is a **configuration change on an
existing pipeline**, not a code migration. A self-hosted Ratel server consuming the same stream (the
ADR-0009-era "trace-consolidation" idea) is likewise just another OTLP receiver.

### Package names (recorded)

| Package | Registry | Role |
|---|---|---|
| `ratel-ai-telemetry` | crates.io | Rust conventions crate: `ratel.*` constants + OTLP `init()` builder |
| `ratel-ai-telemetry` | PyPI | Python helper: `init()` over the OTel SDK + `ratel.*` constants |
| `@ratel-ai/telemetry` | npm | TS/JS helper: `init()` over the OTel SDK + `ratel.*` constants |

Built in Phase 3 under `src/telemetry/{core,ts,python}`; released under the `telemetry-v*` tag prefix
(per ADR-0016). Each helper is `init()` sugar plus constants only — the shared "spec" is the pinned OTel
semconv version, not a Ratel crate the clients mirror.

## Consequences

- **Interoperable by construction.** Ratel telemetry is OTel telemetry. Existing traces dual-export to
  Ratel Cloud as a config change; Ratel-emitted traces ingest into any OTel backend the customer already
  runs. ADR-0013's bespoke schema would have made every one of those a remapping.
- **We stop owning transport and schema drift.** No custom wire format, no per-language batching/retry to
  maintain, no three-way conformance fixtures. The OTel SDK carries transport; the pinned semconv version
  carries the schema. Our surface shrinks to `ratel.*` constants + an `init()` builder.
- **Pure-language and edge-capable is inherited, not engineered.** ADR-0013 built the pure-language,
  no-FFI, edge-reachable property by hand and defended it at length; here it falls out of using the
  standard OTel SDK, which already has it.
- **The pin is a maintenance obligation.** `gen_ai.*` is `Development` and will churn. We own tracking
  semconv releases, deciding when to bump the pinned baseline, and absorbing any `gen_ai.*` renames — a
  cost we take deliberately in exchange for standardization. The pinned version, not "latest", is the
  contract.
- **`ratel.*` is the only vocabulary we design and version.** The ADR-0009/0012 event set is the input;
  its OTel expression under `ratel.*` is a schema we own and must treat with the care ADR-0009 gives the
  trace-event schema (adding is non-breaking; renaming/removing is not).
- **Content on events, not spans, is locked.** Message/tool payloads never inflate span attributes; they
  ride the opt-in details event, so PII and volume are governed independently of the metrics spans.
- **Local and remote stay two streams, on purpose.** The ADR-0009 JSONL stream (statusline / savings /
  `ratel inspect`) keeps its shape and sink; only the remote path re-founds on OTel. Convergence is a
  future decision, not this one.
- **ADR-0013's clients/crate are deleted, not migrated.** They were never published; `src/cloud/` at
  `961985d` is a reference for the concept inventory only, not a codebase to port.

## Rejected

- **Keep ADR-0013's bespoke unified schema + `ratel-ai-cloud` crate/clients.** A sound green-field design
  that predates — and now duplicates — a ratified industry standard covering the same payload. Shipping it
  would make Ratel Cloud non-interoperable with the OTel traces customers already emit and saddle us with
  a schema and transport to maintain in three languages forever. The concept inventory survives as the
  `gen_ai.*` mapping source; the code does not.
- **A bare-attribute schema (message content on span attributes).** Runs straight into OTel attribute
  size/count limits and backend truncation; unbounded message text and parsed tool arguments do not fit
  the attribute budget. The `gen_ai` details **event** is the standard's answer and ours.
- **Fork or rename `gen_ai.*` into a Ratel namespace.** Would re-break the interop that adopting OTel buys
  and re-import the "everyone remaps into our shape" problem through a side door. We layer `ratel.*` *on
  top of* an unmodified `gen_ai.*`, never over it.
- **A custom Ratel wire protocol / auth scheme for ingest.** Any deviation from stock OTLP forces a
  Ratel-specific client and blocks the "add a second exporter" adoption path. Plain `http/protobuf` +
  `Bearer` keeps ingest reachable from every existing OTel pipeline.
- **A fat SDK with its own transport (ADR-0013's client model).** Reimplements batching/retry/backoff/auth
  the OTel SDK already ships, hardened, in every language. The helper stays `init()` sugar; the SDK does
  the work.
- **Track semconv `latest` instead of a pin.** `gen_ai.*` is `Development`; unpinned tracking makes every
  upstream change an unreviewed break in our contract. We pin v1.42.0 and bump deliberately.
- **Converge the ADR-0009 local JSONL stream onto OTel now.** Tempting — one stream, one vocabulary — but
  the local stream serves the offline inspector / statusline / savings report with different reliability,
  latency, and offline-first constraints than a remote OTLP export. Folding them here would couple two
  independent evolution paths (the same reasoning ADR-0009 used to keep internal and external consumers on
  one *producer*, applied to keep local and remote on *separate* producers). Explicit non-goal; revisit as
  its own decision.
