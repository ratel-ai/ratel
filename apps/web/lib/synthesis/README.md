# `lib/synthesis` (L5)

Read models built on the layers below. Traces, Test a search and its experiment reads have landed.

| Path | Holds |
|---|---|
| `dashboard.ts` | the date-range presets and deltas the trace views share (the overview model rides along) |
| `traces/schema.ts` | `otel_trace_summaries`, `trace_summary_cursor` |
| `traces/summary-refresh.ts`, `register.ts` | the drain step that folds new spans into one summary row per trace |
| `traces/queries.ts`, `run-details.ts`, `events-queries.ts` | the trace, span, operation and log reads over `otel_spans`, `otel_logs` and the summaries |
| `traces/view.ts`, `events-view.ts` | search params to query options and cursors, rows to view models |
| `traces/waterfall.ts`, `tree.ts`, `content-view.ts`, `format.ts` | one trace as a span tree, a waterfall and its message content |
| `match-quality/` | a run over a project's searches: evidence, the judge, the analyst, replay, rewrites and their apply path; `judges.ts` resolves the OpenAI judge. Without a key a run stops before judging |
| `quality/` | the ground truth and metrics, the snapshots and fingerprints; `register.ts` holds the `match_quality_run` job, the snapshot and sweep steps, and fills `foldSeams.loadShadow` |
| `playground/` | Test a search (upstream's Playground): rank a prompt with the SDK's engine against the live catalog, with what-if edits. `embed.ts` goes through the embedding-provider port, `rank-route.ts` is the route's logic |
| `experiments/` | experiment detection and comparison over recorded rankings |
| `catalog/` | the tools table model, data provenance and the runtime-catalog reads, shared by Test a search and the Catalog pages |
| `traces/v2/` | the console Traces pages' models: filters, runs, run summary, timeline, volume |

The experiment reads are in `traces/` (`experiment-*`, `calibration-view`); the Calibration pages and
their services stay upstream until they land. Copies and owned files are listed in `scripts/platform-sync/map.json`.
