# `lib/ingest` (L2)

What the SDKs send: OTLP traces and logs, runtime events, catalog snapshots.

| Path | Holds |
|---|---|
| `cloud-schema.ts` | `CloudEvent`: the shape one LLM call reduces to, rebuilt from OTLP spans and stored in `events.payload` |
| `context.ts`, `categorize.ts` | the five context sources, and the attribution of a call's input tokens across them |
| `gateway-tools.ts` | the gateway's meta-tool ids, so an `invoke_tool` call counts against the real tool |
| `pricing.ts` | the model token price table and `costFor` |
| `otlp/` | OTLP decode, the event/span/log writes, and the `/v1/traces` and `/v1/logs` handlers; a model call counts only the tool calls it produced (upstream's `cloud-otlp-produced-tool-calls`, retired upstream too: there is no switch). the trace shapes the tool-count tests ingest are in `ledger/turns/tool-count-fixtures.ts` |
| `otlp/schema.ts` | `events`, `event_metrics`, `otel_spans`, `otel_logs`, `tool_count_backfill_backups` (upstream's tool-count backfill keeps its rollback rows there; the script is not part of this edition, the table is, migration `0032`) (the two OTel tables and `otel_trace_summaries` carry autovacuum storage options set by migration `0031_otel_autovacuum`, which the schema cannot express; `otlp/queries.integration.test.ts` checks them) |
| `trace-events/schema.ts` | `trace_events`, `trace_event_hits`, `trace_event_rejects`, `tool_usage_counters`, `intent_graph_runtime_status` |
| `trace-events/parse.ts`, `route-handler.ts` | `POST /api/v1/events`: validate a batch, store it, report rejects |
| `trace-events/consolidate.ts`, `queries.ts` | the write path: events, hits, sources, tool counters and runtime ranking status in one transaction; `queries.ts` also holds the reads the MCP joins take: the top search queries, the skills searched but never invoked, the erroring tools and the queries that surfaced a skill |
| `trace-events/event-types.ts`, `fold-schedule.ts`, `turns-schedule.ts` | which stored events start an intent-graph fold or a turn build, and the enqueues the routes inject (the turn build is wired; the fold and the engine run join with their modules) |
| `trace-events/maintenance.ts`, `register.ts` | the bounded retention prunes of runtime events and rejects, registered as retention-only drain steps |
| `otlp/queries.ts` `findTracesWithModelCalls` | the storage half of the agent-span dedupe the traces route wires |
| `otlp/session-chat-capture.ts` | `sessionChatCaptureEnabled`: whether a model call's payload keeps its own reply and request settings for the session chat. Owned: the deployment switch `FF_SESSION_REPLAY`, read from the platform layer (upstream asks its flag service per organization). The traces route and the imported-runs service wire it |
| `otlp/semconv/` | the `gen_ai` semantic-convention aliases (deprecated keys, OpenInference, logfire, AI SDK 4, OpenLLMetry, provider names), legacy and Mastra content, and the `gen_ai` log events: kept in `otel_logs` and joined to their model call in whichever order logs and spans arrive (`gen-ai-log-join`, `gen-ai-log-store`). Upstream's `cloud-otlp-semconv-aliases` is retired upstream in #402; `enabled.ts` (owned) is that end state, always on. `gen-ai-log-join.ts` and its integration test are owned only for the organization type and a vendor stand-in |
| `otlp/queries.ts` `getPromptCacheTotals` | the window's cached and input tokens from `events`, for Home's prompt cache hit rate |
| `otlp-raw/` | raw OTLP request bodies: each accepted `/v1/traces` and `/v1/logs` body kept gzipped in `otlp_raw_exports` (`schema.ts`, owned; migration `0034`) within `OTLP_RAW_DAILY_BYTES` per project per day, pruned past `OTLP_RAW_RETENTION_DAYS` whatever retention says (the drain step `otlp_raw_prune` in `synthesis/traces/register.ts`), and the `otlp-raw:keys` inventory. Behind the deployment switch `FF_OTLP_RAW_CAPTURE` (`flag.ts`, owned); `capture.ts` is owned for the organization type |
| `otlp/queries.ts` `hasProjectIngestedEvents`, `getDailyAggregates`, `getToolMetrics` | event presence and the derived `event_metrics` reads (per-day sums, per-tool footprints) the project overview and the MCP cost tools quote |
| `runtime-events/schema.ts` | `runtime_event_sources` |
| `runtime-events/queries.ts`, `view.ts` | the reads behind Settings > Developer: events, rejects, client drops, facets |
| `catalogs/` | catalog snapshot ingest (`PUT /api/v1/catalog/snapshot`), vocabulary, observed/synced tool queries |
| `catalogs/schema.ts` | `catalog_snapshots`, `catalog_tool_definitions` |
| `runtime-catalog/` | upsert from events/snapshots, override pull (`GET /v1/runtime-catalog/overrides`) and edit, adoption; the edit route is `PATCH /api/runtime-catalog/:kind/:entryId` |
| `runtime-catalog/schema.ts` | `runtime_catalog_entries` |
| `runtime-catalog/queries.ts` | the upserts from both channels, and `getRuntimeToolCatalogEntries`, the tool list the readings take their vocabulary from (definitions plus names seen only in trace metrics, gateway tools left out) |
| `runtime-catalog/inventory.ts` | the catalog as retrieval sees it: `loadCatalogInventory` (the corpus fingerprint a signal run is stored against) and `loadToolCorpus` (the tools a judge chooses between); owned, the read half of upstream's quality fingerprint |

Copies and owned files are listed in `scripts/platform-sync/map.json`.
