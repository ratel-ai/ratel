"""OpenTelemetry emission for the SDK funnel — the Python mirror of
`src/sdk/ts/src/telemetry.ts` (ADR-0011, ADR-0007).

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
    """Wrap a tool invocation in a standard `execute_tool` span (`gen_ai.operation.name
    = execute_tool`, enriched with `ratel.*`) — the OTel gen_ai tool operation, so a
    generic backend understands it (ADR-0007). No-op pass-through when disabled.
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
    """Wrap a capability search (tool or skill) in a `ratel.search` span. Synchronous:
    the native BM25 search returns inline; the hit count becomes `ratel.search.hit_count`.
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
    """Wrap an upstream-MCP registration in a `ratel.upstream.register` span. `run`
    receives a `report_tool_count` callback to set `ratel.upstream.tool_count` once the
    tool list is known.
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
    """Mark an upstream tool call that failed with a 401 / needs-reauthorization: a
    short `ratel.auth.flow` span carrying `ratel.auth.outcome = needs_auth`.
    """
    if not _ENABLED:
        return
    span = _tracer().start_span(RATEL_AUTH_FLOW, kind=SpanKind.INTERNAL)
    if server:
        span.set_attribute(RATEL_UPSTREAM_SERVER, server)
    span.set_attribute(RATEL_AUTH_OUTCOME, AuthOutcome.NEEDS_AUTH.value)
    span.end()


def configure_telemetry(
    *,
    api_key: str | None = None,
    endpoint: str | None = None,
    headers: dict[str, str] | None = None,
    service_name: str | None = None,
) -> Any:
    """Convenience wiring for the greenfield case: register a Ratel-owned OTLP exporter
    so the spans this SDK emits are shipped to Ratel Cloud (or any OTLP endpoint).
    Delegates to `ratel_ai_telemetry.init`, which needs the OpenTelemetry SDK — install
    it with ``pip install 'ratel-ai[otlp]'``. A host already running its own OpenTelemetry
    provider should skip this (the SDK's spans flow to that provider) and add
    `ratel_span_processor` from `ratel_ai_telemetry`. Returns the provider as a shutdown
    handle (``provider.shutdown()`` / ``provider.force_flush()``).
    """
    try:
        from ratel_ai_telemetry import init
    except ModuleNotFoundError as exc:  # pragma: no cover - exercised only without the extra
        raise ModuleNotFoundError(
            "configure_telemetry() needs the OpenTelemetry exporter. Install the extra: "
            "pip install 'ratel-ai[otlp]' — or register your own OpenTelemetry provider, "
            "since the SDK emits ratel.*/gen_ai.* spans to whatever provider is active."
        ) from exc
    return init(api_key=api_key, endpoint=endpoint, headers=headers, service_name=service_name)
