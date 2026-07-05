# `examples/telemetry-python` — emit `ratel.*` telemetry with OpenTelemetry (Python)

The Python mirror of [`examples/telemetry-ts`](../telemetry-ts/README.md): how to emit Ratel's telemetry vocabulary through the standard [OpenTelemetry Python SDK](https://opentelemetry.io/docs/languages/python/) using [`ratel-ai-telemetry`](../../src/telemetry/python/README.md). Ratel telemetry *is* OpenTelemetry ([ADR-0015](../../docs/adr/0015-telemetry-otel-conventions.md)): the package ships no transport and no schema, just the `ratel.*` constants and value enums you set as span attributes, plus an `init()` helper that wires the OTLP exporter.

The demo emits one realistic trace — a `ratel.search` (capability search) span followed by an `execute_tool` span enriched with the `ratel.*` overlay — and prints it with a `ConsoleSpanExporter`, so it runs offline with no collector and no API key.

## Setup

```bash
uv run main.py
```

`uv run` resolves `ratel-ai-telemetry` from this monorepo (see `[tool.uv.sources]` in `pyproject.toml`) and the OTel SDK from PyPI, then runs `main.py`. It prints the two spans (with their `ratel.*` / `gen_ai.*` attributes) and the config `init()` would use in production.

To export a real trace instead of printing, set the endpoint and run again:

```bash
export RATEL_URL=https://ingest.ratel.sh/v1/traces
export RATEL_API_KEY=sk-...          # optional; sent as Authorization: Bearer
uv run main.py
```

## What it illustrates

- **The vocabulary is just constants.** `RATEL_SEARCH`, `EXECUTE_TOOL`, `RATEL_ORIGIN`, `GEN_AI_TOOL_NAME`, … are imported from `ratel_ai_telemetry` and set as attributes on stock OTel spans. `Origin` / `SearchTarget` are `str`-enums, so each member equals its exact wire string (`Origin.AGENT.value == "agent"`, and `Origin.AGENT` is itself usable as an attribute value).
- **Tool calls are standard `gen_ai` spans.** The invocation is an `execute_tool` span (so any OTel backend understands it), enriched with `ratel.*` attributes — not a bespoke Ratel span.
- **`init()` is optional sugar.** `resolve_otlp_config()` (pure, shown in the output) resolves the endpoint + `Authorization` header; `init()` wires that into an OTLP `http/protobuf` exporter and returns the provider as a shutdown handle. A caller already running the OTel SDK skips `init()` and takes only the constants.
- **Content capture is gated.** `content_capture_mode()` reads `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` (default `NO_CONTENT`).

## Layout

```
main.py    emit_ratel_trace() — builds the two spans from the constants; main() wires the exporter and prints
```
