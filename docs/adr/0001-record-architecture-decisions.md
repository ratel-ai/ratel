# 1. Record architecture decisions

Date: 2026-07-05

## Status

Accepted

Compacted 2026-07 from pre-compaction ADR-0001 (2026-04-30), rewritten with the current
governance rule. The 2026-07 re-founding compacted 21 records into 9; new decisions are
numbered sequentially thereafter. The full pre-compaction set lives in git history.

## Context

Cross-cutting choices (workspace layout, binding strategy, retrieval pipeline, product
boundaries, auth model) need a durable record so future contributors find the *why* without
spelunking through PR descriptions or chat history.

The original rule made Accepted ADRs immutable: never edit, always supersede. Two years of
that discipline produced a corpus where a reader (human or agent, since agents load the set as
context) had to wade through superseded schemas, a deferred server product, and stale package
counts to find the decisions that still hold. The archive value turned out to live in git
history anyway; keeping it inline just taxed every read.

## Decision

Use Architecture Decision Records as [described by Michael Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
Records live in `docs/adr/`, numbered sequentially (`NNNN-kebab-title.md`), with the structure
`Status`, `Context`, `Decision`, `Consequences` (plus `Rejected` where the alternatives carry
signal). The `.adr-dir` file at the repo root points tooling at this directory. Status values:
`Proposed`, `Accepted`, `Superseded`.

**The set is kept minimal and current.** Governance is a hybrid:

- **Amend in place** for small drift: paths, package names, unit counts, status lines, and
  wording that reality has outrun. An amendment must not change what was decided.
- **Supersede** for genuine decision reversals: write a new ADR, mark the old one
  `Superseded`, link both ways.
- **Compact periodically**: when stale content accumulates, merge overlapping records, drop
  dead ones, and renumber. Git history is the archive. Each compacted record carries a
  provenance note naming the pre-compaction ADRs it absorbs.

## Consequences

- A reader can trust that every ADR in the set describes the system as it is; history is one
  `git log docs/adr/` away.
- Pre-compaction numbers (0001-0021, 2026-04 through 2026-07) refer to the set as it existed
  before the 2026-07 re-founding; provenance notes map old numbers to their absorbing record.
- Decision archaeology (why did we switch?) moved from inline supersession chains to git
  history and PR descriptions. That trade is deliberate: the inline set optimizes for the
  current reader, not the historian.
