"""init() OTLP builder over the standard OpenTelemetry Python SDK.

Sugar that wires an OTLP http/protobuf span exporter at the Ratel endpoint: no
custom transport, no schema (ADR-0015, CONVENTIONS.md § init() surface). A caller
already running the OTel SDK skips init() and just takes the ratel.* constants.

The OpenTelemetry SDK is an optional [otlp] extra: this module imports it lazily,
inside init(), so the config/gate helpers (resolve_otlp_config, content_capture_mode)
and this whole submodule import OTel-free. Only calling init() needs the extra.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING

from . import CAPTURE_CONTENT_ENV

if TYPE_CHECKING:
    from opentelemetry.sdk.trace import TracerProvider

#: Env var whose value is the default OTLP endpoint when api_key= is used.
ENDPOINT_ENV = "RATEL_URL"

#: service.name used when the caller does not pass one.
DEFAULT_SERVICE_NAME = "ratel"


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

    Needs the OpenTelemetry SDK, shipped as the optional [otlp] extra; a clear error
    is raised if it is not installed.
    """
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import SERVICE_NAME, Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError(
            "ratel telemetry init() needs the OpenTelemetry SDK. Install the extra: "
            "pip install 'ratel-ai-telemetry[otlp]'."
        ) from exc
    cfg = resolve_otlp_config(
        api_key=api_key, endpoint=endpoint, headers=headers, service_name=service_name
    )
    exporter = OTLPSpanExporter(endpoint=cfg.url, headers=dict(cfg.headers))
    provider = TracerProvider(resource=Resource.create({SERVICE_NAME: cfg.service_name}))
    provider.add_span_processor(BatchSpanProcessor(exporter))
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
