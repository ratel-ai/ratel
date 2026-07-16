# 12. Framework adapter SPI: `ratel(config).adaptTo(adapter)`

Date: 2026-07-15

## Status

Accepted

Builds on the framework-neutral capability tools (ADR-0007's `search_capabilities` /
`invoke_tool` / `get_skill_content` funnel) and the optional-peer detection pattern first shipped
for `@ratel-ai/telemetry-otlp`. Design source: the reviewed proposal *TS framework adapter
packages*; this ADR records the SPI that its first phase lands in `@ratel-ai/sdk`.

## Context

The SDK ships framework-neutral primitives (`ToolCatalog`, `SkillCatalog`, the capability-tool
builders) but no first-class way to work in a host framework's native tool and message shapes.
Every AI SDK or Mastra host re-hand-wrote the same glue: convert framework tools into catalog
registrations, wrap the capability tools back into framework tools, and splice a synthetic
`search_capabilities` pair into the framework's message array for per-turn recall. The
`bratislava` prototype (live-verified against `ai@7.0.26`) proved the glue is ~150 LOC of three
codecs, but also that the value lives in a set of guards that must not be re-derived per host —
reserved gateway ids, top-K clamping, first-registration-wins, passthrough of non-executable
tools, recall ids that are not transcript positions — and that a hand-duplicated result shape
drifts from the canonical one.

One package can't carry the peer-dependency ranges for every framework at once (npm can't scope
peers per subpath; `ai@^7` and `@mastra/core` can't both be peers of one package), so framework
support has to be per-package. The core must therefore expose a stable seam those packages plug
into.

## Decision

**A `RatelAdapter` SPI plus a `ratel(config)` factory. A host writes
`ratel(config).adaptTo(aiSdk())` and gets a framework-shaped view; the core owns all state and
every framework-independent guard, so an adapter is three pure codecs.**

- **The seam is three codecs + one extension hook.** `ingest(id, tool)` maps a framework tool to
  a `CatalogRegistration` (or `"passthrough"` for provider-executed tools that must stay eagerly
  exposed); `expose(tool)` wraps a Ratel `ExecutableTool` back into a framework tool;
  `recallMessages(ref, recall)` renders the synthetic `search_capabilities` pair in the
  framework's message shape. `extend(base)` adds framework idioms (the AI SDK's
  mutate-and-append `appendRecall`, Mastra's `recallProcessor`) that surface on the adapted
  object with full framework typing via a `TExt` generic.

- **Explicit `adaptTo(adapter())`, not string keys or auto-require.** Types flow through generics
  (`AdaptedRatel<A>` infers the framework's tool/message types and the adapter's helpers), so app
  code needs zero casts. A string key would need a module-augmentation registry plus a dynamic
  `require` (async under ESM, opaque to bundlers).

- **The core owns all state and guards.** One `ratel(config)` is one `ToolCatalog` + one
  `SkillCatalog` + a private recall-id counter, shared by every `adaptTo` view (multiple adapters
  over one core → one catalog, embeddings built once). The guards live in the factory, so every
  adapter inherits them: reserved gateway ids throw on registration, recall top-K is clamped to
  `[1, 50]`, first registration of an id wins (`catalog.has`), `ingest → "passthrough"` keeps
  non-executable tools exposed, and server grouping treats a leading `__` as no prefix.

- **`AdaptedBase.recall(query)` is pure.** It returns a fresh message pair (or `[]` when nothing
  matched, spending no call id), never mutating a host array — the mutate-and-append idiom is
  AI-SDK-specific and lives in that adapter's `extend`. Recall ids come from the private counter,
  never a transcript position: history editing (trim/compaction) would otherwise repeat them as
  tool-call ids. A caller-supplied id factory was considered for restored-transcript collisions
  and deferred (YAGNI until a restore-heavy host needs it).

- **One exported `formatSearchCapabilities` is the single source of truth for the result shape.**
  Both the agent path (`searchCapabilitiesTool`, origin `agent`) and the host-driven recall path
  (origin `direct`) call it, so the two can never drift — the drift risk the prototype carried by
  hand-duplicating the shape. The SDK also re-exports `JSONSchema7` as its public JSON-Schema
  spelling, so adapters type their registrations without casting through private SDK internals.

- **Detection powers error messages only.** A `ratel()` core used framework-shaped without
  `.adaptTo(...)` throws an actionable error that names the exact adapter package to install,
  probing known frameworks with the existing `isPeerInstalled`. Detection can't tell *installed*
  from *in use* (Mastra depends on `ai` internally), so it never drives behavior — only the hint.
  The framework-free escape hatches (`core.catalog`, `core.skills`) stay available.

The existing piecemeal API (`ToolCatalog`, the capability-tool builders) is unchanged; the factory
is additive.

## Consequences

- A framework adapter is ~three pure functions plus its idioms; correctness of the shared guards
  and result shape is the core's job and is tested once. This is what makes community adapters
  safe (a conformance testkit, next phase, pins the contract).
- Telemetry stamping of the adapter's `name` as a `ratel.adapter` attribute is deferred to the
  adapter packages: the attribute is a vocabulary addition across the Rust/TS/Python telemetry
  triple (ADR-0007) and lands with the first adapter that emits it, not with the core SPI. The
  `name` field is carried on the SPI now so adapters supply it from day one.
- Rejected: string-keyed adapters and auto-require sugar (breaks bundlers and static typing).
  Rejected: auto-detecting the framework from inside the core (structurally unreliable under
  pnpm strict `node_modules`; an adapter declaring the framework as a peer resolves it
  correctly). Rejected: a mutating `recall` on the base (the mutate-and-append idiom is
  framework-specific; the base stays pure). Rejected: duplicating the top-K clamp and result
  shape into the recall path (the shared `formatSearchCapabilities` removes the drift the
  prototype had).
