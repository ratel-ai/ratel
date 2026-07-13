"""The OTLP exporter surface over the standard OpenTelemetry Python SDK.

Two entry points, no custom transport and no schema (ADR-0007, CONVENTIONS.md § init()
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
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, Protocol, cast

from . import CAPTURE_CONTENT_ENV

if TYPE_CHECKING:
    from opentelemetry.sdk.trace import ReadableSpan, SpanProcessor
    from opentelemetry.sdk.trace.export import SpanExporter


class TelemetryHandle(Protocol):
    """What init() returns: a shutdown handle, not a full provider.

    Both the enabled path (a live TracerProvider) and the disabled/no-op path satisfy this,
    so the return type is honest either way. Emit spans through the global OpenTelemetry API
    (``opentelemetry.trace.get_tracer(...)``), not off this handle — init() registers the
    provider globally.
    """

    def shutdown(self) -> Any: ...

    def force_flush(self, timeout_millis: int = 30_000) -> bool: ...


#: Env var whose value is the default OTLP endpoint.
ENDPOINT_ENV = "RATEL_URL"

#: Env var whose value is the default API key when api_key= is omitted.
API_KEY_ENV = "RATEL_API_KEY"

#: service.name used when the caller does not pass one.
DEFAULT_SERVICE_NAME = "ratel"

#: Raised when a function needs the OpenTelemetry SDK but the [otlp] extra is absent.
_EXTRA_HINT = (
    "ratel telemetry needs the OpenTelemetry SDK. Install the extra: "
    "pip install 'ratel-ai-telemetry[otlp]'."
)

# Stable attribute used to recognize the provider Ratel installed, including after this
# module is reloaded. Its value is the provider itself, so the check is class-identity-free
# (survives importlib.reload, which rebinds this module's classes).
_PROVIDER_HANDLE_ATTR = "_ratel_ai_telemetry_handle"

# Set True on the provider once its handle's shutdown() runs, so a later init() reports the
# terminal state loudly instead of silently handing back a provider whose exporter is dead.
_PROVIDER_SHUTDOWN_ATTR = "_ratel_ai_telemetry_shutdown"


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

    Accepts either api_key= (falling back to RATEL_API_KEY; endpoint defaults to
    RATEL_URL; Authorization: Bearer) or endpoint=/headers= (custom endpoint /
    collector). The forms compose: explicit endpoint/api_key values win over their
    environment fallbacks. An explicit api_key sets the Bearer header; the RATEL_API_KEY
    fallback applies only when neither api_key nor an explicit Authorization header is
    given, so ambient env never clobbers auth the caller set on purpose. env is injectable
    so the precedence is testable without a network.
    """
    resolved_env = os.environ if env is None else env
    url = endpoint if endpoint is not None else resolved_env.get(ENDPOINT_ENV)
    if not url:
        raise ValueError(
            f"ratel telemetry init: no endpoint. Pass endpoint= or set {ENDPOINT_ENV} "
            f"(use api_key= or {API_KEY_ENV} for Bearer auth)."
        )
    resolved_headers: dict[str, str] = dict(headers or {})
    if api_key:
        resolved_headers["Authorization"] = f"Bearer {api_key}"
    elif resolved_env.get(API_KEY_ENV) and not _has_authorization_header(resolved_headers):
        resolved_headers["Authorization"] = f"Bearer {resolved_env[API_KEY_ENV]}"
    return OtlpConfig(
        url=url,
        headers=resolved_headers,
        service_name=service_name or DEFAULT_SERVICE_NAME,
    )


def _has_authorization_header(headers: Mapping[str, str]) -> bool:
    """Whether the caller already supplied an Authorization header (any casing)."""
    return any(key.lower() == "authorization" for key in headers)


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


class _NoOpSpanProcessor:
    """OTel-free disabled-mode processor with the standard lifecycle surface."""

    def on_start(self, span: object, parent_context: object | None = None) -> None:
        return None

    def on_end(self, span: object) -> None:
        return None

    def shutdown(self) -> None:
        return None

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return True


class _NoOpHandle:
    """OTel-free disabled-mode shutdown handle: the same surface as init()'s live return."""

    def shutdown(self) -> None:
        return None

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return True


def _owned_provider(provider: object) -> object | None:
    """Return the Ratel-owned provider, if this is ours (identity marker, reload-safe)."""
    handle = getattr(provider, _PROVIDER_HANDLE_ATTR, None)
    return handle if handle is provider else None


def _foreign_provider_error() -> RuntimeError:
    return RuntimeError(
        "ratel telemetry init(): an OpenTelemetry TracerProvider is already registered "
        "globally, so init() (the turnkey path that owns the provider) cannot take over. "
        "To send Ratel telemetry alongside an existing provider (e.g. Langfuse + the Vercel "
        "AI SDK), add ratel_span_processor(api_key=...) to that provider instead of init()."
    )


