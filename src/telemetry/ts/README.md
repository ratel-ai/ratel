# `@ratel-ai/telemetry`

The `ratel.*` telemetry vocabulary for TypeScript: the constants that codify the
Tier 2 overlay of [`../CONVENTIONS.md`](../CONVENTIONS.md), plus the pinned semconv
version. Emitting the vocabulary is done through the standard OpenTelemetry JS SDK —
this package adds no transport, no native binding, no schema ([ADR-0015](../../../docs/adr/0015-telemetry-otel-conventions.md)).

## Package shape

- Package name: `@ratel-ai/telemetry`
- Pure TypeScript (no native binding); released under the `telemetry-v*` tag prefix ([ADR-0016](../../../docs/adr/0016-per-package-versions-and-releases.md))
- MIT ([ADR-0017](../../../docs/adr/0017-relicense-core-apache-2.md)); member of the pnpm workspace

## Build & test

From the repo root:

```bash
pnpm --filter @ratel-ai/telemetry build
pnpm --filter @ratel-ai/telemetry typecheck
pnpm --filter @ratel-ai/telemetry lint
pnpm --filter @ratel-ai/telemetry test
```

The tests are the contract-against-the-pin conformance for the TypeScript helper:
each constant is asserted against the vocabulary pinned in [`../CONVENTIONS.md`](../CONVENTIONS.md).
