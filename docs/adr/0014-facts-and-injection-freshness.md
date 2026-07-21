# 14. Facts: constant grounding content with a transcript-derived re-injection gate

Date: 2026-07-20

## Status

Accepted

Builds on first-class skills (ADR-0005), the selectable retrieval engines (ADR-0004,
ADR-0011), the two telemetry streams (ADR-0007), and the framework-adapter SPI (ADR-0013):
facts reuse the skill registry pattern wholesale and surface through the same `recall`/adapter
seam.

## Context

Everything Ratel puts in the context window is **pull-based**: a query ranks the tool and skill
catalogs and only the winners are surfaced (`search_capabilities`, `recall`). That is the right
default for large catalogs where a fraction is relevant per turn — but it has no home for the
opposite need. A customer running a barbershop agent has a handful of *constant* facts the model
must always work from: the shop's address, its opening hours, the brand's voice. These are not
"discovered by relevance" — the address must never fail to be present because the user's message
didn't lexically match "address." They also want to *manage* these like skills: register them,
see which are used, edit them when the shop moves.

Two forces shape the design:

1. **Constant information spans two tiers.** A few facts are genuinely always-on (address,
   hours). Many more are constant-but-conditional (per-service pricing, cancellation policy,
   each barber's specialty) — injecting all of them every turn is exactly the token waste and
   noise Ratel exists to remove. So "constant info" is not one thing; it is an always-on tier
   plus a retrieval-gated tier.

2. **A transcript message persists.** Once a fact's body is injected as a message it stays in the
   history on every later turn. Naively re-appending an always-on fact each turn duplicates it N
   times — pure token waste, and the model reads the repetition as significant. The question
   "should I inject this fact now?" therefore has a real answer beyond "always": inject only when
   it isn't already fresh in the context.

The naive framing — "a second recall that also searches constant info" — is wrong for tier 1: it
re-gates the always-on facts behind relevance, reinventing the very thing that already exists.

## Decision

**Introduce `Fact` as a third registered primitive, parallel to `Tool` and `Skill`, split into an
always-on and a retrieval-gated tier by a `pin` mode; and gate its injection with a stateless,
transcript-derived freshness check so a fact is (re-)injected only when it is absent, changed, or
buried — never merely because a turn elapsed.**

### Facts as a third registry

A `Fact` is `{ id, name, description, tags, metadata, body, pin }` — a `Skill` minus `tools`, plus
`pin: "always" | "retrieved"` (default `retrieved`). `name`/`description`/`tags` are indexed
(both tiers are query-rankable, so a pinned fact stays discoverable); `body` is the injected
content, never indexed. It gets its own `FactRegistry` in `ratel-ai-core` — a near-clone of
`SkillRegistry` (BM25/semantic/hybrid, replace-in-place, `IndexMap` insertion order) — and its own
`FactCatalog` / native binding in each SDK. Per ADR-0007's "a parallel type lets each capability's
telemetry stand on its own," facts emit their own `fact_search` / `fact_churn` / `fact_inject` /
`fact_inject_skip` events rather than borrowing the skill stream.

- **Pinned (`always`)** facts are the push tier: injected every applicable turn, bypassing
  ranking. Kept small — they are paid for on every injection.
- **Retrieved** (the default) facts are ranked like skills and surfaced only when a query pulls
  them in. They ride the existing `recall` path as a third bucket in
  `formatSearchCapabilities`, alongside `tools` and `skills`, with the `body` inline (facts are
  small — no second `get_*_content` round-trip).

### The re-injection freshness gate

Injection is a pure decision over four cases, computed by `planInjection`:

| Trigger | Meaning | Detection |
|---|---|---|
| `never` | not yet injected this session | no marker in the transcript |
| `evicted` | injected earlier, marker now gone | absent + present in the session's injected-id set |
| `mutated` | body changed since injection | marker's content hash ≠ current hash |
| `stale` | present but buried past the window | marker distance > `freshnessWindow` (opt-in; default off) |

The state lives in **the transcript itself**, not an external store: each injected fact carries an
unobtrusive marker `⟦ratel:fact id=<id> v=<hash>⟧`; reading markers back out of the current
history reconstructs the ledger. This keeps the whole feature in-process with no conversation id
and no persistence — compaction removing a marker naturally re-arms injection, and a content hash
in the marker catches edits. The only session state is a small set of injected ids, used solely to
tell `evicted` from `never`. `ratel().ground(query, transcript)` returns structured items (body +
marker + reason) plus the ids it skipped; the adapter renders them, embedding each marker beside
its body so the next turn can dedupe.

Freshness is positional (messages/tokens back), not wall-clock — what matters is a fact's place in
the window, not elapsed minutes. The `stale` (distance-based) re-inject defaults **off**, because
an append-only transcript cannot remove the old buried copy, so a stale re-inject would duplicate
rather than move it; presence-based re-injection (`never`/`evicted`/`mutated`) is always safe.

## Consequences

- **The always-on tier becomes cache-friendly, not cache-hostile.** Skipping re-injection keeps
  the transcript prefix stable across turns, so the feature *improves* prompt-cache hit rates
  instead of churning them. "Pay every turn" becomes "pay once per lifetime-in-window."
- **Facts reuse ~everything from skills.** The registry, native bindings, catalog facade, and
  telemetry plumbing are mechanical parallels — low new surface, and the retrieval behavior is
  identical and already proven.
- **The planner is a reusable primitive.** `planInjection` / `readGroundingLedger` /
  `factHash` are pure and framework-agnostic; adapters render, the core decides. Nothing about the
  gate is fact-specific in principle — it is injection-deduplication that could later apply to any
  pushed content.
- **Known limits, accepted.** (1) Compaction that *summarizes* rather than drops may preserve a
  fact's content while removing its marker, causing a redundant re-inject; undetectable in general.
  (2) The `stale` re-inject can duplicate on append-only adapters, hence default-off. (3) The
  content hash is FNV-1a (change-detection, not security): a collision only skips a re-inject of
  changed content. (4) Fact ids are constrained to `[A-Za-z0-9._:-]+` so the marker is
  unambiguous — validated at the catalog boundary.
- **Deciding the tier is the author's job.** The `pin` flag — an enum (`Pin.Always` /
  `Pin.ALWAYS`, wire strings still accepted) — is the whole UX; new facts default to `retrieved`
  and are promoted to `always` deliberately. A size cap on the always-on tier is left to a
  follow-up.

## Rollout: behind an `experimental` namespace

Facts ship **experimental** — a new, unproven API we want to trial in the open before committing to
stability. The whole surface (catalog, registry, planner, `Pin`, the grounding types) is reachable
only through an `experimental` namespace (`experimental.FactCatalog` in TS via `export * as
experimental`; `ratel_ai.experimental` in Python), never the root export, so any dependence on it is
explicit at the import site. Constructing a `FactCatalog` logs a one-time warning (silence:
`RATEL_EXPERIMENTAL_SILENCE`). The `ratel()` touchpoints that can't move off the stable object
(`r.facts`, `r.ground`, `RatelConfig.factsTopK` / `freshnessWindow`, the recall `facts` bucket) are
tagged "⚠️ Experimental" in their docs. The freshness gate lives on `FactCatalog.ground` (it owns
the fact state); `r.ground` is a thin delegate. Graduation is non-breaking: add the stable root
export, keep the `experimental.*` alias as a deprecated shim, and measure adoption in between.
