# `@ratel-ai/telemetry`

The `ratel.*` telemetry helper for TypeScript: the constants that codify the Tier 2
overlay of [`../CONVENTIONS.md`](../CONVENTIONS.md) (attribute keys, span/event names,
the `Origin`/`SearchTarget`/`AuthOutcome` value enums, the pinned semconv version), plus
`init()` sugar over the standard OpenTelemetry JS SDK. `init()` wires an OTLP
`http/protobuf` exporter to `RATEL_URL` (or `{ endpoint, headers }`) and returns a
shutdown handle; a caller already running the OTel SDK skips it and takes only the
constants. This package adds no custom transport, no native binding, no schema
([ADR-0015](../../../docs/adr/0015-telemetry-otel-conventions.md)).

## Package shape

- Package name: `@ratel-ai/telemetry`
- Pure TypeScript (no native binding); depends on the OpenTelemetry JS SDK for `init()`
- Released under the `telemetry-v*` tag prefix ([ADR-0016](../../../docs/adr/0016-per-package-versions-and-releases.md))
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
