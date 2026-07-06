# `@ratel-ai/telemetry-otlp`

The `init()` OTLP exporter for Ratel telemetry: turnkey [OpenTelemetry JS SDK](https://opentelemetry.io/docs/languages/js/)
wiring over the OTel-free [`@ratel-ai/telemetry`](../ts/README.md) vocabulary. `init()`
wires an OTLP `http/protobuf` exporter to `RATEL_URL` (or `{ endpoint, headers }`) with a
`service.name` resource and batch processor, registers it as the global tracer provider,
and returns a shutdown handle. It is split from the vocabulary package (ADR-0015) so
importing the `ratel.*` constants never pulls the OpenTelemetry SDK.

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

`init()` registers and **owns** the global tracer provider, so it does not coexist with an
existing one (e.g. a customer's Langfuse). Already running the OTel SDK? Skip this package
and emit `ratel.*` via `@opentelemetry/api` + the constants from
[`@ratel-ai/telemetry`](../ts/README.md) on your own provider. A complete, offline-runnable
version (console exporter + a `ratel.search` → `execute_tool` trace) is in
[`examples/telemetry-ts`](../../../examples/telemetry-ts/README.md).

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

The tests cover `init()`'s handle shape and its misconfiguration error; the endpoint/auth
resolution it relies on is covered in [`@ratel-ai/telemetry`](../ts/README.md) (the pure
`resolveOtlpConfig`).
