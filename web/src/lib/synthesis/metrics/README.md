# `lib/synthesis/metrics`

One metric catalog and its one query function. Dashboards and alerts both call it.

| File | Holds |
|---|---|
| `catalog.ts` | the entries and the checks on a request; pure, safe for the browser, so the forms are built from it |
| `query.ts` | `queryMetric(projectId, request, db)`: any entry over a window, filtered and grouped |

## Catalog

| Metric | Source | Unit | Aggregations | Group by | Filter | Buckets |
|---|---|---|---|---|---|---|
| `trace_count` | `otel_trace_summaries` | count | count | model, service, environment, agent, tool | yes | hour, day |
| `error_rate` | `otel_trace_summaries` | ratio | rate | same | yes | hour, day |
| `latency` | `otel_trace_summaries` | ms | p50, p95 | same | yes | hour, day |
| `tokens` | `otel_trace_summaries` | tokens | sum, avg | same | yes | hour, day |
| `cost` | `otel_trace_summaries` | usd | sum, avg | same | yes | hour, day |
| `context_tokens` | `event_metrics` | tokens | sum | none | no | day |
| `context_cost` | `event_metrics` | usd | sum | none | no | day |

## Rules

- Buckets are UTC. A window of 3 days or less is read by the hour, else by the day.
- The error rate is the run's own outcome (`root_error`, else `has_error`), as on the Traces KPI band.
- A grouped result keeps the 10 groups with the highest total. A trace with two models counts once in
  each. A trace without the property is in no group.
- A filter on the grouped property keeps only the groups it names.
- `total` is read over the whole window. It is not the sum of the buckets.
- Nothing to read is 0 for a count or a sum, and null for a rate, an average or a percentile. `samples`
  says how many rows are behind a total.
- A request the entry does not allow throws `MetricRequestError`.

## Add an entry

1. Add the id to `METRIC_IDS` and the entry to `METRIC_CATALOG` in `catalog.ts`.
2. Add what it reads off one source row to `MEASURES` in `query.ts` (the compiler asks for it).
3. A new table is a new `MetricSource`: add its table and time column to `SOURCES`.
4. Add its expected series to `metrics.integration.test.ts`, and its row above.
