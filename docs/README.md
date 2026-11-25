# `docs/`

Project documentation that doesn't belong in a code folder.

## Layout

```
adr/                              Architecture decision records
assets/                           Images and other static assets
baseline-capture-distributed.md   Collecting seeding evidence from a multi-instance host
internal-api.md                   The service-to-service routes, off by default
```

## Guides

[Baseline capture in a distributed host](baseline-capture-distributed.md) — how to collect the evidence for [adaptive usage ranking](https://github.com/ratel-ai/ratel/blob/97282f939824622e652322b31e10a865fa6c6764/docs/adr/0014-adaptive-usage-ranking.md) (an SDK decision; the record is in this repository's history) when the search and the invocation that follows land in different processes. The single-process path is [`examples/configurable-adaptive-ranking-ts`](https://github.com/ratel-ai/ratel-sdk/blob/main/examples/configurable-adaptive-ranking-ts/README.md) in the [ratel-sdk](https://github.com/ratel-ai/ratel-sdk) repository.

## `adr/` — Architecture decision records

The record of cross-cutting choices, kept **minimal and current**. Nygard format (`Status` / `Context` / `Decision` / `Consequences`), numbered sequentially (`NNNN-kebab-title.md`).

Each ADR states the current decision: amend it in place for small drift, rewrite or delete it when the decision changes — git history is the archive. [`adr/README.md`](adr/README.md) lists them.

[ADR 0001](adr/0001-record-architecture-decisions.md) carries the full convention. The `.adr-dir` file at the repo root points [adr-tools](https://github.com/npryce/adr-tools) here.
