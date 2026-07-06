"""examples/telemetry-python — emit Ratel's `ratel.*` telemetry through the standard
OpenTelemetry Python SDK. The Python mirror of `examples/telemetry-ts/src/index.ts`.

Runnable offline: it wires a ConsoleSpanExporter so the spans print to stdout (no
collector, no API key). The only Ratel-specific part is the vocabulary from
`ratel_ai_telemetry` — the constants and value enums you set as span attributes. In
production you swap the console exporter for `init()` (shown at the end), which wires
the OTLP exporter to RATEL_URL; everything else stays identical.

    uv run main.py                       # print the spans (offline)
    RATEL_URL=... uv run main.py         # export a real trace via init()
"""

from __future__ import annotations

import os

from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SimpleSpanProcessor
from opentelemetry.trace import Tracer

from ratel_ai_telemetry import (
    CAPTURE_CONTENT_ENV,
    EXECUTE_TOOL,
    GEN_AI_OPERATION_NAME,
    GEN_AI_TOOL_NAME,
    RATEL_ORIGIN,
    RATEL_SEARCH,
    RATEL_SEARCH_HIT_COUNT,
    RATEL_SEARCH_TARGET,
    RATEL_SEARCH_TOP_K,
    RATEL_TOOL_ARGS_SIZE_BYTES,
    RATEL_UPSTREAM_SERVER,
    RATEL_UPSTREAM_TRANSPORT,
    SEMCONV_VERSION,
    Origin,
    SearchTarget,
)

# init() + the OTLP config live in the .otlp submodule (the [otlp] extra) so the
# vocabulary above stays OTel-free.
from ratel_ai_telemetry.otlp import (
    DEFAULT_SERVICE_NAME,
    content_capture_mode,
    init,
    resolve_otlp_config,
)


def emit_ratel_trace(tracer: Tracer) -> None:
    """Emit one realistic Ratel trace: a ratel.search (capability search) span
    followed by an execute_tool span enriched with the ratel.* overlay. This is the
    pattern you copy into your own agent — only the constants come from Ratel; the
    tracer is the stock OTel SDK.
    """
    # 1. Capability search — the agent asks Ratel which tools fit the prompt.
    #    Origin / SearchTarget are str-enums, so .value is the exact wire string.
    search = tracer.start_span(
        RATEL_SEARCH,
        attributes={
            RATEL_ORIGIN: Origin.AGENT.value,  # synthesized inside the agent loop
            RATEL_SEARCH_TARGET: SearchTarget.TOOL.value,
            RATEL_SEARCH_TOP_K: 5,
            RATEL_SEARCH_HIT_COUNT: 2,
        },
    )
    search.end()

    # 2. Tool invocation — a standard gen_ai execute_tool span (so any OTel backend
    #    understands it) enriched with ratel.* attributes.
    invoke = tracer.start_span(
        EXECUTE_TOOL,
        attributes={
            GEN_AI_OPERATION_NAME: EXECUTE_TOOL,
            GEN_AI_TOOL_NAME: "send_email",
            RATEL_ORIGIN: Origin.AGENT.value,
            RATEL_TOOL_ARGS_SIZE_BYTES: 128,
            RATEL_UPSTREAM_SERVER: "gmail",
            RATEL_UPSTREAM_TRANSPORT: "stdio",
        },
    )
    invoke.end()


def main() -> None:
    print(f"ratel-ai-telemetry — semconv pin {SEMCONV_VERSION}")
    print(f"content capture: {content_capture_mode().value} (gated by {CAPTURE_CONTENT_ENV})\n")

    # --- The runnable demo: emit spans to the console (no network) ---
    provider = TracerProvider(resource=Resource.create({SERVICE_NAME: "ratel-telemetry-example"}))
    provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))
    tracer = provider.get_tracer("ratel-example-telemetry")

    print("--- emitting a ratel.search + execute_tool trace ---")
    emit_ratel_trace(tracer)
    provider.force_flush()
    provider.shutdown()

    # --- Production wiring: the same spans, exported to Ratel via init() ---
    # resolve_otlp_config is pure (no network), so we can show how endpoint + auth
    # resolve without sending anything:
    cfg = resolve_otlp_config(api_key="sk-demo", endpoint="https://ingest.ratel.sh/v1/traces")
    print("\n--- production init() would export to ---")
    print(f"  url:          {cfg.url}")
    print(f"  service_name: {cfg.service_name} (default {DEFAULT_SERVICE_NAME})")
    print(f"  headers:      {', '.join(cfg.headers) or '(none)'}")

    # If RATEL_URL is set, actually wire the real OTLP exporter and emit through it.
    if os.environ.get("RATEL_URL"):
        print(f"\n--- RATEL_URL set — exporting a real trace to {os.environ['RATEL_URL']} ---")
        from opentelemetry import trace

        real_provider = init(api_key=os.environ.get("RATEL_API_KEY"))
        emit_ratel_trace(trace.get_tracer("ratel-example-telemetry"))
        real_provider.shutdown()
    else:
        print("\n(set RATEL_URL — and optionally RATEL_API_KEY — to export a real trace via init())")

    print("\nOK")


if __name__ == "__main__":
    main()
