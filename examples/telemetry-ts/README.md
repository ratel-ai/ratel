# `examples/telemetry-ts` — emit `ratel.*` telemetry with OpenTelemetry (TypeScript)

Shows how to emit Ratel's telemetry vocabulary through the standard [OpenTelemetry JS SDK](https://opentelemetry.io/docs/languages/js/) using [`@ratel-ai/telemetry`](../../src/telemetry/ts/README.md). Ratel telemetry *is* OpenTelemetry ([ADR-0015](../../docs/adr/0015-telemetry-otel-conventions.md)): the package ships no transport and no schema, just the `ratel.*` constants and value enums you set as span attributes, plus an `init()` helper that wires the OTLP exporter.

The demo emits one realistic trace — a `ratel.search` (capability search) span followed by an `execute_tool` span enriched with the `ratel.*` overlay — and prints it with a `ConsoleSpanExporter`, so it runs offline with no collector and no API key.

## Setup

```bash
pnpm install
pnpm -F @ratel-ai/example-telemetry start
```

`start` builds `@ratel-ai/telemetry` and runs `src/index.ts` with [tsx](https://tsx.is/). It prints the two spans (with their `ratel.*` / `gen_ai.*` attributes) and the config `init()` would use in production.

To export a real trace instead of printing, set the endpoint and run again:

```bash
export RATEL_URL=https://ingest.ratel.sh/v1/traces
export RATEL_API_KEY=sk-...          # optional; sent as Authorization: Bearer
pnpm -F @ratel-ai/example-telemetry start
```

## What it illustrates

- **The vocabulary is just constants.** `RATEL_SEARCH`, `EXECUTE_TOOL`, `RATEL_ORIGIN`, `GEN_AI_TOOL_NAME`, … are `import`ed from `@ratel-ai/telemetry` and set as attributes on stock OTel spans. The `Origin` / `SearchTarget` value enums carry the exact wire strings.
- **Tool calls are standard `gen_ai` spans.** The invocation is an `execute_tool` span (so any OTel backend understands it), enriched with `ratel.*` attributes — not a bespoke Ratel span.
- **`init()` is optional sugar.** `resolveOtlpConfig()` (pure, shown in the output) resolves the endpoint + `Authorization` header; `init()` wires that into an OTLP `http/protobuf` exporter and returns a shutdown handle. A caller already running the OTel SDK skips `init()` and takes only the constants.
- **Content capture is gated.** `contentCaptureMode()` reads `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` (default `NO_CONTENT`).

## Layout

```
src/index.ts   emitRatelTrace() — builds the two spans from the constants; main() wires the exporter and prints
```

## Why it's a separate workspace package

Examples don't ship in `@ratel-ai/telemetry` — keeping them out of the published artifact keeps the package dependency-light. The OTel SDK packages the demo needs (`sdk-trace-node`, `sdk-trace-base`, …) are pulled in here.
