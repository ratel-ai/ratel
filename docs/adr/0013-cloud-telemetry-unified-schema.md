# 13. Cloud telemetry — unified strict schema, spec-rooted in Rust, pure-language clients

Date: 2026-06-30

## Status

Accepted

## Context

We want a new `cloud` library: developers send **agent events** — the request/response of an LLM
call — to a remote Ratel endpoint. The data is exactly what a dev already assembles for a provider
SDK: model, messages, tools, sampling params, token usage, finish reason. The product goal is that
turning provider-SDK data into a Ratel event is *near-trivial*.

Research over the call shapes devs target today pins the design space:

- **OpenAI Chat Completions** (`chat.completions.create`) — the de-facto wire format other providers
  (Groq, Together, Fireworks, OpenRouter, vLLM, Ollama) clone.
- **OpenAI Responses** (`responses.create`) — different names/nesting (`input`/`instructions`/
  `max_output_tokens`/`output[]`, flat tool defs, `input_text` parts).
- **Anthropic Messages** (`messages.create`) — `system` is top-level, content is always typed blocks,
  tool calls are `tool_use` blocks with **parsed-object** args, tool results are `tool_result` blocks
  inside a *user* message.
- **Vercel** — two surfaces at opposite ends of the difficulty range. The **AI Gateway** HTTP endpoint
  is OpenAI-Chat-Completions-compatible verbatim (covered by the OpenAI mapping; only the `creator/model`
  slug and an optional routing block differ). The **AI SDK** (`ai` package) is itself a normalization
  layer — *semantically the closest of all sources* to the canonical shape (same roles, content-block
  concept, tool results already split into a `tool` message, tool-call args already parsed, usage already
  provider-neutral). Its mismatches are mostly mechanical (camelCase, hyphenated `finishReason` /
  `tool-call`, `output:{type,value}` wrapper) plus two structural ones: **tools-as-a-keyed-record** (vs
  an array) and **Zod `inputSchema`** that must be converted to JSON Schema.

The same concepts appear everywhere; only the spelling differs. Three structural divergences are the
ones that bite any mapper: (1) where the system prompt lives (top-level vs a message), (2) how tool
calls and their results are represented and linked, (3) tool-call arguments as a JSON-encoded string
(OpenAI) vs a parsed object (Anthropic, AI SDK). Token-usage field names collide several ways
(`prompt_tokens`/`completion_tokens` vs `input_tokens`/`output_tokens` vs `inputTokens`/`outputTokens`
vs Anthropic's cache split).

Two questions stack:

1. **Passthrough or unified?** Capture each provider's raw payload verbatim (zero dev reformatting, but
   the library carries N schemas forever and pushes normalization onto every query and consumer), or
   define one canonical shape the dev populates.
2. **Where does the shape live, and how do clients reach it?** `ratel-ai-core` is the cross-language
   contract layer (ADR-0002, ADR-0011) and ADR-0009 already puts a *trace-event* schema and sink in it,
   emitted via synchronous NAPI. But the SDK packages are **native-addon packages** (NAPI/PyO3 cdylibs):
   they need a compiled binary per platform and **cannot run on edge/serverless JS runtimes** that can't
   load native addons — exactly where AI apps emit telemetry from.

This is **not** the ADR-0009 stream. ADR-0009 covers internal *tool-usage* traces (search / invoke /
auth) consumed locally by the inspector and rerankers, written to a JSONL sink over a NAPI hop. The
`cloud` library carries *LLM-call* payloads (full messages/tools/usage) to a *remote* endpoint over the
network. Different shape, different destination, different reliability and runtime constraints.

## Decision

### Unified, not passthrough

