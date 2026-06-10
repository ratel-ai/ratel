# `docs/`

Project documentation that doesn't belong in a code folder.

## Layout

```
adr/          Architecture decision records
lessons.md    Accumulated rules from past mistakes
overview.md   The thesis — what Ratel is and why
releasing.md  How to cut a coordinated SDK release (core + TS + Python + CLI)
roadmap.md    Dated milestones
skills.md     Pointer to the Ratel skills suite (ratel-ai/skills)
```

## `skills.md`

One-page index of the [Ratel skills suite](https://github.com/ratel-ai/skills) — five Claude Code / Cursor / Codex skills for partner-engagement work on agent codebases. Install with `npx skills add ratel-ai/skills`. The full suite docs live in the [ratel-ai/skills](https://github.com/ratel-ai/skills) repo; this file is the in-repo entry point.

## `adr/` — Architecture decision records

The durable record of cross-cutting choices. Nygard format (`Status` / `Context` / `Decision` / `Consequences`), numbered sequentially (`NNNN-kebab-title.md`).

ADRs are **immutable once `Accepted`**. To change a decision, write a new ADR that supersedes the old one and update the old ADR's status to `Superseded`.

[ADR 0001](adr/0001-record-architecture-decisions.md) is the meta-ADR that locks the format itself. The `.adr-dir` file at the repo root points [adr-tools](https://github.com/npryce/adr-tools) here.

## `lessons.md`

The team's running log of "Claude got this wrong, here's the rule that prevents it." Append-only; every mistake becomes a rule the next session carries. See the file's own header for the entry format.
