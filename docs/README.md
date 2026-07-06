# `docs/`

Project documentation that doesn't belong in a code folder.

## Layout

```
adr/       Architecture decision records
assets/    Images and other static assets
```

## `adr/` — Architecture decision records

The record of cross-cutting choices, kept **minimal and current**. Nygard format (`Status` / `Context` / `Decision` / `Consequences`), numbered sequentially (`NNNN-kebab-title.md`).

Amend in place for small drift; write a superseding ADR for real decision reversals; compact periodically — git history is the archive (the set was re-founded 2026-07, compacting 21 records into 9, and grows by normal addition since; provenance notes in each record map the old numbers).

[ADR 0001](adr/0001-record-architecture-decisions.md) is the meta-ADR that carries the full convention. The `.adr-dir` file at the repo root points [adr-tools](https://github.com/npryce/adr-tools) here.