One canonical event shape. The dev populates it; the library does not carry per-provider schemas. This
inverts the cost model of passthrough: a one-time, shallow mapping at the edge (the dev's machine)
instead of N live schemas behind the SDK boundary and normalization re-paid on every query, dashboard,
and downstream consumer.

The "minimal reformatting" goal is met not by passthrough but by **choosing canonical representations
that sit close to all sources**, so the transform is shallow and obvious. Canonical choices:

| Field | Canonical form | Why it minimizes transform cost |
|---|---|---|
| System prompt | top-level `system` (nullable string) | Anthropic/Responses/AI-SDK already top-level; Chat hoists its `system` message out |
| `provider` / `model` | **resolved** provider + model (free-form strings) | a Gateway mapper splits the `creator/model` slug and records who actually served (e.g. `bedrock`), not just who was asked |
| Messages | roles `user`/`assistant`/`tool`; `content` = string **or** typed-block array | Anthropic/AI-SDK block model is the richest superset; OpenAI parts map 1:1 |
| Tool defs | flat array `{name, description, parameters}` (JSON Schema) | = Responses; Chat unwraps `.function`; Anthropic renames `input_schema`; AI-SDK iterates its record + Zod→JSON Schema |
| Tool calls | assistant block `{type:"tool_call", id, name, arguments}`, **arguments a parsed object** | Anthropic/AI-SDK already an object; OpenAI `JSON.parse` once at the edge — kills the JSON-string footgun |
| Tool results | a `tool` message `{tool_call_id, content}` | Chat/AI-SDK already there; Anthropic/Responses lift the block out by id |
| Usage | `{input_tokens, output_tokens, cached_tokens, reasoning_tokens}` | the rename table; pure field aliasing |
| Finish | `finish_reason` enum: `stop`/`length`/`tool_call`/`content_filter`/`refusal` | maps from `finish_reason`/`stop_reason`/`status`/hyphenated `finishReason` |

Canonical event (v1 — this is the entire surface):

```jsonc
{
  "provider": "openai",                          // resolved provider; free-form string
  "model": "gpt-5.5",                            // resolved model
  "ts": "2026-06-30T12:00:00Z",
  "latency_ms": 842,
  "stream": false,
  "system": "You are a weather assistant.",      // nullable
  "tools": [ { "name": "get_weather", "description": "...", "parameters": { /* JSON Schema */ } } ],
  "messages": [
    { "role": "user", "content": "Weather in Paris?" },
    { "role": "assistant", "content": [
        { "type": "text", "text": "Let me check." },
        { "type": "tool_call", "id": "call_9x", "name": "get_weather", "arguments": { "location": "Paris" } } ] },
    { "role": "tool", "tool_call_id": "call_9x", "content": "18°C, cloudy" }
  ],
  "params": { "temperature": 0.7, "top_p": 1.0, "max_tokens": 512, "stop": ["\n\n"] },
  "usage": { "input_tokens": 82, "output_tokens": 41, "cached_tokens": 0, "reasoning_tokens": 22 },
  "finish_reason": "tool_call"
}
```

Content block types in v1: `text`, `tool_call`, and `image`/`file` for multimodal (a
`{type, source|url, media_type}` shape covering all sources). Nothing else.

### Strict — unmodeled fields are dropped

The schema is closed. There is **no `extra` / `provider_metadata` escape-hatch bag.** Anything a source
sends that the canonical shape does not model — Anthropic `cache_control` breakpoints, thinking
`signature`s, OpenAI encrypted reasoning items, `logprobs`, audio parts, `previous_response_id`,
per-choice `n>1`, Vercel's `gateway` routing block and `providerMetadata` cache/safety extras — is
dropped.

Consequence accepted deliberately: the modeling bar for v1 is "captures what a cost / quality /
debugging dashboard needs," and everything else is consciously discarded. Vercel is the first source
where strict-drop costs something arguably useful — the Gateway's fine-grained routing/cache metadata —
but the single most important routing fact (which provider actually served the request) is preserved
**inside the modeled `provider`/`model` fields** by recording resolved values, not the requested slug.
No escape hatch is needed for that. Dropping is the **mapper's** job, never the dev's: for the
hand-populated path the struct simply has no field for unmodeled data, so it is lossless by construction
— you cannot supply what does not exist. Reasoning / thinking *content* is explicitly **not** modeled in
v1: the most source-divergent surface, the least telemetry value.

### Schema is a standalone Rust crate; clients are pure-language (spec-rooted, no runtime FFI)

"Core-owned" here means the schema is **rooted in a Rust crate as the canonical spec**, *not* that every
event crosses FFI at runtime. Concretely:

- **A new crate `ratel-ai-cloud`, a sibling of `ratel-ai-core`** (deps: serde only). It has **no
  dependency in either direction** with the gateway core. It holds the event types, serde
  (de)serialization, and strict validation, and is the single source of truth for the shape. **Rust /
  server consumers** (the future self-hosted consolidation endpoint) use it directly.
- **Client SDKs are pure-language**: `@ratel-ai/cloud` (pure TS) and the Python `ratel_ai-cloud` (pure
  Python) ship mirrored types, a validator, and a native non-blocking transport (`fetch` / `httpx`).
  **No native addon**, so they run anywhere — including Vercel Edge / Cloudflare Workers — and they add
  **no second per-platform binary matrix** on top of the gateway SDK's.
- **Drift is prevented by conformance fixtures, not the compiler.** The Rust crate emits canonical JSON
  test vectors; the TS and Python validators must round-trip them identically, enforced in CI. The
  client types are *mirrors* of the Rust spec kept honest by tests — the accepted cost of decoupling +
  edge reach.

This **intentionally diverges from ADR-0009's** synchronous-NAPI-into-a-core-sink model, for reasons
specific to a remote telemetry client that 0009's local JSONL sink does not face:

- **Edge runtimes can't load native addons.** If schema *validation/serialization* sat behind NAPI/PyO3,
  edge JS could not even *construct* an event — reintroducing the exact constraint that also rules out a
  Rust transport. Spec-rooted pure-language clients are the only shape that keeps edge a first-class
  target. (OpenTelemetry and Sentry use the same "shared spec, native-per-language" model.)
- **Package decoupling.** A sibling crate (not a module in `ratel-ai-core`) plus standalone client
  packages means installing telemetry pulls **zero** BM25 / tool-retrieval code, and `@ratel-ai/cloud`
  does **not** depend on `@ratel-ai/sdk`.
- **Non-blocking by construction.** Transport rides the host's own async runtime and HTTP stack and must
  never stall or crash the host app.

### Dev populates the shape; provider adapters are deferred

v1 ships the canonical schema plus a clean hand-populated builder, and **documents** the source→Ratel
mappings (the table above is the spec). Blessed adapter helpers (`fromOpenAIChat`,
`fromOpenAIResponses`, `fromAnthropic`, `fromVercelAISDK`) that collapse the mapping to a one-liner are a
**follow-up**, added once the schema has settled against real usage. The **Vercel AI SDK adapter is the
priority**, because it is the one source where the hand-populated path has real friction: its tools are a
keyed record whose `inputSchema` is typically a **Zod schema**, so a dev must run `zod-to-json-schema`
(or the SDK's `jsonSchema()` helper) to fill `parameters`. v1 docs show that one-liner so nobody is
stuck before the adapter lands.

## Consequences

- **One shape behind the SDK boundary.** The remote endpoint, queries, and every consumer see a single
  schema; no per-source branching downstream, no normalization re-paid at query time.
- **Cross-SDK consistency without runtime FFI.** TS and Python mirror one Rust spec, validated by shared
  conformance fixtures, so "strict" means the same thing everywhere — while the client packages stay
  pure-language and edge-capable.
- **Decoupled from the gateway.** `ratel-ai-cloud` is a sibling crate; the client packages are
  standalone. Installing telemetry never drags in tool retrieval, and there is no new per-platform native
  binary to build and ship.
- **The contract is lossy by design and that is locked.** Adding fields later is non-breaking; the absent
  escape hatch means any value we choose not to model in v1 is unrecoverable from a stored event —
  including Vercel's fine-grained routing metadata (the resolved provider survives via `provider`).
- **The spec-rooted split is deliberate — do not "fix" it by binding the schema through the native
  crates.** Doing so would break edge runtimes, recouple the cloud package to the gateway binary, and
  double the platform matrix. This ADR is the rationale.
- **`cloud` is a separate stream from ADR-0009 trace events.** Different shape, destination, and
  transport; not merged here.
- **Adapters are a measurable follow-up, Vercel first.** Their job is to map-and-drop; deferring them
  keeps the v1 surface small and lets real payloads tune the canonical shape before helpers freeze it.

### Package layout (decision-level; details in the implementation plan)

- **Schema** — `src/cloud/core` → crate `ratel-ai-cloud`: event types, serde, strict validation, and the
  conformance test vectors. Sibling of `ratel-ai-core`, independent of it. Directly usable by Rust /
  server consumers.
- **Clients** — pure-language packages, no native addon: `@ratel-ai/cloud` (TS) and `ratel_ai-cloud`
  (Python), each with mirrored types, a validator checked against the shared fixtures, and a non-blocking
  transport (batching, retry/backoff, endpoint/auth config).
- Each new folder gets its own `README.md` per the repo's folder-README rule.

## Rejected

- **Verbatim multi-API passthrough.** Zero dev reformatting, but the library carries N schemas forever,
  every consumer learns N shapes, and normalization is re-paid on every query. The unified shape pays
  that cost once, at the edge.
- **Escape-hatch `extra` / `provider_metadata` bag.** Lossless without bloating the core, but a
  half-modeled bag invites consumers to depend on un-normalized source internals — re-importing the
  passthrough problem through a side door. If a dropped field proves load-bearing (e.g. Vercel routing
  detail), model it explicitly in a later, non-breaking addition.
- **Schema bound through the native crates at runtime** (the ADR-0009 sink model). Every event crossing
  NAPI/PyO3 would block edge/serverless JS from even constructing an event, recouple `@ratel-ai/cloud` to
  the gateway native binary, and double the per-platform binary matrix. Spec-rooted pure-language clients
  avoid all three; conformance fixtures recover the no-drift guarantee the compiler would have given.
- **Cloud schema as a module inside `ratel-ai-core`.** Would couple any consumer of the shape to the BM25
  / tool-retrieval crate. A standalone sibling crate keeps telemetry installable on its own.
- **Reusing the ADR-0009 trace stream/sink.** Different payload (full LLM call vs tool-usage
  observation), destination (remote vs local JSONL/inspector), and reliability profile. Folding them
  together would couple two unrelated evolution paths.
- **Shipping provider adapters in v1.** Freezes the source→canonical mapping before the shape is proven
  against real payloads. Documented mappings now; helpers (Vercel first) once the schema settles.
- **Modeling reasoning/thinking content.** The most source-divergent surface, the least telemetry value.
  Dropped in v1.
```
