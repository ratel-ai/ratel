# 12. Skill dependencies: a skills edge, expanded on request

Date: 2026-07-15

## Status

Accepted

Extends ADR-0005 (first-class skills: the `Skill` data model, the two-bucket
`search_capabilities` surface, and the dep-tool cross-pollination this mirrors) and
ADR-0003 (catalog pull-sync: the wire projection the new field rides).

## Context

A skill can declare the tools its instructions call (`tools`, ADR-0005), and
`search_capabilities` pulls those into the tools bucket so the agent gets a playbook and its
toolkit in one turn. Skills had no equivalent edge to other skills: a composed playbook
("deploy" references "rollback") forced the agent to burn a turn per sub-skill search, or
forced authors to inline sub-playbook bodies. The edge must not inflate every search result
by default — context economy is the product — and must survive the pull-sync contract without
breaking the frozen v1 ETag projection.

## Decision

**`Skill` gains `skills: string[]`** — ids of skills this skill's instructions reference — an
exact parallel of `tools`: a typed dependency edge, carried opaquely by the core, **never
indexed** as query terms. Same name and shape across Rust core, napi/pyo3 bindings, both
SDKs, and the wire.

**Expansion is per-call and off by default.** `search_capabilities` takes `maxDepth`
(integer, default 0, clamped to 0..=3). At the default the result is byte-identical to
before. At depth ≥ 1, a BFS seeded from the query-matched skills appends each declared dep to
the skills bucket — score 0, beyond the `topKSkills` budget, level by level in declared
order, deduped against query hits and each other (cycles terminate), unknown ids silently
skipped (mirrors the dep-tool behavior). Every surfaced skill — matched or dep — contributes
its declared `tools` to the tools bucket at score 0.

**Depth-0 recall path.** `get_skill_content` lists the loaded skill's known deps as
`skills: [{skillId, description}]` (omitted when empty), so an agent that keeps the default
can recall deps with one more load, no search.

**Wire (protocol v1, additive).** `CatalogSkillWire` gains an optional `skills` property.
The **ETag content projection stays frozen at the seven v1 fields**: `skills` is carried,
never hashed (conformance vector `dep-carrying` pins this). Documented staleness caveat: a
dep-only edit doesn't bust the ETag; a source SHOULD also touch a hashed field.

**Telemetry.** New attribute `ratel.search.dep_count` (skills pulled via expansion;
`hit_count` stays query-matched only). The local `skill_search` event gains a wire-defaulted
`dep_count`; the registry's own event always carries 0, and the capability layer records a
second `skill_search` for the expansion (deps as hits at score 0, `dep_count` ≥ 1).

## Consequences

- Composed playbooks resolve in one turn (`maxDepth: 1`) or one extra load (depth 0 +
  `get_skill_content`), instead of one search per sub-skill.
- Default-0 keeps every existing caller, test, and token budget byte-identical; the agent
  opts into expansion cost explicitly.
- The cap (3) bounds worst-case result inflation; the BFS bounds work by the catalog size
  (each skill enters once).
- A dep-only edit propagates through pull-sync only when the source touches a hashed field —
  an accepted trade for keeping the v1 ETag projection frozen.
- Rejected: **hashing `skills` into the ETag** (breaks every v1 cache — a v2 event — for a
  field that doesn't change retrieval); **a separate expansion verb** (a second skippable
  call re-creates the starvation problem ADR-0005 solved by bundling); **name-based refs**
  (ids are the stable key everywhere else — `tools`, `get_skill_content`); **a default depth
  > 0** (silently inflates every search result; context economy demands opt-in). This does
  not revisit ADR-0005's `relatedSkills` rejection — that was a surfacing side-channel on
  tool results; this is a data-model edge through the existing search/load paths.
