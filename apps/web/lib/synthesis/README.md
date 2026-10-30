# `lib/synthesis` (L5)

Read models built on the layers below. The traces module and one Playground helper have landed.

| Path | Holds |
|---|---|
| `dashboard.ts` | the date-range presets and deltas the trace views share (the overview model rides along) |
| `traces/schema.ts` | `otel_trace_summaries`, `trace_summary_cursor` |
| `traces/summary-refresh.ts`, `register.ts` | the drain step that folds new spans into one summary row per trace |
| `traces/queries.ts`, `run-details.ts`, `events-queries.ts` | the trace, span, operation and log reads over `otel_spans`, `otel_logs` and the summaries |
| `traces/view.ts`, `events-view.ts` | search params to query options and cursors, rows to view models |
| `traces/waterfall.ts`, `tree.ts`, `content-view.ts`, `format.ts` | one trace as a span tree, a waterfall and its message content |
| `playground/descriptions.ts` | which description a search ranks on, for the Catalog detail |
| `traces/v2/` | the console Traces pages' models: filters, runs, run summary, timeline, volume |

The experiment and calibration reads stay upstream until the experiments module lands. Copies
and owned files are listed in `scripts/platform-sync/map.json`.
