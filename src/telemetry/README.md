# `src/telemetry/`

Ratel's **remote** telemetry: OpenTelemetry conventions plus thin helper packages. Ratel telemetry *is* OpenTelemetry: LLM calls are `gen_ai.*` spans, content-bearing details are Logs `EventRecord`s, the capability/skill funnel is a `ratel.*` overlay, and ingest is stock OTLP. No custom transport or FFI.

Distinct from the local JSONL trace stream (ADR-0007, in [`../core/`](../core/README.md)), which stays as-is; only the remote path lives here.

The wire contract is [`CONVENTIONS.md`](CONVENTIONS.md): the `gen_ai.*` mapping and the `ratel.*` vocabulary every consumer reads against. The helpers below codify the `ratel.*` half as constants.

## Layout

```
CONVENTIONS.md   the telemetry wire contract (gen_ai.* mapping + ratel.* vocabulary)
conformance/     shared contract-against-the-pin fixtures every language helper asserts against
core/            ratel-ai-telemetry (crates.io): the ratel.* constants (shared vocabulary)
ts/              @ratel-ai/telemetry (npm): the ratel.* constants + OTLP config, OTel-free
ts-otlp/         @ratel-ai/telemetry-otlp (npm): startTelemetry()/init() over the OTel SDK
python/          ratel-ai-telemetry (PyPI): the ratel.* constants; init() behind the [otlp] extra
```

The vocabulary is kept OTel-free so the SDK (emit side), the cloud (read side), and edge/serverless emitters take it weight-free (ADR-0007): importing `@ratel-ai/telemetry` or `ratel_ai_telemetry` pulls no OpenTelemetry SDK. Turnkey exporter sugar over the standard OTel SDK lives apart from the vocabulary: in TypeScript as `startTelemetry()` (`init()` remains an alias) in the separate `@ratel-ai/telemetry-otlp` package (`ts-otlp/`), and in Python as `init()` behind the optional `[otlp]` extra (`ratel_ai_telemetry.otlp`). The TypeScript exporter reads `RATEL_OTLP_ENDPOINT`; the Python exporter reads `RATEL_URL`; both derive a sibling Logs URL or accept caller-supplied trace and Logs endpoints. TypeScript callers can compose host span and log-record processors on the owned providers and use the returned `forceFlush()` / `shutdown()` handle. A caller already running the OTel SDK skips turnkey initialization and adds the Ratel span and log-record processors to its providers. The `core/` crate carries the same `ratel.*` constants as the shared source of truth for in-process Rust consumers. The TS and Python helpers' conformance tests build spans and EventRecords from their own constants and assert them against the single shared fixture set in [`conformance/`](conformance/README.md), so those two cannot drift; the `core/` crate stays dependency-free and pins the same constants by literal-equality unit tests.

Rationale and the two-tier design are documented in [ADR 0007](../../docs/adr/0007-telemetry-two-streams.md). Each package is an independent release unit per [ADR 0008](../../docs/adr/0008-release-engineering.md): `core/` ships on `telemetry-core-v*`, `ts/` on `telemetry-ts-v*`, `python/` on `telemetry-py-v*`, and `ts-otlp/` on `telemetry-ts-otlp-v*`.
