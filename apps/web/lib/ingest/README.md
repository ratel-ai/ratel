# `lib/ingest` (L2)

What the SDKs send: OTLP traces and logs, runtime events, catalog snapshots. Arriving slice by
slice from `ratel-cloud`: the leaf helpers, the table fragments and the runtime-events lane are
here; OTLP and the catalogs follow.

| Path | Holds |
|---|---|
| `cloud-schema.ts` | `CloudEvent`: the shape one LLM call reduces to, rebuilt from OTLP spans and stored in `events.payload` |
| `context.ts`, `categorize.ts` | the five context sources, and the attribution of a call's input tokens across them |
| `gateway-tools.ts` | the gateway's meta-tool ids, so an `invoke_tool` call counts against the real tool |
| `pricing.ts` | the model token price table and `costFor` |
| `otlp/schema.ts` | `events`, `event_metrics`, `otel_spans`, `otel_logs` |
| `trace-events/schema.ts` | `trace_events`, `trace_event_hits`, `trace_event_rejects`, `tool_usage_counters`, `intent_graph_runtime_status` |
| `trace-events/parse.ts`, `route-handler.ts` | `POST /api/v1/events`: validate a batch, store it, report rejects |
| `trace-events/consolidate.ts`, `queries.ts` | the write path: events, hits, sources, tool counters and runtime ranking status in one transaction |
| `trace-events/event-types.ts`, `fold-schedule.ts`, `turns-schedule.ts` | which stored events start an intent-graph fold or a turn build, and the paced enqueues the route injects once those modules land |
| `runtime-events/schema.ts` | `runtime_event_sources` |
| `catalogs/schema.ts` | `catalog_snapshots`, `catalog_tool_definitions` |
| `runtime-catalog/schema.ts` | `runtime_catalog_entries` |

Copies and owned files are listed in `scripts/platform-sync/map.json`. `categorize.ts` is a copy
with one `biome-ignore`, to put back after each sync.
