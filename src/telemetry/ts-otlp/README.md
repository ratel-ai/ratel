# `@ratel-ai/telemetry-otlp`

The OTLP exporter surface for Ratel telemetry over the OTel-free [`@ratel-ai/telemetry`](../ts/README.md)
vocabulary: turnkey `init()` wiring for a greenfield app, plus a composable `ratelSpanProcessor`
for coexisting with a provider a partner already owns. `init()` wires an OTLP `http/protobuf`
exporter to `RATEL_URL` (or `{ endpoint, headers }`) with a `service.name` resource and batch
processor over the [OpenTelemetry JS SDK](https://opentelemetry.io/docs/languages/js/), registers
it as the global tracer provider, and returns a shutdown handle. It is split from the vocabulary
package (ADR-0015) so importing the `ratel.*` constants never pulls the OpenTelemetry SDK.

## Usage

```ts
import { trace } from "@opentelemetry/api";
import { EXECUTE_TOOL, GEN_AI_OPERATION_NAME, GEN_AI_TOOL_NAME, Origin, RATEL_ORIGIN } from "@ratel-ai/telemetry";
import { init } from "@ratel-ai/telemetry-otlp";

// Wire the OTLP exporter to RATEL_URL once at startup (or pass { endpoint, headers }).
const telemetry = init({ apiKey: process.env.RATEL_API_KEY });

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

`init()` registers and **owns** the global tracer provider, so it is the turnkey path for a
greenfield app. It throws — pointing at `ratelSpanProcessor` — rather than silently no-op'ing
if a provider is already registered. A complete, offline-runnable version (console exporter +
a `ratel.search` → `execute_tool` trace) is in
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
    ratelSpanProcessor({ apiKey: process.env.RATEL_API_KEY }),  // Ratel takes gen_ai.*/ratel.* only
  ],
});
provider.register();
```

Pass `spanFilter: () => true` (or your own predicate) to override the default. `ratelTraceExporter`
is the bare OTLP exporter if you want to wire your own processor. Note that per-span filtering can
orphan the AI SDK's `ai.*` wrapper from its `gen_ai.*` child; send everything (or tail-sample) when
you need full-trace fidelity rather than just the gen_ai/ratel metrics.

## Package shape

- Package name: `@ratel-ai/telemetry-otlp`
- Pure TypeScript (no native binding); depends on `@ratel-ai/telemetry` + the OpenTelemetry JS SDK
- Released under the `telemetry-ts-otlp-v*` tag prefix ([ADR-0016](../../../docs/adr/0016-per-package-versions-and-releases.md))
- MIT ([ADR-0017](../../../docs/adr/0017-relicense-core-apache-2.md)); member of the pnpm workspace

## Build & test

From the repo root:

```bash
pnpm --filter @ratel-ai/telemetry-otlp build
pnpm --filter @ratel-ai/telemetry-otlp typecheck
pnpm --filter @ratel-ai/telemetry-otlp lint
pnpm --filter @ratel-ai/telemetry-otlp test
```

The tests cover `init()`'s handle shape, its misconfiguration error and its already-registered
guard, plus the `ratelSignalFilter` predicate and that `ratelSpanProcessor` forwards only the
spans it passes; the endpoint/auth resolution both rely on is covered in
[`@ratel-ai/telemetry`](../ts/README.md) (the pure `resolveOtlpConfig`).
