# `docs/`

Project documentation that doesn't belong in a code folder.

## Layout

```
adr/    Architecture decision records
```

## `adr/` — Architecture decision records

The durable record of cross-cutting choices. Nygard format (`Status` / `Context` / `Decision` / `Consequences`), numbered sequentially (`NNNN-kebab-title.md`).

ADRs are **immutable once `Accepted`**. To change a decision, write a new ADR that supersedes the old one and update the old ADR's status to `Superseded`.

[ADR 0001](adr/0001-record-architecture-decisions.md) is the meta-ADR that locks the format itself. The `.adr-dir` file at the repo root points [adr-tools](https://github.com/npryce/adr-tools) here.
