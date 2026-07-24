# `@ratel-ai/telemetry-otlp`

The OTLP exporter surface for Ratel telemetry over the OTel-free [`@ratel-ai/telemetry`](../ts/README.md)
vocabulary: turnkey `startTelemetry()` wiring for a greenfield app (`init` remains its
back-compat alias), plus composable `ratelSpanProcessor` and `ratelLogRecordProcessor` helpers
for coexisting with providers a partner already owns. `startTelemetry()` wires OTLP
`http/protobuf` trace and Logs exporters from
`RATEL_OTLP_ENDPOINT` + `RATEL_API_KEY` (or explicit
`{ endpoint, logsEndpoint, apiKey, headers }`) with a shared `service.name` resource and batch
processors over the [OpenTelemetry JS SDK](https://opentelemetry.io/docs/languages/js/),
registers it as the global
tracer and logger providers, and returns a `forceFlush()` / `shutdown()` handle. Host processors
can join the owned providers through `spanProcessors` / `logRecordProcessors` to fan the same
signals out to another backend (e.g. Langfuse) without ceding either provider. It is split from
the vocabulary package (ADR-0007) so importing the `ratel.*` constants never pulls the
OpenTelemetry SDK.

## Usage

```ts
import { trace } from "@opentelemetry/api";
import { EXECUTE_TOOL, GEN_AI_OPERATION_NAME, GEN_AI_TOOL_NAME, Origin, RATEL_ORIGIN } from "@ratel-ai/telemetry";
import { startTelemetry } from "@ratel-ai/telemetry-otlp";

// Wire trace + Logs exporters from RATEL_OTLP_ENDPOINT + RATEL_API_KEY once at startup.
const telemetry = startTelemetry();

// Emit a standard gen_ai `execute_tool` span enriched with the ratel.* overlay.
const span = trace.getTracer("my-agent").startSpan(EXECUTE_TOOL, {
  attributes: {
    [GEN_AI_OPERATION_NAME]: EXECUTE_TOOL,
    [GEN_AI_TOOL_NAME]: "send_email",
    [RATEL_ORIGIN]: Origin.Agent,
  },
});
span.end();

await telemetry.forceFlush(); // drain pending records in serverless / batch jobs
await telemetry.shutdown(); // flush + stop both providers on exit
```

Explicit options beat the environment: an explicit `apiKey` sets the Bearer header, and the
`RATEL_API_KEY` fallback never overrides an `Authorization` header you pass yourself. On first
setup, pass `enabled: false` to get a no-op handle without requiring endpoint
configuration, `spanFilter` to narrow the spans exported by the turnkey provider, or `logFilter`
to narrow its EventRecords (both default to accepting everything). `endpoint` is the full traces
URL; `logsEndpoint` overrides the Logs URL that otherwise derives from sibling `/v1/logs`.
Pass `spanProcessors` / `logRecordProcessors` to compose host processors on the owned providers;
every signal fans out to all of its processors, each applying its own filter, and `forceFlush()`
drains all of them (useful for serverless or batch jobs). Repeated `startTelemetry()` / `init()`
calls return the exact handle from the first successful Ratel-owned initialization—even if a
later caller is disabled—so hot reload and multiple callers
do not fight over the global provider; the first call's configuration remains authoritative, and
shutting that shared handle down stops export for every caller. A foreign provider still produces
the actionable processor-composition error before endpoint validation. Shutdown is terminal: after
`handle.shutdown()`, a later call throws (call both `trace.disable()` and `logs.disable()`
first to re-initialize).

A complete, offline-runnable version (console exporter + a `ratel.search` → `execute_tool` trace)
is in
[`examples/telemetry-ts`](../../../examples/telemetry-ts/README.md).

## Coexisting with other providers (Langfuse, the Vercel AI SDK, ...)

OpenTelemetry allows one global provider per signal, with many processors on each. When a partner
already owns the providers, add the Ratel processors instead of calling `startTelemetry()` (or
its `init()` alias). The defaults forward only named `gen_ai.*` / `ratel.*` signal spans and
EventRecords:

```ts
import { logs } from "@opentelemetry/api-logs";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  ratelLogRecordProcessor,
  ratelSpanProcessor,
} from "@ratel-ai/telemetry-otlp";

const tracerProvider = new NodeTracerProvider({
  spanProcessors: [
    new LangfuseSpanProcessor(), // Langfuse keeps every span
    ratelSpanProcessor(), // reads RATEL_OTLP_ENDPOINT + RATEL_API_KEY; Ratel takes gen_ai.*/ratel.* only
  ],
});
tracerProvider.register();

const loggerProvider = new LoggerProvider({
  processors: [ratelLogRecordProcessor()],
});
logs.setGlobalLoggerProvider(loggerProvider);
```

Pass `spanFilter: () => true` or `logFilter: () => true` (or your own predicates) to override
the defaults. `ratelTraceExporter` and `ratelLogExporter` are the bare OTLP exporters if you
want to wire your own processors. Note that per-span filtering can orphan the AI SDK's `ai.*`
wrapper from its `gen_ai.*` child; send everything (or tail-sample) when you need full-trace
fidelity rather than just the gen_ai/ratel metrics. `enabled: false` returns a no-op processor
without resolving configuration.

## Package shape

- Package name: `@ratel-ai/telemetry-otlp`
- Pure TypeScript (no native binding); installing this package brings the exporter and OTel SDK
  implementation (trace and Logs exporters, resources, semantic-conventions, trace SDK, Logs SDK)
  as runtime deps.
  `@opentelemetry/api` is a peer so the host and Ratel share one global API instance — npm ≥7 and
  pnpm auto-install it, but yarn (and pnpm with `auto-install-peers=false`) need an explicit
  `add @opentelemetry/api`.
- Released under the `telemetry-ts-otlp-v*` tag prefix ([ADR-0008](../../../docs/adr/0008-release-engineering.md))
- MIT ([ADR-0009](../../../docs/adr/0009-licensing.md)); member of the pnpm workspace

## Build & test

From the repo root:

```bash
pnpm --filter @ratel-ai/telemetry-otlp build
pnpm --filter @ratel-ai/telemetry-otlp typecheck
pnpm --filter @ratel-ai/telemetry-otlp lint
pnpm --filter @ratel-ai/telemetry-otlp test
```

The tests cover disabled, filtered, idempotent, misconfigured, and foreign-provider
`startTelemetry()` / `init()` behavior for both signal providers; host-processor composition and
force-flush fan-out; the `init` alias; the published dependency layout; and span/EventRecord
filter behavior. Endpoint/auth resolution is covered in
[`@ratel-ai/telemetry`](../ts/README.md) (the pure `resolveOtlpConfig`).
