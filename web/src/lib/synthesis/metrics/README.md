# `lib/synthesis/metrics`

One metric catalog and the one function that runs a query object (`lib/contracts/query.ts`).
Dashboards and alerts both call it. Kind `sql` (RQL text) runs here too, through a seam that
`synthesis/rql` fills.

| File | Holds |
|---|---|
| `catalog.ts` | the entries: what the contract allows of each measure, how it reads and where it comes from; pure, safe for the browser, so the forms are built from it |
| `query.ts` | `runQuery(projectId, query, scope, db)`: a query object of any kind over a window, narrowed by the filter of what it is part of (a dashboard); and the metric kind |
| `steps.ts` | `loadTraceSteps`: the newest matching traces with the tools, skills, agents, MCP servers and models they went through, in order, from `otel_spans` (a skill also from its `skill_invoke` event). At most 2,000 traces per run and 200 steps per trace; the result says how many matched |
| `flow.ts` | the flow kind: the moves between tools, skills or agents, counted in traces by step |
| `step-flow.ts` | the step flow kind: per step, forward from the start or back from the first visit of one node. The start is each trace's first agent, or the intent its first placed turn is in (`trace_turn_topics`); a trace without one is "No agent" or "No intent". Marks a node that fails (3 visits and 20%) or is slow (the p95 over 10 s and 5 times the median step) |
| `step-flow-columns.ts` | the step paths folded into columns, links, a bucket per column, Ended and Later; pure, safe for the browser, so a widget unfolds with the query's own arithmetic |
| `funnel.ts` | the funnel kind, pure: how many steps a trace passed. `views/scorers/funnel` reads the traces and fills `metricSeams.funnel`, because it needs the check engine and the scorer results |
| `clusters.ts` | the shape of the clusters kind's answer; `views/dashboards/clusters` fills `metricSeams.clusters` |
| `query.ts` (kind `sql`) | `SqlResult`: the columns with their RQL types, the rows as arrays, `truncated`. `synthesis/rql/query` fills `metricSeams.sql` on import and checks the RQL version |
| `geography.ts` | the geography kind: a measure by country, or by region of one country, from the codes on `otel_trace_summaries` |
| `trace-fixture.ts` | test data: spans as ingest stores them, with their summaries |

## Catalog

| Metric | Source | Unit | Aggregations | Dimensions | Filter | Buckets |
|---|---|---|---|---|---|---|
| `trace_count` | `otel_trace_summaries` | count | count | model, service, environment, agent, tool | yes | hour, day |
| `error_rate` | `otel_trace_summaries` | ratio | rate | same | yes | hour, day |
| `latency` | `otel_trace_summaries` | ms | p50, p95 | same | yes | hour, day |
| `tokens` | `otel_trace_summaries` | tokens | sum, avg | same | yes | hour, day |
| `cost` | `otel_trace_summaries` | usd | sum, avg | same | yes | hour, day |
| `context_tokens` | `event_metrics` | tokens | sum | none | no | day |
| `context_cost` | `event_metrics` | usd | sum | none | no | day |
| `scorer_pass_rate` | `trace_scores` | ratio | rate | scorer, model, service, environment | yes, and by scorer | hour, day |
| `scorer_average` | `trace_scores` | score | avg | same | same | hour, day |
| `scorer_count` | `trace_scores` | count | count | same | same | hour, day |

## Rules

- Buckets are UTC. A window of 3 days or less is read by the hour, else by the day.
- The error rate is the run's own outcome (`root_error`, else `has_error`), as on the Traces KPI band.
- A query groups by two dimensions at most. Each series has one `groups` value per dimension.
- A grouped result keeps the 10 groups with the highest total. A trace with two models counts once in
  each. A trace without the property is in no group.
- The filter of the scope is one more clause of the query's own (`withClause`): every clause must match. A measure that cannot be filtered
  ignores the first.
- A filter on the grouped property keeps only the groups it names.
- `total` is read over the whole window. It is not the sum of the buckets.
- Nothing to read is 0 for a count or a sum, and null for a rate, an average or a percentile. `samples`
  says how many rows are behind a total.
- The scorer entries carry `feature: "customMonitoring"`. `offeredMetrics` leaves them out with the switch
  off, and a caller checks `metricOffered` before it runs or stores a query.
- The pass rate reads the pass or fail results, the average reads the 1 to 5 results. The time of a
  result is its trace's start.
- `trace_scores` belongs to a higher layer. `views/scorers/metrics` fills `metricSeams.scores`; a
  caller that can read a scorer entry imports that module.
- A query the contract does not allow throws `QueryError`. A refusal of RQL (kind `sql`) carries
  `detail: { code, fix }` and the message as RQL wrote them: a compile error, a run error,
  `rql_version` (a version newer than the server's) and `rql_filter` (a filter of the
  scope: the text says what it keeps).
- Kind `sql` reads the window of the scope as the window of the query: a time condition in the text
  narrows it. It reads through the RQL pool, never the `db` argument, and ignores `scope.by`.

## Add an entry

1. Add the measure to `MEASURES` in `contracts/query.ts`, and its unit, source and description to
   `READS` in `catalog.ts`. Run `pnpm --filter @ratel/platform schemas:generate`.
2. Add what it reads off one source row to its source's `measures` in `query.ts`.
3. A new table is a new `MetricSource`: add it to `SOURCES`, or to `metricSeams` when a higher
   layer owns the table.
4. Add its expected series to `metrics.integration.test.ts`, and its row above.
