"""The OTLP exporter surface over the standard OpenTelemetry Python SDK.

Two entry points, no custom transport and no schema (ADR-0015, CONVENTIONS.md § init()
surface):

- ``init()`` — the turnkey greenfield path: wires an OTLP http/protobuf exporter and
  registers a provider Ratel owns.
- ``ratel_span_processor()`` / ``ratel_span_exporter()`` — compose Ratel onto a provider a
  partner already owns (Langfuse, the Vercel AI SDK, ...), since OpenTelemetry's
  coexistence model is one provider with many span-processors.

The OpenTelemetry SDK is an optional ``[otlp]`` extra: this module imports it lazily, inside
the functions that need it, so the config/gate helpers (``resolve_otlp_config``,
``content_capture_mode``, ``ratel_signal_filter``) and this whole submodule import OTel-free.
Only wiring an exporter needs the extra.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING

from . import CAPTURE_CONTENT_ENV

if TYPE_CHECKING:
    from opentelemetry.sdk.trace import ReadableSpan, SpanProcessor, TracerProvider
    from opentelemetry.sdk.trace.export import SpanExporter

#: Env var whose value is the default OTLP endpoint when api_key= is used.
ENDPOINT_ENV = "RATEL_URL"

#: service.name used when the caller does not pass one.
DEFAULT_SERVICE_NAME = "ratel"

#: Raised when a function needs the OpenTelemetry SDK but the [otlp] extra is absent.
_EXTRA_HINT = (
    "ratel telemetry needs the OpenTelemetry SDK. Install the extra: "
    "pip install 'ratel-ai-telemetry[otlp]'."
)


@dataclass(frozen=True)
class OtlpConfig:
    """Resolved exporter configuration; the pure core of init()."""

    url: str
    headers: dict[str, str]
    service_name: str


def resolve_otlp_config(
    *,
    api_key: str | None = None,
    endpoint: str | None = None,
    headers: Mapping[str, str] | None = None,
    service_name: str | None = None,
    env: Mapping[str, str] | None = None,
) -> OtlpConfig:
    """Resolve init() options into concrete exporter config.

    Accepts either api_key= (endpoint defaults to RATEL_URL, Authorization: Bearer)
    or endpoint=/headers= (custom endpoint / collector). The forms compose: an
    explicit endpoint wins over RATEL_URL, and api_key adds the Bearer header on top
    of any headers. env is injectable so the precedence is testable without a network.
    """
    resolved_env = os.environ if env is None else env
    url = endpoint if endpoint is not None else resolved_env.get(ENDPOINT_ENV)
    if not url:
        raise ValueError(
            f"ratel telemetry init: no endpoint. Pass endpoint= or set {ENDPOINT_ENV} "
            "(use api_key= for Bearer auth)."
        )
    resolved_headers: dict[str, str] = dict(headers or {})
    if api_key:
        resolved_headers["Authorization"] = f"Bearer {api_key}"
    return OtlpConfig(
        url=url,
        headers=resolved_headers,
        service_name=service_name or DEFAULT_SERVICE_NAME,
    )


#: Predicate deciding whether a finished span is forwarded to Ratel.
SpanFilter = Callable[["ReadableSpan"], bool]


def ratel_signal_filter(span: ReadableSpan) -> bool:
    """Default span filter: forward only signal-bearing spans — a ratel.* span name, or
    any attribute key under gen_ai.* / ratel.*.

    This is what lets Ratel share a provider with e.g. Langfuse + the Vercel AI SDK and
    ingest only the gen_ai/ratel signal (the AI SDK's gen_ai.* spans + Ratel's own
    ratel.search / execute_tool), dropping the framework's ai.* wrapper noise.
    """
    if span.name.startswith("ratel."):
        return True
    attributes = span.attributes or {}
    return any(key.startswith("gen_ai.") or key.startswith("ratel.") for key in attributes)


def _accept_all_spans(_span: ReadableSpan) -> bool:
    """The filter init() uses: it owns the provider, so it exports every span."""
    return True


def ratel_span_exporter(
    *,
    api_key: str | None = None,
    endpoint: str | None = None,
    headers: Mapping[str, str] | None = None,
) -> SpanExporter:
    """Build the OTLP http/protobuf span exporter at the resolved Ratel endpoint.

    The standalone exporter for callers wiring their own span-processor; ratel_span_processor
    batches over it. Carries no resource — the caller's provider owns service.name. Needs the
    [otlp] extra; raises a clear error otherwise.
    """
    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError(_EXTRA_HINT) from exc
    cfg = resolve_otlp_config(api_key=api_key, endpoint=endpoint, headers=headers)
    return OTLPSpanExporter(endpoint=cfg.url, headers=dict(cfg.headers))


def ratel_span_processor(
    *,
    api_key: str | None = None,
    endpoint: str | None = None,
    headers: Mapping[str, str] | None = None,
    span_filter: SpanFilter | None = None,
) -> SpanProcessor:
    """A BatchSpanProcessor over the Ratel OTLP exporter that forwards only the spans passing
    span_filter (default ratel_signal_filter; pass ``lambda _s: True`` to forward everything).

    Add it to your own provider (``provider.add_span_processor(ratel_span_processor(...))``) to
    send Ratel telemetry alongside another provider — no global side effects, no resource.
    Greenfield apps that want Ratel to own the provider should call init() instead. Needs the
    [otlp] extra; raises a clear error otherwise.
    """
    try:
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError(_EXTRA_HINT) from exc
    active_filter = span_filter or ratel_signal_filter
    exporter = ratel_span_exporter(api_key=api_key, endpoint=endpoint, headers=headers)

    class _RatelSpanProcessor(BatchSpanProcessor):
        def on_end(self, span: ReadableSpan) -> None:
            if active_filter(span):
                super().on_end(span)

    return _RatelSpanProcessor(exporter)


def init(
    *,
    api_key: str | None = None,
    endpoint: str | None = None,
    headers: Mapping[str, str] | None = None,
    service_name: str | None = None,
) -> TracerProvider:
    """Wire an OTLP http/protobuf exporter + batch processor + service.name resource,
    register it as the global tracer provider, and return it as the shutdown handle
    (call provider.shutdown() / provider.force_flush()). Everything else is the
    untouched OTel SDK.

    init() owns the global provider, so it exports every span (unlike ratel_span_processor,
    whose default gen_ai.*/ratel.* filter exists for sharing a provider). It raises — pointing
    at ratel_span_processor — rather than silently no-op'ing, if a provider is already
    registered globally. Needs the [otlp] extra; raises a clear error otherwise.
    """
    try:
        from opentelemetry import trace
        from opentelemetry.sdk.resources import SERVICE_NAME, Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.trace import ProxyTracerProvider
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError(_EXTRA_HINT) from exc
    # Resolve first so a missing endpoint raises ValueError before the guard.
    cfg = resolve_otlp_config(
        api_key=api_key, endpoint=endpoint, headers=headers, service_name=service_name
    )
    # get_tracer_provider() returns the default ProxyTracerProvider until someone installs a
    # real one; a non-proxy means another provider already owns the global.
    if not isinstance(trace.get_tracer_provider(), ProxyTracerProvider):
        raise RuntimeError(
            "ratel telemetry init(): an OpenTelemetry TracerProvider is already registered "
            "globally, so init() (the turnkey path that owns the provider) cannot take over. "
            "To send Ratel telemetry alongside an existing provider (e.g. Langfuse + the Vercel "
            "AI SDK), add ratel_span_processor(api_key=...) to that provider instead of init()."
        )
    provider = TracerProvider(resource=Resource.create({SERVICE_NAME: cfg.service_name}))
    provider.add_span_processor(
        ratel_span_processor(
            api_key=api_key, endpoint=endpoint, headers=headers, span_filter=_accept_all_spans
        )
    )
    trace.set_tracer_provider(provider)
    return provider


class ContentCapture(str, Enum):
    """Message/tool content capture modes for
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT (CONVENTIONS.md § Capture
    gating). Default off.
    """

    NO_CONTENT = "NO_CONTENT"
    SPAN_ONLY = "SPAN_ONLY"
    EVENT_ONLY = "EVENT_ONLY"
    SPAN_AND_EVENT = "SPAN_AND_EVENT"


def content_capture_mode(env: Mapping[str, str] | None = None) -> ContentCapture:
    """Parse the ecosystem content-capture gate. Defaults to NO_CONTENT when
    unset/empty/unrecognized. The legacy boolean form maps true to full capture
    (SPAN_AND_EVENT) and false to none.
    """
    resolved_env = os.environ if env is None else env
    raw = resolved_env.get(CAPTURE_CONTENT_ENV)
    if raw is None or raw.strip() == "":
        return ContentCapture.NO_CONTENT
    mapping = {
        "NO_CONTENT": ContentCapture.NO_CONTENT,
        "SPAN_ONLY": ContentCapture.SPAN_ONLY,
        "EVENT_ONLY": ContentCapture.EVENT_ONLY,
        "SPAN_AND_EVENT": ContentCapture.SPAN_AND_EVENT,
        "TRUE": ContentCapture.SPAN_AND_EVENT,
        "1": ContentCapture.SPAN_AND_EVENT,
    }
    return mapping.get(raw.strip().upper(), ContentCapture.NO_CONTENT)
