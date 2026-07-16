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
reserved capability-tool ids, top-K clamping, first-registration-wins, passthrough of
non-executable tools, recall ids that are not transcript positions — and that a hand-duplicated
result shape drifts from the canonical one.

One package can't carry the peer-dependency ranges for every framework at once (npm can't scope
peers per subpath; `ai@^7` and `@mastra/core` can't both be peers of one package), so framework
support has to be per-package. The core must therefore expose a stable seam those packages plug
into.

## Decision

**A `RatelAdapter` SPI plus a `ratel(config)` factory. The core is a standalone,
framework-free object — a collection handle per catalog, an explicit `expose()`, a pure
`recall()` — and `adaptTo(aiSdk())` layers a framework-shaped view over the same state. An
adapter is three pure codecs; the core owns all state and every framework-independent guard.**

- **Registration and exposure are separate acts.** `r.tools` is a handle over the core's one
  `ToolCatalog` (mongo `db.collection` style): registration is callable at any time, including
  after exposure — the capability tools close over the live catalog and search at invocation
  time, and a semantic/hybrid catalog embeds incrementally per-register. `expose()` returns the
  model-facing set: the three capability tools (plus, on an adapted view, that view's
  passthroughs). It builds fresh objects per call — hosts take it once per agent instance and
  reuse it. Rejected: the one-shot `tools(appTools)` that ingested, built embeddings, and exposed
  in a single call — it hid that late registration is safe and made incremental use impossible.

- **The seam is three codecs + one extension hook.** `ingest(id, tool)` maps a framework tool to
  a `CatalogRegistration` (or `"passthrough"` for provider-executed tools that must stay eagerly
  exposed; passthroughs are framework-shaped, so they live per view); `expose(tool)` wraps a
  Ratel `ExecutableTool` into a framework tool; `recallMessages(ref, recall)` renders the
  synthetic `search_capabilities` pair in the framework's message shape. `extend(base)` adds
  framework idioms (the AI SDK's mutate-and-append `appendRecall`, Mastra's `recallProcessor`)
  that surface on the adapted object with full framework typing via a `TExt` generic.

- **Explicit `adaptTo(adapter())`, not string keys or auto-require.** Types flow through generics
  (`AdaptedRatel<A>` infers the framework's tool/message types and the adapter's helpers), so app
  code needs zero casts. A string key would need a module-augmentation registry plus a dynamic
  `require` (async under ESM, opaque to bundlers).

- **The core owns all state and guards.** One `ratel(config)` is one `ToolCatalog` + one
  `SkillCatalog` + a private recall-id counter, shared by every `adaptTo` view (multiple adapters
  over one core → one catalog, embeddings built once; drift between "the object you modify" and
  "what the capability tools search" is structurally impossible because every handle wraps the
  same instance). Reserved capability-tool ids throw on registration on both paths; recall top-K
  is capped at 50 (0, negative, or non-integer values fall back to the default 5, never an
  unbounded set); server grouping treats a leading `__` as no prefix. Duplicate-id
  semantics are split by path on purpose: the adapted (codec) path is first-registration-wins
  across every view and the view's passthroughs, so repeated calls are idempotent and one view
  can't clobber another; the native path keeps the catalog's own replace-in-place semantics — it
  is the authoritative hot-swap path. The raw catalog stays reachable (`r.tools.catalog`) as the
  unguarded driver-level escape hatch.

- **All three capability tools are always advertised.** `expose()` never gates
  `get_skill_content` on `skills.size()`: the exposed set must not depend on registration order,
  or a skill registered after exposure makes `search_capabilities` return skill hits pointing at
  a tool the model was never given (a hard `NoSuchToolError` in AI SDK hosts). The
  `search_capabilities` description is pinned skills-inclusive the same way (an additive
  `advertiseSkills` option on the piecemeal builder, whose size-gated default is unchanged), so
  the exposed payload is byte-identical whether skills register before or after `expose()`.
  Loading from an empty skill catalog returns a structured error, not a missing tool — one
  dormant tool slot buys an order-independent, prompt-cache-stable set. Rejected: conditional
  advertisement with a caller pin — more surface for the same guarantee.

- **Core `recall(query)` is a pure query; adapted `recall` mints ids.** The core returns the
  canonical `SearchCapabilitiesResult` (or `null` on no match) with no call id — framework-free
  hosts format their own injection. The adapted view's `recall` returns the framework message
  pair (or `[]`, spending nothing) with a `callId` from the core's private counter, shared across
  views: history editing (trim/compaction) would otherwise repeat transcript positions as
  tool-call ids. A caller-supplied id factory was considered for restored-transcript collisions
  and deferred (YAGNI until a restore-heavy host needs it).

- **One exported `formatSearchCapabilities` is the single source of truth for the result shape.**
  The agent path (`searchCapabilitiesTool`, origin `agent`) and both recall paths (origin
  `direct`) call it, so they can never drift — the drift risk the prototype carried by
  hand-duplicating the shape. The SDK also re-exports `JSONSchema7` as its public JSON-Schema
  spelling, so adapters type their registrations without casting through private SDK internals.

- **Detection powers error messages only.** A framework-shaped tool (zod-style schema, dynamic
  `description`, no `id`) hitting the native `r.tools.register(...)` throws an actionable error
  that names the exact adapter package to install, probing known frameworks with the existing
  `isPeerInstalled`. Detection can't tell *installed* from *in use* (Mastra depends on `ai`
  internally), so it never drives behavior — only the hint.

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
- Late-registered *passthroughs* are the one thing an already-exposed set can't pick up (they are
  plain framework tools, not catalog entries); surfacing them requires re-taking `expose()` — a
  visible, deliberate prompt-cache bust rather than an implicit mutation.
- Rejected: string-keyed adapters and auto-require sugar (breaks bundlers and static typing).
  Rejected: auto-detecting the framework from inside the core (structurally unreliable under
  pnpm strict `node_modules`; an adapter declaring the framework as a peer resolves it
  correctly). Rejected: a mutating `recall` on the base (the mutate-and-append idiom is
  framework-specific; the base stays pure). Rejected: throwing `tools()`/`recall()` stubs on the
  un-adapted core (the standalone core is genuinely usable; the install-the-adapter hint moved to
  the native registration shape guard). Rejected: duplicating the top-K clamp and result shape
  into the recall path (the shared `formatSearchCapabilities` removes the drift the prototype
  had).
