# `lib/ingest` (L2)

What the SDKs send: OTLP traces and logs, runtime events, catalog snapshots. Arriving slice by
slice from `ratel-cloud`; today it holds the leaf helpers and the table fragments, and the
modules and routes follow.

| Path | Holds |
|---|---|
| `cloud-schema.ts` | `CloudEvent`: the shape one LLM call reduces to, rebuilt from OTLP spans and stored in `events.payload` |
| `context.ts`, `categorize.ts` | the five context sources, and the attribution of a call's input tokens across them |
| `gateway-tools.ts` | the gateway's meta-tool ids, so an `invoke_tool` call counts against the real tool |
| `pricing.ts` | the model token price table and `costFor` |
| `otlp/schema.ts` | `events`, `event_metrics`, `otel_spans`, `otel_logs` |
| `trace-events/schema.ts` | `trace_events`, `trace_event_hits`, `trace_event_rejects`, `tool_usage_counters` |
| `runtime-events/schema.ts` | `runtime_event_sources` |
| `catalogs/schema.ts` | `catalog_snapshots`, `catalog_tool_definitions` |
| `runtime-catalog/schema.ts` | `runtime_catalog_entries` |

The leaf helpers are synced as copies; the schema fragments are owned here (see
`scripts/platform-sync/map.json`).
