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

`init()` owns the global provider, so it is the turnkey path for a greenfield app; it raises —
pointing at `ratel_span_processor` — rather than silently no-op'ing if a provider is already
registered. A complete, offline-runnable version (console exporter + a `ratel.search` →
`execute_tool` trace) is in [`examples/telemetry-python`](../../../examples/telemetry-python/README.md).

### Coexisting with another provider (Langfuse, the Vercel AI SDK, ...)

OpenTelemetry's model is one provider with many span-processors. When a partner already owns the
provider, add `ratel_span_processor` to it instead of calling `init()` — Ratel ingests only the
`gen_ai.*` / `ratel.*` signal (the default `ratel_signal_filter`), dropping the framework's `ai.*`
wrapper noise:

```python
from opentelemetry.sdk.trace import TracerProvider
from ratel_ai_telemetry.otlp import ratel_span_processor

provider = TracerProvider()
provider.add_span_processor(existing_langfuse_processor)              # keeps every span
provider.add_span_processor(ratel_span_processor(api_key="sk-..."))  # gen_ai.*/ratel.* only
```

Pass `span_filter=lambda _s: True` (or your own predicate) to override the default;
`ratel_span_exporter()` is the bare OTLP exporter if you want to wire your own processor.
Note that per-span filtering can orphan the AI SDK's `ai.*` wrapper from its `gen_ai.*` child;
send everything (or tail-sample) when you need full-trace fidelity rather than just the
gen_ai/ratel metrics.

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
endpoint/auth resolution, its already-registered guard and the content-capture gate, the
`ratel_signal_filter` predicate and that `ratel_span_processor` forwards only the spans it
passes, a purity guard that importing the package pulls no OTel, and the shared
contract-against-the-pin conformance in
[`../conformance/`](../conformance/README.md) (spans built from these constants through the
real SDK must emit the exact pinned keys).