def _already_shut_down_error() -> RuntimeError:
    return RuntimeError(
        "ratel telemetry init(): telemetry was already shut down in this process. The "
        "OpenTelemetry global tracer provider is set once per process, so re-initialization "
        "after shutdown is not supported — init() once and shut down only at process exit."
    )


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
    enabled: bool = True,
) -> SpanProcessor:
    """A BatchSpanProcessor over the Ratel OTLP exporter that forwards only the spans passing
    span_filter (default ratel_signal_filter; pass ``lambda _s: True`` to forward everything).

    Add it to your own provider (``provider.add_span_processor(ratel_span_processor(...))``) to
    send Ratel telemetry alongside another provider — no global side effects, no resource.
    Greenfield apps that want Ratel to own the provider should call init() instead. Pass
    enabled=False for an OTel-free no-op processor that needs no endpoint. Enabled processors
    need the [otlp] extra and raise a clear error without it.
    """
    if not enabled:
        return cast("SpanProcessor", _NoOpSpanProcessor())

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
    span_filter: SpanFilter | None = None,
    enabled: bool = True,
) -> TelemetryHandle:
    """Wire an OTLP http/protobuf exporter + batch processor + service.name resource,
    register it as the global tracer provider, and return a shutdown handle (call
    handle.shutdown() / handle.force_flush()). Emit spans through the global OTel API
    (``opentelemetry.trace.get_tracer(...)``); everything else is the untouched OTel SDK.

    init() owns the global provider, so it exports every span by default (unlike
    ratel_span_processor, whose default gen_ai.*/ratel.* filter exists for sharing a provider);
    pass span_filter to narrow it. Repeated calls return the original Ratel-owned handle. It
    raises — pointing at ratel_span_processor — if a foreign provider is already registered
    globally. On first setup, pass enabled=False for an OTel-free no-op handle that needs no
    endpoint; once Ratel owns the provider, repeated calls return it regardless of options.
    Enabled initialization needs the [otlp] extra and raises a clear error without it.

    Shutdown is terminal: after handle.shutdown(), a later init() raises rather than hand back
    the dead provider (OTel's global provider is set once per process). Note that the handle is
    shared across repeated calls, so shutting it down stops export for every caller.
    """
    if not enabled:
        # Preserve an already-active, live Ratel provider without importing OTel on the
        # genuinely disabled/base-only path. A prior successful init loaded this module already.
        trace_module = sys.modules.get("opentelemetry.trace")
        if trace_module is not None:
            current_provider = trace_module.get_tracer_provider()
            owned = _owned_provider(current_provider)
            if owned is not None and not getattr(owned, _PROVIDER_SHUTDOWN_ATTR, False):
                return cast("TelemetryHandle", owned)
        return _NoOpHandle()

    try:
        from opentelemetry import trace
        from opentelemetry.sdk.resources import SERVICE_NAME, Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.trace import ProxyTracerProvider
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError(_EXTRA_HINT) from exc
    # get_tracer_provider() returns the default ProxyTracerProvider until someone installs a
    # real one. Re-entry returns the exact handle Ratel installed; any other real provider
    # belongs to the caller and remains a loud composition error.
    current_provider = trace.get_tracer_provider()
    owned = _owned_provider(current_provider)
    if owned is not None:
        if getattr(owned, _PROVIDER_SHUTDOWN_ATTR, False):
            raise _already_shut_down_error()
        return cast("TelemetryHandle", owned)
    if not isinstance(current_provider, ProxyTracerProvider):
        raise _foreign_provider_error()
    cfg = resolve_otlp_config(
        api_key=api_key, endpoint=endpoint, headers=headers, service_name=service_name
    )
    provider = TracerProvider(resource=Resource.create({SERVICE_NAME: cfg.service_name}))
    provider.add_span_processor(
        ratel_span_processor(
            api_key=api_key,
            endpoint=endpoint,
            headers=headers,
            span_filter=_accept_all_spans if span_filter is None else span_filter,
        )
    )
    setattr(provider, _PROVIDER_HANDLE_ATTR, provider)
    _mark_shutdown_on_teardown(provider)
    trace.set_tracer_provider(provider)
    winner = trace.get_tracer_provider()
    if winner is not provider:
        # Lost a first-init race (OTel's global is set-once). If the winner is Ratel's own
        # provider, honor idempotence and return it; only a truly foreign winner is an error.
        provider.shutdown()
        owned_winner = _owned_provider(winner)
        if owned_winner is not None:
            return cast("TelemetryHandle", owned_winner)
        raise _foreign_provider_error()
    return cast("TelemetryHandle", provider)


