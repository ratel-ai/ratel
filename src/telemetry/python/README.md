# `ratel-ai-telemetry` (Python)

The `ratel.*` telemetry vocabulary for Python: the constants that codify the Tier 2
overlay of [`../CONVENTIONS.md`](../CONVENTIONS.md), plus the pinned semconv version.
Emitting the vocabulary is done through the standard OpenTelemetry Python SDK — this
package is pure Python and adds no transport, no native binding, no schema
([ADR-0015](../../../docs/adr/0015-telemetry-otel-conventions.md)).

## Package shape

- Distribution name: `ratel-ai-telemetry`; import name: `ratel_ai_telemetry`
- Pure Python (hatchling build, no Rust extension); released under the `telemetry-v*` tag prefix ([ADR-0016](../../../docs/adr/0016-per-package-versions-and-releases.md))
- MIT ([ADR-0017](../../../docs/adr/0017-relicense-core-apache-2.md))

## Build & test

From this directory (needs [uv](https://docs.astral.sh/uv/)):

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv -e '.[dev]'
.venv/bin/ruff check . && .venv/bin/mypy ratel_ai_telemetry && .venv/bin/pytest
```

Unlike the Python SDK there is no `maturin develop` step — the package is pure Python,
installed editable. The tests are the contract-against-the-pin conformance: each
constant is asserted against the vocabulary pinned in [`../CONVENTIONS.md`](../CONVENTIONS.md).
