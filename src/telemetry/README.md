# `src/telemetry/`

Ratel's **remote** telemetry: OpenTelemetry conventions plus thin helper packages. Ratel telemetry *is* OpenTelemetry: LLM calls are `gen_ai.*` spans, the gateway/skill funnel is a `ratel.*` overlay, and ingest is stock OTLP. No custom schema, no custom transport, no FFI.

Distinct from the local JSONL trace stream (ADR-0009, in [`../core/`](../core/README.md)), which stays as-is; only the remote path lives here.

The wire contract is [`CONVENTIONS.md`](CONVENTIONS.md): the `gen_ai.*` mapping and the `ratel.*` vocabulary every consumer reads against. The helpers below codify the `ratel.*` half as constants.

## Layout

```
CONVENTIONS.md   the telemetry wire contract (gen_ai.* mapping + ratel.* vocabulary)
conformance/     shared contract-against-the-pin fixtures every language helper asserts against
core/            ratel-ai-telemetry (crates.io): the ratel.* constants (shared vocabulary)
ts/              @ratel-ai/telemetry (npm): init() over the OTel SDK + ratel.* constants
python/          ratel-ai-telemetry (PyPI): init() over the OTel SDK + ratel.* constants
```

The `ts/` and `python/` helpers are `init()` sugar over the standard OTel SDK: `init()` wires an OTLP `http/protobuf` exporter to `RATEL_URL` (or a caller-supplied endpoint) and exposes the `ratel.*` constants. A caller already running the OTel SDK can skip `init()` and add the Ratel endpoint as a second exporter, taking only the constants. The `core/` crate carries the same `ratel.*` constants as the shared source of truth for in-process Rust consumers. Every helper's conformance test builds spans from its own constants and asserts them against the single shared fixture set in [`conformance/`](conformance/README.md), so the languages cannot drift.

Rationale and the two-tier design are locked in [ADR 0015](../../docs/adr/0015-telemetry-otel-conventions.md); packages are released under the `telemetry-v*` tag prefix per [ADR 0016](../../docs/adr/0016-per-package-versions-and-releases.md).
