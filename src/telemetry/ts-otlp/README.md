# `@ratel-ai/telemetry-otlp`

The OTLP exporter surface for Ratel telemetry over the OTel-free [`@ratel-ai/telemetry`](../ts/README.md)
vocabulary: turnkey `init()` wiring for a greenfield app, plus a composable `ratelSpanProcessor`
for coexisting with a provider a partner already owns. `init()` wires an OTLP `http/protobuf`
exporter from `RATEL_URL` + `RATEL_API_KEY` (or explicit `{ endpoint, apiKey, headers }`) with a
`service.name` resource and batch processor over the
[OpenTelemetry JS SDK](https://opentelemetry.io/docs/languages/js/), registers it as the global
tracer provider, and returns a shutdown handle. It is split from the vocabulary package
(ADR-0007) so importing the `ratel.*` constants never pulls the OpenTelemetry SDK.

## Usage

```ts
import { trace } from "@opentelemetry/api";
import { EXECUTE_TOOL, GEN_AI_OPERATION_NAME, GEN_AI_TOOL_NAME, Origin, RATEL_ORIGIN } from "@ratel-ai/telemetry";
import { init } from "@ratel-ai/telemetry-otlp";

// Wire the exporter from RATEL_URL + RATEL_API_KEY once at startup.
const telemetry = init();

// Emit a standard gen_ai `execute_tool` span enriched with the ratel.* overlay.
const span = trace.getTracer("my-agent").startSpan(EXECUTE_TOOL, {
  attributes: {
    [GEN_AI_OPERATION_NAME]: EXECUTE_TOOL,
    [GEN_AI_TOOL_NAME]: "send_email",
    [RATEL_ORIGIN]: Origin.Agent,
  },
});
span.end();

await telemetry.shutdown(); // flush the exporter on exit
```

Explicit options beat the environment. On first setup, pass `enabled: false` to get a no-op
shutdown handle without requiring endpoint configuration, or `spanFilter` to narrow the spans
exported by the turnkey provider (the default exports every span). Repeated `init()` calls return
the exact handle from the first successful Ratel-owned initialization—even if a later caller is
disabled—so hot reload and multiple callers do not fight over the global provider; the first
call's configuration remains authoritative. A foreign provider still produces the actionable
`ratelSpanProcessor` error before endpoint validation.

A complete, offline-runnable version (console exporter + a `ratel.search` → `execute_tool` trace)
is in
[`examples/telemetry-ts`](../../../examples/telemetry-ts/README.md).

## Coexisting with another provider (Langfuse, the Vercel AI SDK, ...)

OpenTelemetry's model is **one provider, many span-processors**. When a partner already owns
the provider, add `ratelSpanProcessor` to it instead of calling `init()` — every span fans out
to both, and Ratel ingests only the `gen_ai.*` / `ratel.*` signal (the default
`ratelSignalFilter`), so the framework's `ai.*` wrapper noise stays out:

```ts
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { ratelSpanProcessor } from "@ratel-ai/telemetry-otlp";

const provider = new NodeTracerProvider({
  spanProcessors: [
    new LangfuseSpanProcessor(),                                // Langfuse keeps every span
    ratelSpanProcessor(),  // reads RATEL_URL + RATEL_API_KEY; Ratel takes gen_ai.*/ratel.* only
  ],
});
provider.register();
```

Pass `spanFilter: () => true` (or your own predicate) to override the default. `ratelTraceExporter`
is the bare OTLP exporter if you want to wire your own processor. Note that per-span filtering can
orphan the AI SDK's `ai.*` wrapper from its `gen_ai.*` child; send everything (or tail-sample) when
you need full-trace fidelity rather than just the gen_ai/ratel metrics. `enabled: false` returns a
no-op processor without resolving configuration.

## Package shape

- Package name: `@ratel-ai/telemetry-otlp`
- Pure TypeScript (no native binding); installing this package brings the exporter and OTel SDK
  implementation automatically. `@opentelemetry/api` is a peer so the host and Ratel share one
  global API instance; callers do not install the individual SDK packages themselves.
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

The tests cover disabled, filtered, idempotent, misconfigured, and foreign-provider `init()`
behavior; the published dependency layout; and that `ratelSpanProcessor` forwards only the spans
its filter accepts. Endpoint/auth resolution is covered in
[`@ratel-ai/telemetry`](../ts/README.md) (the pure `resolveOtlpConfig`).