def _mark_shutdown_on_teardown(provider: object) -> None:
    """Wrap the provider's shutdown so it flags the provider as torn down.

    One-time, single-owner wrap set at provider creation (unlike the removed multi-generation
    shutdown mutation): it only records terminal state so a later init() fails loud instead of
    returning a provider whose exporter is already stopped.
    """
    # provider is typed `object` (the SDK class is a lazy import); the attribute name goes
    # through a variable so getattr/setattr stay dynamic (and ruff does not rewrite them to
    # attribute access that would not type-check).
    shutdown_name = "shutdown"
    original_shutdown = getattr(provider, shutdown_name)

    def _shutdown() -> Any:
        try:
            return original_shutdown()
        finally:
            setattr(provider, _PROVIDER_SHUTDOWN_ATTR, True)

    setattr(provider, shutdown_name, _shutdown)


class ContentCapture(str, Enum):
    """Message/tool content capture modes for
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT (CONVENTIONS.md § Capture
    gating). Default off.
    """

    NO_CONTENT = "NO_CONTENT"
    SPAN_ONLY = "SPAN_ONLY"
    EVENT_ONLY = "EVENT_ONLY"
    SPAN_AND_EVENT = "SPAN_AND_EVENT"


#: Module-level programmatic override; None means unset (env-driven).
_content_capture_override: ContentCapture | None = None

#: Monotonically increasing token identifying the most recent set_content_capture call,
#: so a stale holder (e.g. an old telemetry handle's shutdown) cannot clear an override a
#: newer caller owns via clear_content_capture.
_content_capture_generation = 0


def _parse_content_capture(raw: str) -> ContentCapture | None:
    """The single normalizer for capture-mode strings, shared by the env parser and the
    programmatic setter: trim + case-insensitive, with the legacy boolean forms (true/1
    -> full capture, false/0 -> none). None when unrecognized — the two callers diverge
    there (content_capture_mode defaults, set_content_capture raises).
    """
    normalized = raw.strip().upper()
    if normalized in ("NO_CONTENT", "FALSE", "0"):
        return ContentCapture.NO_CONTENT
    if normalized == "SPAN_ONLY":
        return ContentCapture.SPAN_ONLY
    if normalized == "EVENT_ONLY":
        return ContentCapture.EVENT_ONLY
    if normalized in ("SPAN_AND_EVENT", "TRUE", "1"):
        return ContentCapture.SPAN_AND_EVENT
    return None


def set_content_capture(mode: ContentCapture | str | None) -> int:
    """Programmatically set the content-capture mode. While set, content_capture_mode()
    returns this mode regardless of OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT —
    programmatic config wins over the environment, matching how OpenTelemetry treats env
    vars as the fallback for code-level configuration. Pass None to clear the override
    unconditionally and return to env-driven parsing.

    The mode is validated like the env var (case-insensitive, legacy true/false/1/0
    accepted) and raises a ValueError on anything unrecognized — failing loud at config
    time instead of storing a value that would both disable capture and mask the env var.

    Returns a generation token identifying this call as the current owner of the override;
    pass it to clear_content_capture to clear only if no newer set has happened since (the
    safe form for shutdown/teardown hooks).
    """
    global _content_capture_override, _content_capture_generation
    if mode is None:
        _content_capture_override = None
        _content_capture_generation += 1
        return _content_capture_generation
    parsed = _parse_content_capture(mode)
    if parsed is None:
        valid = ", ".join(member.value for member in ContentCapture)
        raise ValueError(
            f"set_content_capture: unrecognized mode {mode!r}. Valid values: {valid} "
            "(case-insensitive; legacy true/false/1/0 also accepted), or None to clear."
        )
    _content_capture_override = parsed
    _content_capture_generation += 1
    return _content_capture_generation


def clear_content_capture(generation: int) -> None:
    """Clear the programmatic content-capture override, but only when generation — the
    token returned by set_content_capture — still identifies the most recent set. A stale
    token no-ops, so an old handle shutting down late cannot clobber an override a newer
    caller installed (and silently re-enable, or disable, capture via the env fallback).
    For an unconditional clear, use set_content_capture(None).
    """
    global _content_capture_override
    if generation != _content_capture_generation:  # a newer set owns the slot
        return
    _content_capture_override = None


def content_capture_mode(env: Mapping[str, str] | None = None) -> ContentCapture:
    """Parse the ecosystem content-capture gate. A mode set via set_content_capture wins
    outright (env is the fallback, as in OTel); otherwise defaults to NO_CONTENT when
    unset/empty/unrecognized. The legacy boolean form maps true to full capture
    (SPAN_AND_EVENT) and false to none.
    """
    if _content_capture_override is not None:
        return _content_capture_override
    resolved_env = os.environ if env is None else env
    raw = resolved_env.get(CAPTURE_CONTENT_ENV)
    if raw is None or raw.strip() == "":
        return ContentCapture.NO_CONTENT
    parsed = _parse_content_capture(raw)
    return parsed if parsed is not None else ContentCapture.NO_CONTENT
