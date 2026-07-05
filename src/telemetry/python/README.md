# `ratel-ai-telemetry` (Python)

The `ratel.*` telemetry helper for Python: the constants that codify the Tier 2 overlay
of [`../CONVENTIONS.md`](../CONVENTIONS.md) (attribute keys, span/event names, the
`Origin`/`SearchTarget`/`AuthOutcome` value enums, the pinned semconv version), plus
`init()` sugar over the standard OpenTelemetry Python SDK. `init()` wires an OTLP
`http/protobuf` exporter to `RATEL_URL` (or `endpoint=`/`headers=`) and returns the
provider as a shutdown handle; a caller already running the OTel SDK skips it and takes
only the constants. This package adds no custom transport, no native binding, no schema
([ADR-0015](../../../docs/adr/0015-telemetry-otel-conventions.md)).

## Package shape

- Distribution name: `ratel-ai-telemetry`; import name: `ratel_ai_telemetry`
- Pure Python (hatchling build, no Rust extension); depends on the OpenTelemetry Python SDK for `init()`
- Targets Python >=3.9 (the OTel deps are pinned below 1.42, the last line supporting 3.9)
- Released under the `telemetry-v*` tag prefix ([ADR-0016](../../../docs/adr/0016-per-package-versions-and-releases.md))
- MIT ([ADR-0017](../../../docs/adr/0017-relicense-core-apache-2.md))

## Build & test

From this directory (needs [uv](https://docs.astral.sh/uv/)):

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv -e '.[dev]'
.venv/bin/ruff check . && .venv/bin/mypy ratel_ai_telemetry && .venv/bin/pytest
```

Unlike the Python SDK there is no `maturin develop` step — the package is pure Python,
installed editable. The tests cover the vocabulary (each constant asserted against the
pin), `init()`'s endpoint/auth resolution and the content-capture gate, and the shared
contract-against-the-pin conformance in [`../conformance/`](../conformance/README.md)
(spans built from these constants through the real SDK must emit the exact pinned keys).
