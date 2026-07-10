"""OpenTelemetry emission for the SDK funnel (ADR-0007).

The Python mirror of `src/sdk/ts/src/telemetry.ts`.

The catalog / capability-tool / skill / MCP paths call these helpers to open a span around
each operation, alongside the local `record_event` stream (untouched). Span names
and attribute keys come from the OTel-free `ratel_ai_telemetry` vocabulary.

Emission is **transparent and optional**: the OpenTelemetry API and the vocabulary
are imported lazily. If neither is installed (the base `ratel-ai` install), every
helper is a straight pass-through — zero overhead, no spans. Installing
`ratel-ai[otlp]` (or having OpenTelemetry present) lights emission up; spans then go
to whatever provider is registered, exactly as a host deployment wires it. Content
(`ratel.search.query`, tool args/result) rides span attributes only when the
ecosystem capture gate is on (default off).
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

try:
    from opentelemetry import trace as _otel_trace
    from opentelemetry.trace import SpanKind, Status, StatusCode
    from ratel_ai_telemetry import (
        EXECUTE_TOOL,
        GEN_AI_OPERATION_NAME,
        GEN_AI_TOOL_CALL_ARGUMENTS,
        GEN_AI_TOOL_CALL_RESULT,
        GEN_AI_TOOL_NAME,
        RATEL_AUTH_FLOW,
        RATEL_AUTH_OUTCOME,
        RATEL_ORIGIN,
        RATEL_SEARCH,
        RATEL_SEARCH_HIT_COUNT,
        RATEL_SEARCH_QUERY,
        RATEL_SEARCH_TARGET,
        RATEL_SEARCH_TOP_K,
        RATEL_SKILL_ID,
        RATEL_SKILL_LOAD,
        RATEL_TOOL_ARGS_SIZE_BYTES,
        RATEL_UPSTREAM_REGISTER,
        RATEL_UPSTREAM_SERVER,
        RATEL_UPSTREAM_TOOL_COUNT,
        RATEL_UPSTREAM_TRANSPORT,
        AuthOutcome,
        ContentCapture,
        content_capture_mode,
    )

    _ENABLED = True
except ModuleNotFoundError:
    _ENABLED = False

_TRACER_NAME = "ratel-ai"

#: `ratel.search.target` values (mirror `SearchTarget` without a hard import at the
#: call sites, so the catalog modules stay dependency-free when telemetry is absent).
SEARCH_TARGET_TOOL = "tool"
SEARCH_TARGET_SKILL = "skill"

T = TypeVar("T")


def _tracer() -> Any:
    return _otel_trace.get_tracer(_TRACER_NAME)


def _capture_content_on_span() -> bool:
    mode = content_capture_mode()
    return mode in (ContentCapture.SPAN_ONLY, ContentCapture.SPAN_AND_EVENT)


def _args_size_bytes(args: Any) -> int:
    try:
        return len(json.dumps(args))
    except Exception:
        return 0


def _safe_json(value: Any) -> str:
    try:
        return json.dumps(value)
    except Exception:
        return ""


async def trace_execute_tool(
    tool_id: str,
    args: dict[str, Any],
    run: Callable[[], Awaitable[T]],
) -> T:
    """Wrap a tool invocation in a standard `execute_tool` span.

    The OTel gen_ai tool operation (`gen_ai.operation.name = execute_tool`,
    enriched with `ratel.*`), so a generic backend understands it (ADR-0007).
    No-op pass-through when telemetry is disabled.
    """
    if not _ENABLED:
        return await run()
    with _tracer().start_as_current_span(
        f"{EXECUTE_TOOL} {tool_id}", kind=SpanKind.INTERNAL
    ) as span:
        span.set_attribute(GEN_AI_OPERATION_NAME, EXECUTE_TOOL)
        span.set_attribute(GEN_AI_TOOL_NAME, tool_id)
        span.set_attribute(RATEL_TOOL_ARGS_SIZE_BYTES, _args_size_bytes(args))
        if _capture_content_on_span():
            span.set_attribute(GEN_AI_TOOL_CALL_ARGUMENTS, _safe_json(args))
        # start_as_current_span records the exception + sets ERROR status on raise.
        result = await run()
        if _capture_content_on_span():
            span.set_attribute(GEN_AI_TOOL_CALL_RESULT, _safe_json(result))
        span.set_status(Status(StatusCode.OK))
        return result


def trace_search(
    target: str,
    query: str,
    top_k: int,
    origin: str,
    run: Callable[[], T],
) -> T:
    """Wrap a capability search (tool or skill) in a `ratel.search` span.

    Synchronous: the native BM25 search returns inline; the hit count becomes
    `ratel.search.hit_count`.
    """
    if not _ENABLED:
        return run()
    with _tracer().start_as_current_span(RATEL_SEARCH, kind=SpanKind.INTERNAL) as span:
        span.set_attribute(RATEL_SEARCH_TARGET, target)
        span.set_attribute(RATEL_SEARCH_TOP_K, top_k)
        span.set_attribute(RATEL_ORIGIN, origin)
        if _capture_content_on_span():
            span.set_attribute(RATEL_SEARCH_QUERY, query)
        hits = run()
        span.set_attribute(RATEL_SEARCH_HIT_COUNT, len(hits))  # type: ignore[arg-type]
        span.set_status(Status(StatusCode.OK))
        return hits


def trace_skill_load(skill_id: str, run: Callable[[], T]) -> T:
    """Wrap a skill-content load in a `ratel.skill.load` span."""
    if not _ENABLED:
        return run()
    with _tracer().start_as_current_span(RATEL_SKILL_LOAD, kind=SpanKind.INTERNAL) as span:
        span.set_attribute(RATEL_SKILL_ID, skill_id)
        body = run()
        span.set_status(Status(StatusCode.OK))
        return body


async def trace_upstream_register(
    server: str,
    transport: str,
    run: Callable[[Callable[[int], None]], Awaitable[T]],
) -> T:
    """Wrap an upstream-MCP registration in a `ratel.upstream.register` span.

    `run` receives a `report_tool_count` callback to set
    `ratel.upstream.tool_count` once the tool list is known.
    """
    if not _ENABLED:
        return await run(lambda _n: None)
    with _tracer().start_as_current_span(RATEL_UPSTREAM_REGISTER, kind=SpanKind.INTERNAL) as span:
        span.set_attribute(RATEL_UPSTREAM_SERVER, server)
        span.set_attribute(RATEL_UPSTREAM_TRANSPORT, transport)
        result = await run(lambda n: span.set_attribute(RATEL_UPSTREAM_TOOL_COUNT, n))
        span.set_status(Status(StatusCode.OK))
        return result


def record_auth_needed(server: str | None = None) -> None:
    """Mark an upstream tool call that failed with a 401 / needs-reauthorization.

    Emits a short `ratel.auth.flow` span carrying `ratel.auth.outcome = needs_auth`.
    """
    if not _ENABLED:
        return
    span = _tracer().start_span(RATEL_AUTH_FLOW, kind=SpanKind.INTERNAL)
    if server:
        span.set_attribute(RATEL_UPSTREAM_SERVER, server)
    span.set_attribute(RATEL_AUTH_OUTCOME, AuthOutcome.NEEDS_AUTH.value)
    span.end()


def _resolve_capture_override(
    capture_content: ContentCapture | str | None,
    include_span_and_events: bool | None,
) -> ContentCapture | str | None:
    """The capture mode configure_telemetry should set, or None to leave the gate
    env-driven: `capture_content` wins over `include_span_and_events`. The bool sugar maps
    to the wire strings set_content_capture normalizes (True -> full capture, False -> none).
    """
    if capture_content is not None:
        return capture_content
    if include_span_and_events is not None:
        return "SPAN_AND_EVENT" if include_span_and_events else "NO_CONTENT"
    return None


def configure_telemetry(
    *,
    api_key: str | None = None,
    endpoint: str | None = None,
    headers: dict[str, str] | None = None,
    service_name: str | None = None,
    capture_content: ContentCapture | str | None = None,
    include_span_and_events: bool | None = None,
) -> Any:
    """Register a Ratel-owned OTLP exporter (convenience wiring for the greenfield case).

    Ships the spans this SDK emits to Ratel Cloud (or any OTLP endpoint) by
    delegating to `ratel_ai_telemetry.init`, which needs the OpenTelemetry SDK —
    install it with ``pip install 'ratel-ai[otlp]'``. A host already running its
    own OpenTelemetry provider should skip this (the SDK's spans flow to that
    provider) and add `ratel_span_processor` from `ratel_ai_telemetry`.

    ``capture_content`` / ``include_span_and_events`` opt into message/tool content
    capture in code via `set_content_capture`: ``capture_content`` sets an exact mode,
    ``include_span_and_events`` is bool sugar (True -> ``SPAN_AND_EVENT``, False ->
    ``NO_CONTENT``); ``capture_content`` wins when both are given. A provided option
    beats ``OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`` (the env var is the
    fallback when neither is given, as in OTel). The returned handle's ``shutdown()``
    clears the override, restoring env-driven behavior; the clear is
    generation-scoped, so a stale handle shutting down late never clobbers an
    override a newer `configure_telemetry`/`set_content_capture` call installed.

    Args:
        api_key: Ratel Cloud API key; omit when exporting to a self-hosted endpoint.
        endpoint: OTLP endpoint override; defaults to the Ratel Cloud collector.
        headers: Extra headers sent with every export request.
        service_name: ``service.name`` resource attribute; defaults per `init`.
        capture_content: Exact content-capture mode to set (see above).
        include_span_and_events: Boolean sugar for `capture_content` (see above).

    Returns:
        The provider, usable as a shutdown handle (``provider.shutdown()`` /
        ``provider.force_flush()``).

    Raises:
        ModuleNotFoundError: if the OpenTelemetry exporter is not installed
            (``pip install 'ratel-ai[otlp]'``).
        ValueError: if `capture_content` is not a recognized mode — raised before
            any exporter is wired, so a bad option has no side effects.
    """
    try:
        from ratel_ai_telemetry import clear_content_capture, init, set_content_capture
    except ModuleNotFoundError as exc:  # pragma: no cover - exercised only without the extra
        raise ModuleNotFoundError(
            "configure_telemetry() needs the OpenTelemetry exporter. Install the extra: "
            "pip install 'ratel-ai[otlp]' — or register your own OpenTelemetry provider, "
            "since the SDK emits ratel.*/gen_ai.* spans to whatever provider is active."
        ) from exc

    capture = _resolve_capture_override(capture_content, include_span_and_events)
    if capture is None:
        # No override: the env var keeps ruling; nothing to set or undo.
        return init(api_key=api_key, endpoint=endpoint, headers=headers, service_name=service_name)

    # Apply (and validate — an unrecognized mode raises ValueError) the override *before*
    # wiring the exporter, so a bad option fails loud with no provider side effects; unwind
    # it if init() itself raises.
    generation = set_content_capture(capture)
    try:
        provider = init(
            api_key=api_key, endpoint=endpoint, headers=headers, service_name=service_name
        )
    except BaseException:
        clear_content_capture(generation)
        raise

    # Wrap shutdown so it restores env-driven behavior. Generation-scoped: a stale handle
    # shutting down late must not clobber an override a newer configure_telemetry/
    # set_content_capture owns by then.
    original_shutdown = provider.shutdown

    def shutdown_and_clear() -> Any:
        clear_content_capture(generation)
        return original_shutdown()

    provider.shutdown = shutdown_and_clear
    return provider
