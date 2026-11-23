# `lib/synthesis` (L5)

Read models built on the layers below. Traces, Test a search and its experiment reads have landed.

| Path | Holds |
|---|---|
| `dashboard.ts` | the date-range presets and deltas the trace views share (the overview model rides along) |
| `tool-corpus.ts` | the core's `toolCorpus` service (the match-quality corpus loader), lent to the edition at startup |
| `traces/schema.ts` | `otel_trace_summaries` (with the filter columns `models`, `tools`, `service_name`, `environment` and their GIN indexes, migration `0038`; `agents` and `mcp_servers`, migration `0040`; `root_error`, the root span's own outcome, migration `0041`), `trace_summary_cursor` |
| `traces/summary-refresh.ts`, `register.ts` | the drain step that folds new spans into one summary row per trace (and `recomputeTraceSummaries`, which a writer that changes stored spans in place calls itself), between the retention-only prunes of expired spans and logs (before it) and of expired summaries (after it) |
| `traces/trace-filters.ts`, `summary-filters-backfill.ts` | the Sessions and Turns property filters (model, tool, service, environment, status, cost, tokens) matched on the trace rollup, with their facet values; on for every project (upstream retired `cloud-traces-filters`). The Agent and MCP server filters (RC-790) are on too (upstream's `cloud-project-entities` is not a flag here). The one-off `pnpm traces:backfill-filters [--before] [--dry-run]` fills the columns of summaries written before `0038` or `0040`; run `pnpm backfill:entity-dimensions --apply` first for spans stored before `0039` |
| `traces/span-dimensions.ts`, `agent-dimensions.ts`, `v2/agent-rollup.ts`, `v2/run-metrics.ts` | the Spans grouping by MCP server, command, skill and agent (AOBS-5), each agent's subtree totals in a run, and a run's metrics and events on its Timeline (AOBS-7); on for every project (upstream retired the AOBS flags in #557) |
| `model-pricing/reprice.ts` | restates stored costs after a price changes, and the summaries of the traces it touched; backs `pnpm backfill:costs [--reprice] [--dry-run]` (ported, run by hand; stored costs are not re-priced on deploy). Owned: an owner is its project's organization id |
| `traces/queries.ts`, `run-details.ts`, `events-queries.ts` | the trace, span, operation and log reads over `otel_spans`, `otel_logs` and the summaries |
| `traces/view.ts`, `events-view.ts` | search params to query options and cursors, rows to view models |
| `traces/waterfall.ts`, `tree.ts`, `format.ts` | one trace as a span tree and a waterfall; its message content is `ingest/otlp/content-view.ts` (it reads only ingest, and the outcome reading in `readings/` reads a span's reply through it) |
| `match-quality/` | a run over a project's searches: evidence, the judge, the analyst, replay, rewrites and their apply path; `judges.ts` resolves the OpenAI judge. Without a key a run stops before judging. |
| `quality/` | the ground truth and metrics, the snapshots and fingerprints; `register.ts` holds the `match_quality_run` job, the snapshot and sweep steps, and fills `foldSeams.loadShadow` |
| `playground/` | Test a search (upstream's Playground): rank a prompt with the SDK's engine against the live catalog, with what-if edits. `embed.ts` goes through the embedding-provider port (a refused or unreadable answer keeps its reason; a keyless run is told to the provider), `rank-route.ts` is the route's logic |
| `experiments/` | experiment detection and comparison over recorded rankings |
| `catalog/` | the tools table model, data provenance and the runtime-catalog reads, shared by Test a search and the Catalog pages |
| `tool-crafter/` | the `craft_tools` job: rule-drafted changes to a project's tools (merges, folds, retirements, tightened schemas…) with their backtest and round-trip price, read off the tool explorer, match quality and the topic patterns; `register.ts` fills `exploreSeams.enqueueCraft`. Owned: `schema.ts`, `job.ts`, `job.integration.test.ts`, `register.ts` |
| `traces/v2/` | the console Traces pages' models: filters, runs, run summary, timeline, volume |
| `traces/payload-content.ts` | a trace's message text from `events.payload` when its spans carry none, and each run's ask from the first derived prompt; always read (upstream retired its flag in #402) |
| `traces-sessions/` | the Traces Sessions tab (copies): `sessions` (one row per session, newest activity first, paged by a cursor, no timeframe), `summary`, `tab-aggregates` and `timeframe` (the summary inside each tab: its `?window=` and that tab's numbers and volume), `view` (All or Failed), `route` (the two API routes' shared guard) |

The experiment reads are in `traces/` (`experiment-*`, `calibration-view`); the Calibration pages and
their services stay upstream until they land. Copies and owned files are listed in `scripts/platform-sync/map.json`.
