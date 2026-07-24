# `examples/telemetry-ts` — emit `ratel.*` telemetry with OpenTelemetry (TypeScript)

Shows how to emit Ratel's telemetry vocabulary through the standard [OpenTelemetry JS SDK](https://opentelemetry.io/docs/languages/js/) using [`@ratel-ai/telemetry`](../../src/telemetry/ts/README.md) for constants and [`@ratel-ai/telemetry-otlp`](../../src/telemetry/ts-otlp/README.md) for exporter setup. Ratel telemetry *is* OpenTelemetry ([ADR-0007](../../docs/adr/0007-telemetry-two-streams.md)): the vocabulary package provides the `ratel.*` constants and value enums, while the OTLP package provides the optional `init()` helper and transport dependencies.

The demo emits one realistic trace — a `ratel.search` (capability search) span followed by an `execute_tool` span enriched with the `ratel.*` overlay, both under a root agent-turn span so they share one trace — and prints it with a `ConsoleSpanExporter`, so it runs offline with no collector and no API key.

## Setup

```bash
pnpm install
pnpm -F @ratel-ai/example-telemetry start
```

`start` builds both telemetry packages and runs `src/index.ts` with [tsx](https://tsx.is/). It prints the trace (the agent-turn root plus the two Ratel spans, with their `ratel.*` / `gen_ai.*` attributes) and shows how exporter setup resolves its endpoint + auth.

To export a real trace instead of printing, set the endpoint and run again:

```bash
export RATEL_OTLP_ENDPOINT=https://cloud.ratel.sh/v1/traces
export RATEL_API_KEY=sk-...          # optional; sent as Authorization: Bearer
pnpm -F @ratel-ai/example-telemetry start
```

## What it illustrates

- **The vocabulary is just constants.** `RATEL_SEARCH`, `EXECUTE_TOOL`, `RATEL_ORIGIN`, `GEN_AI_TOOL_NAME`, … are `import`ed from `@ratel-ai/telemetry` and set as attributes on stock OTel spans. The `Origin` / `SearchTarget` value enums carry the exact wire strings.
- **Tool calls are standard `gen_ai` spans.** The invocation is an `execute_tool` span (so any OTel backend understands it), enriched with `ratel.*` attributes — not a bespoke Ratel span.
- **`init()` is optional sugar.** `resolveOtlpConfig()` (pure, shown in the output) resolves `RATEL_OTLP_ENDPOINT` + `RATEL_API_KEY`; `init()` wires an OTLP `http/protobuf` exporter and returns a shutdown handle. The example enables it only when `RATEL_OTLP_ENDPOINT` is set, so the disabled path needs no env gate or error handling. A caller already running the OTel SDK adds `ratelSpanProcessor()` instead.
- **Content capture is gated.** `contentCaptureMode()` reads `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` (default `NO_CONTENT`).

## Layout

```
src/index.ts   emitRatelTrace() — builds the trace (root + the two Ratel spans) from the constants; main() wires the exporter and prints
```

## Why it's a separate workspace package

Examples don't ship in the telemetry packages. The direct OTel SDK dependencies used by the offline `ConsoleSpanExporter` demo stay here; `@ratel-ai/telemetry-otlp` owns the turnkey exporter stack.
