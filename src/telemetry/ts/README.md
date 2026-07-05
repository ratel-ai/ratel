# `@ratel-ai/telemetry`

The `ratel.*` telemetry helper for TypeScript: the constants that codify the Tier 2
overlay of [`../CONVENTIONS.md`](../CONVENTIONS.md) (attribute keys, span/event names,
the `Origin`/`SearchTarget`/`AuthOutcome` value enums, the pinned semconv version), plus
`init()` sugar over the standard OpenTelemetry JS SDK. `init()` wires an OTLP
`http/protobuf` exporter to `RATEL_URL` (or `{ endpoint, headers }`) and returns a
shutdown handle; a caller already running the OTel SDK skips it and takes only the
constants. This package adds no custom transport, no native binding, no schema
([ADR-0015](../../../docs/adr/0015-telemetry-otel-conventions.md)).

## Usage

```ts
import { trace } from "@opentelemetry/api";
import { EXECUTE_TOOL, GEN_AI_OPERATION_NAME, GEN_AI_TOOL_NAME, init, Origin, RATEL_ORIGIN } from "@ratel-ai/telemetry";

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

Already running the OTel SDK? Skip `init()` and take only the constants. A complete,
offline-runnable version (console exporter + a `ratel.search` → `execute_tool` trace) is in
[`examples/telemetry-ts`](../../../examples/telemetry-ts/README.md).

## Package shape

- Package name: `@ratel-ai/telemetry`
- Pure TypeScript (no native binding); depends on the OpenTelemetry JS SDK for `init()`
- Released under the `telemetry-js-v*` tag prefix ([ADR-0016](../../../docs/adr/0016-per-package-versions-and-releases.md))
- MIT ([ADR-0017](../../../docs/adr/0017-relicense-core-apache-2.md)); member of the pnpm workspace

## Build & test

From the repo root:

```bash
pnpm --filter @ratel-ai/telemetry build
pnpm --filter @ratel-ai/telemetry typecheck
pnpm --filter @ratel-ai/telemetry lint
pnpm --filter @ratel-ai/telemetry test
```

The tests cover the vocabulary (each constant asserted against the pin), `init()`'s
endpoint/auth resolution and the content-capture gate, and the shared contract-against-the-pin
conformance in [`../conformance/`](../conformance/README.md) (spans built from these
constants through the real SDK must emit the exact pinned keys).
