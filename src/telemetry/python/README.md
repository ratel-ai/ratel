# `ratel-ai-telemetry` (Python)

The `ratel.*` telemetry vocabulary for Python: the constants that codify the Tier 2 overlay
of [`../CONVENTIONS.md`](../CONVENTIONS.md) (attribute keys, span/event names, the
`Origin`/`SearchTarget`/`AuthOutcome` value enums, the pinned semconv version). **Importing
the constants pulls no OpenTelemetry SDK** — the vocabulary stays weight-free for the SDK
(emit side), the server (read side), and edge/serverless emitters
([ADR-0015](../../../docs/adr/0015-telemetry-otel-conventions.md)). `init()` — turnkey OTLP
exporter sugar over the standard OTel Python SDK — lives in the `ratel_ai_telemetry.otlp`
submodule behind the optional `[otlp]` extra.

## Usage

```python
from opentelemetry import trace
from ratel_ai_telemetry import EXECUTE_TOOL, GEN_AI_OPERATION_NAME, GEN_AI_TOOL_NAME, RATEL_ORIGIN, Origin

# Emit a standard gen_ai `execute_tool` span enriched with the ratel.* overlay,
# on your own OTel provider — the constants alone, no extra needed.
span = trace.get_tracer("my-agent").start_span(
    EXECUTE_TOOL,
    attributes={
        GEN_AI_OPERATION_NAME: EXECUTE_TOOL,
        GEN_AI_TOOL_NAME: "send_email",
        RATEL_ORIGIN: Origin.AGENT.value,
    },
)
span.end()
```

Want turnkey OTLP export to Ratel? Install `ratel-ai-telemetry[otlp]` and call `init()`:

```python
from ratel_ai_telemetry.otlp import init  # also importable as `from ratel_ai_telemetry import init`

provider = init(api_key="sk-...")  # wires the OTLP exporter to RATEL_URL (or endpoint=/headers=)
# ... emit spans ...
provider.shutdown()  # flush the exporter on exit
```

A complete, offline-runnable version (console exporter + a `ratel.search` → `execute_tool`
trace) is in [`examples/telemetry-python`](../../../examples/telemetry-python/README.md).

## Package shape

- Distribution name: `ratel-ai-telemetry`; import name: `ratel_ai_telemetry`
- Pure Python (hatchling build, no Rust extension); OTel-free constants, `init()` behind the `[otlp]` extra
- Targets Python >=3.9 (the `[otlp]` OTel deps are pinned below 1.42, the last line supporting 3.9)
- Released under the `telemetry-py-v*` tag prefix ([ADR-0016](../../../docs/adr/0016-per-package-versions-and-releases.md))
- MIT ([ADR-0017](../../../docs/adr/0017-relicense-core-apache-2.md))

## Build & test

From this directory (needs [uv](https://docs.astral.sh/uv/)):

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv -e '.[dev]'
.venv/bin/ruff check . && .venv/bin/mypy ratel_ai_telemetry && .venv/bin/pytest
```

Unlike the Python SDK there is no `maturin develop` step — the package is pure Python,
installed editable (`[dev]` pulls the `[otlp]` extra so the tests exercise the real SDK).
The tests cover the vocabulary (each constant asserted against the pin), `init()`'s
endpoint/auth resolution and the content-capture gate, a purity guard that importing the
package pulls no OTel, and the shared contract-against-the-pin conformance in
[`../conformance/`](../conformance/README.md) (spans built from these constants through the
real SDK must emit the exact pinned keys).
