# `docs/`

Project documentation that doesn't belong in a code folder.

## Layout

```
adr/                              Architecture decision records
assets/                           Images and other static assets
schemas/                          JSON Schemas of the platform's documents
geography.md                      Where traces come from: the map widget and its data
baseline-capture-distributed.md   Collecting seeding evidence from a multi-instance host
```

## Guides

[Geography](geography.md) — the map widget: the attributes a location is read from, how to resolve IP addresses with DB-IP Lite, what is stored, and the licences of the data.

[Baseline capture in a distributed host](baseline-capture-distributed.md) — how to collect the evidence for [adaptive usage ranking](https://github.com/ratel-ai/ratel/blob/97282f939824622e652322b31e10a865fa6c6764/docs/adr/0014-adaptive-usage-ranking.md) (an SDK decision; the record is in this repository's history) when the search and the invocation that follows land in different processes. The single-process path is [`examples/configurable-adaptive-ranking-ts`](https://github.com/ratel-ai/ratel-sdk/blob/main/examples/configurable-adaptive-ranking-ts/README.md) in the [ratel-sdk](https://github.com/ratel-ai/ratel-sdk) repository.

## `schemas/` — JSON Schemas

Generated from the zod schemas in `web/src/lib` with `pnpm --filter @ratel/platform schemas:generate`; a test fails when they differ. [`query.schema.json`](schemas/query.schema.json) is the query object of dashboards. [`dashboard.schema.json`](schemas/dashboard.schema.json) is a dashboard as Export writes it and Import reads it; a scorer is given by its name. A step flow (`kind: "step_flow"`) counts what traces do at each step. The schema states each measure's aggregations. The server also checks which dimensions, filters and buckets a measure allows.

## `adr/` — Architecture decision records

The record of cross-cutting choices, kept **minimal and current**. Nygard format (`Status` / `Context` / `Decision` / `Consequences`), numbered sequentially (`NNNN-kebab-title.md`).

Each ADR states the current decision: amend it in place for small drift, rewrite or delete it when the decision changes — git history is the archive. [`adr/README.md`](adr/README.md) lists them.

[ADR 0001](adr/0001-record-architecture-decisions.md) carries the full convention. The `.adr-dir` file at the repo root points [adr-tools](https://github.com/npryce/adr-tools) here.
