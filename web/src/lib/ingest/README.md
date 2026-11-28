# `lib/ingest` (L2)

What the SDKs send: OTLP traces and logs, runtime events, catalog snapshots.

The three telemetry routes store in the request, or queue a batch for a worker
([ADR-0009](../../../../docs/adr/0009-queued-ingest.md)). With `INGEST_QUEUE=kafka` the worker also stores
what a gateway put on Kafka ([ADR-0010](../../../../docs/adr/0010-kafka-ingest.md)). All three paths call
the same store functions:

```
request ── decode ─────────────────────────────┐
request ── ingest_batches ── ingest lane ──────┼── storeTraceExport, storeLogExport, storeRuntimeEvents
gateway ── Kafka ── consumer ── process ───────┘
```

Events without metrics can exist only from before the two inserts were one transaction. To count
them (sending the export again repairs them):

```sql
select e.project_id, count(*) from events e
left join event_metrics m on m.event_id = e.id
where m.id is null group by 1;
```

A process function answers `ack`, `retry`, `outage` or `dead-letter`. Every write gives the same
rows the second time, and the consumer passes `redelivers`, so a write that a request only logs
fails the delivery and is tried again.

| Path | Holds |
|---|---|
| `cloud-schema.ts` | `CloudEvent`: the shape one LLM call reduces to, rebuilt from OTLP spans and stored in `events.payload` |
| `context.ts`, `categorize.ts` | the five context sources, and the attribution of a call's input tokens across them |
| `geo/` | where a trace comes from: `locate.ts` marks each arriving span that carries a location with country and region codes (`ratel.geo.country`, `ratel.geo.region`), from codes, coordinates (`boundaries.ts`) or an IP address (`address.ts`, DB-IP Lite); the trace summary takes the codes. A lookup is synchronous, so a batch gives the process back every 10 ms; codes need no lookup. No address and no coordinate is stored or logged, and a raw body that carries an address is not kept. With the ingest queue on, `redact.ts` takes the address and the coordinates out of an export and marks its spans before the batch is queued; the worker then does not locate it again (`IngestBatchContext.geo`). An export that cannot be redacted is stored at once and is not queued. `attributes.ts`, `store.ts` and `schema.ts` are the attribute names per project (`project_geo_attributes`, migration `0050`). Guide: `docs/geography.md` |
| `properties/` | trace properties (RTL-395, ADR-0012): the key names each project's traces carry (`trace_property_keys`, at most 200 of the project's own), the standard properties indexed at first sight on every plan, and the values of the indexed ones on `otel_spans.properties` (never a value of a key nobody indexed). Its own README says what is stored and how to stop and erase it |
| `gateway-tools.ts` | the gateway's meta-tool ids, so an `invoke_tool` call counts against the real tool |
| `pricing.ts` | the model token price table (`MODEL_PRICES`, with long-context tiers and a date-suffix-only lookup), a project's own prices (`PriceBook`, `resolvePrice`), `costFor`, and `RATEL_BUDGET_PRICES` / `ratelBudgetCostFor`, the frozen rates Ratel's own spend caps keep. Owned: upstream's file also prices the vendor models Ratel itself calls, which live with their clients in the private edition |
| `model-pricing/` | per-project model prices (RC-482): `schema.ts` (owned; `project_model_prices`, migration `0036`), `store`, `price-book` (a project's book, read once per batch), `settings` and `format`; re-pricing is `synthesis/model-pricing/reprice.ts`, because it restates trace summaries too. Ingest prices each call once, with the project's prices of that moment; a call with no price stays Unpriced |
| `ingest-limits.ts` | the shared-key limits for ingest-only keys (ratel-cloud #428): requests a minute per key and per caller address, and the spans or log records each request carries, with the key's own `rate_limit_per_minute` when it has one; a 429 with `Retry-After` past them |
| `queue/envelope.ts`, `queue/__fixtures__/` | the Kafka ingest message (ADR-0010): the `Envelope` type, its one binary encoding, and the sample files that every implementation reads and writes byte for byte |
| `queue/process.ts` | process (ADR-0010): the consumer's handler, which reads the project and calls the process function of the signal (`otlp/process-traces.ts`, `otlp/process-logs.ts`, `trace-events/process-events.ts`), which store through the functions of ADR-0009's queue and of the routes (`traces-export.ts`, `logs-export.ts`, `storeRuntimeEvents`). `ingest-queue.ts` opens the queue that `INGEST_QUEUE` names. `port/store-failure.ts` tells an outage from a failure of one message |
| `queue/port/` | the core's queue, which is the port of `contracts/ingest-queue.ts` over an `Envelope`: what a driver does with a failed delivery (`settle.ts`), and in `test-support/` the conformance suite that every driver passes (`runQueueConformance`) with an in-memory driver for tests |
| `queue/consumer.ts` | the consumer of one process: a log line for each retry (`ingest_message_retried`), outage (`ingest_store_unavailable`) and dead letter (`ingest_message_dead_lettered`), the counts once a minute (`ingest_queue_processed`), and the stop on a signal. `src/ingest-consumer.ts` wires the process functions to their real dependencies, as a route does, and `instrumentation.node.ts` starts it |
| `queue/test-support.ts` | a direct deployment and one that stores envelopes, over PGlite, the sample bodies, and the dump of every table that the queued tests compare |
| `queue/kafka/` | the driver of `INGEST_QUEUE=kafka`, loaded only then: `open.ts` reads the settings, `client.ts` connects (plaintext, TLS or Amazon MSK's IAM login), `kafka-queue.ts` consumes (and, for tools and tests, publishes with the project id as the key) an explicit topic list that it reads again while it runs. With `{topic}` in the group and dead-letter names, `per-topic.ts` reads each topic in its own group. An offset is committed after its handler succeeded, a message that keeps failing goes to the dead-letter topic, and a wait holds the whole partition. The integration test needs `TEST_KAFKA_BROKERS` (the CI job `kafka-ingest`) |
| `otlp/` | OTLP decode, the event/span/log writes, and the `/v1/traces` and `/v1/logs` handlers (each checks its key's scope through `platform/api-keys/authenticate.ts`, and an ingest-only key's shared limits); a model call counts only the tool calls it produced (upstream's `cloud-otlp-produced-tool-calls`, retired upstream too: there is no switch). the trace shapes the tool-count tests ingest are in `ledger/turns/tool-count-fixtures.ts` |
| `otlp/schema.ts` | `events`, `event_metrics`, `otel_spans`, `otel_logs`, `tool_count_backfill_backups` (upstream's tool-count backfill keeps its rollback rows there; the script is not part of this edition, the table is, migration `0032`) (the two OTel tables and `otel_trace_summaries` carry autovacuum storage options set by migration `0031_otel_autovacuum`, which the schema cannot express; `otlp/queries.integration.test.ts` checks them) |
| `trace-events/schema.ts` | `trace_events`, `trace_event_hits`, `trace_event_rejects`, `tool_usage_counters`, `intent_graph_runtime_status` |
| `trace-events/parse.ts`, `route-handler.ts` | `POST /api/v1/events`: validate a batch, store it, report rejects (`storeRuntimeEvents`, shared with the queue's worker) |
| `trace-events/consolidate.ts`, `queries.ts` | the write path: events, hits, sources, tool counters and runtime ranking status in one transaction (an append-only key only adds rows: no replace, no facts era, no ranking status); `queries.ts` also holds the reads the MCP joins take: the top search queries, the skills searched but never invoked, the erroring tools and the queries that surfaced a skill |
| `trace-events/event-types.ts`, `fold-schedule.ts`, `turns-schedule.ts` | which stored events start an intent-graph fold or a turn build, and the enqueues the routes inject (the turn build is wired; the fold and the engine run join with their modules) |
| `trace-events/maintenance.ts`, `register.ts` | the bounded retention prunes of runtime events and rejects, registered as retention-only drain steps |
| `otlp/queries.ts` `findTracesWithModelCalls` | the storage half of the agent-span dedupe the traces route wires |
| `otlp/dimensions/` | the entity dimensions of each span (RC-772), derived once per export at ingest: `agent_key`, `caller_agent_key`, `mcp_server` and `mcp_role` on `otel_spans` (migration `0039`), with `agent_source` / `mcp_server_source` (`sdk`, `semconv` or `heuristic`) and `mcp_session_id`. A derivation that throws stores the batch with null dimensions. `pnpm backfill:entity-dimensions [--apply] [--project] [--before]` fills spans stored before `0039` (a dry run without `--apply`; it does not fill `mcp_session_id`) |
| `otlp/span-rows.ts` (session and end user) | `otel_spans.session_id` and `end_user_id` (RTL-321, migration `0056`, index `(project_id, session_id, started_at)`): the values the export's `trace_events` rows get (`SESSION_KEYS`, then `MCP_SESSION_KEYS`, and `USER_KEYS` in `otlp/attr-resolve.ts`, read up the span's ancestors and resource, cut to 256 characters). Null when the export has none, never the trace id stand-in of `trace_events`. The end user is the raw value, as on `trace_events`. `pnpm backfill:session-user-ids [--apply] [--project] [--batch-size]` fills spans and summaries stored before `0054` from `trace_events` by trace id (a dry run without `--apply`; a second run writes nothing) |
| `otlp/span-rows.ts` (trace properties) | `otel_spans.properties` (RTL-395, migration `0063`): the values `properties/ingest.ts` resolved for the span; the `attributes` rule is unchanged, so a key of the customer's own is never in `attributes`. An import rewrite without values keeps the stored ones |
| `otlp/span-events.ts` | a span's events and links (AOBS-7), content-free and bounded, in `otel_spans.events` and `links` (migration `0042`); an import rewrite without them keeps the stored ones |
| `otlp/emitter-cost.ts` | the emitter's own cost (`ratel.usage.cost_usd`, then `gen_ai.usage.cost`) for a call the price book has no price for (AOBS-3); re-pricing reads the same keys |
| `catalogs/telemetry-declared-tools.ts` | the tools an agent declared in its spans (AOBS-7), for `list_declared_tools` |
| `otlp/span-rows.ts` | a span's stored row; a top-level `invoke_agent` span keeps its run's ask (`gen_ai.input.messages`) on the row, where every other span's content stays in `events.payload` (ratel-cloud #483) |
| `otlp/semconv/` | the `gen_ai` semantic-convention aliases (deprecated keys, OpenInference, logfire, AI SDK 4, OpenLLMetry, provider names), legacy and Mastra content, and the `gen_ai` log events: kept in `otel_logs` and joined to their model call in whichever order logs and spans arrive (`gen-ai-log-join`, `gen-ai-log-store`). The aliases and the log join run for every project (upstream retired its flag in #402). `gen-ai-log-join.ts` and its integration test are owned only for the organization type and a vendor stand-in |
| `otlp/queries.ts` `getPromptCacheTotals` | the window's cached and input tokens from `events`, for Home's prompt cache hit rate |
| `queue/` | the experimental ingest queue (ADR-0009, `EXPERIMENTAL_INGEST_QUEUE=1`): `ingest_batches` (`schema.ts`, owned; migration `0046`), the request half (`accept.ts`: store the body as sent and kick a drain), the fair claim and housekeeping (`queries.ts`: per-project running cap `INGEST_PERSIST_PER_PROJECT`, round robin across projects (the one a drainer served longest ago first), retry with backoff up to `INGEST_BATCH_MAX_ATTEMPTS`, reaper, retention, per-project depth), the worker half (`persist.ts`, through the same `traces-export.ts`, `logs-export.ts` and `storeRuntimeEvents` the inline routes call), the drain loop and the process gate (`drain.ts`), and the wiring (`register.ts`: the routes' deps, the worker's lane, the tick's reap, depth, safety-net drain and prune steps) |
| `otlp/traces-export.ts`, `otlp/logs-export.ts` | the decode and store halves of a trace or log export after the request's checks, shared by the inline routes, the queue's worker and the Kafka consumer, which adds `receivedAt`, `redelivers` and the capture's id |
| `otlp-raw/` | raw OTLP request bodies: each accepted `/v1/traces` and `/v1/logs` body kept gzipped in `otlp_raw_exports` (`schema.ts`, owned; migration `0034`) within `OTLP_RAW_DAILY_BYTES` per project per day, pruned past `OTLP_RAW_RETENTION_DAYS` whatever retention says (the drain step `otlp_raw_prune` in `synthesis/traces/register.ts`), and the `otlp-raw:keys` inventory. On for every project (upstream retired its flag in #417); `capture.ts` is owned for the organization type. `reprocess` and `pnpm otlp-raw:reprocess` re-run today's mapping over stored bodies, a dry run by default |
| `otlp/queries.ts` `hasProjectIngestedEvents`, `getDailyAggregates`, `getToolMetrics` | event presence and the derived `event_metrics` reads (per-day sums, per-tool footprints) the project overview and the MCP cost tools quote |
| `runtime-events/schema.ts` | `runtime_event_sources` |
| `runtime-events/queries.ts`, `view.ts` | the reads behind Settings > Developer: events, rejects, client drops, facets |
| `catalogs/` | catalog snapshot ingest (`PUT /api/v1/catalog/snapshot`), vocabulary, observed/synced tool queries |
| `catalogs/schema.ts` | `catalog_snapshots`, `catalog_tool_definitions` |
| `runtime-catalog/` | upsert from events/snapshots, override pull (`GET /v1/runtime-catalog/overrides`) and edit, adoption; the edit route is `PATCH /api/runtime-catalog/:kind/:entryId` |
| `runtime-catalog/schema.ts` | `runtime_catalog_entries` |
| `runtime-catalog/queries.ts` | the upserts from both channels, and `getRuntimeToolCatalogEntries`, the tool list the readings take their vocabulary from (definitions plus names seen only in trace metrics, gateway tools left out) |
| `runtime-catalog/inventory.ts` | the catalog as retrieval sees it: `loadCatalogInventory` (the corpus fingerprint a signal run is stored against) and `loadToolCorpus` (the tools a judge chooses between); owned, the read half of upstream's quality fingerprint |
