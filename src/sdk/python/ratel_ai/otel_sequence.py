"""⚠️ Experimental: learn tool sequences from a host framework's OpenTelemetry tool spans.

For a host that runs no Ratel framework adapter but already traces its framework
with OpenTelemetry: the processor observes ``execute_tool`` spans that start
inside a Ratel turn and reports each as an external tool call, so the tool
transition graph (ADR-0028) sees the tools Ratel did not run. It reads the turn
from the in-process turn scope, never from span attributes, and never changes a
span — exported telemetry is identical with or without it.

Do not combine it with an integration that already reports host tools through
``record_tool_call``, or every call is counted twice.

Importing this module needs no OpenTelemetry install; building a processor needs
the OpenTelemetry SDK, which a host registering span processors already has.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Any

from .turns import current_turn_id

# Ratel's own ``execute_tool`` spans, which the catalog already records.
_RATEL_SCOPE = "ratel-ai"
_GATEWAY_IDS = frozenset({"search_capabilities", "invoke_tool", "get_skill_content"})
# Turns remembered for spans that have started but not ended. A span that never
# ends must not grow this forever.
_PENDING_CAP = 4096


def _is_host_tool_span(span: Any) -> bool:
    scope = getattr(getattr(span, "instrumentation_scope", None), "name", None)
    if scope == _RATEL_SCOPE:
        return False
    attributes = getattr(span, "attributes", None) or {}
    return attributes.get("gen_ai.operation.name") == "execute_tool" or str(
        getattr(span, "name", "")
    ).startswith("execute_tool")


def _span_key(span: Any) -> int | None:
    context = span.get_span_context() if hasattr(span, "get_span_context") else None
    return getattr(context, "span_id", None)


class ExperimentalToolSequenceSpanProcessor:
    """⚠️ Experimental. A read-only span processor feeding host tool spans to a catalog.

    A span counts when it is an ``execute_tool`` span from any instrumentation but
    Ratel's own, starts inside a Ratel turn (``with catalog.turn():``), and names a
    tool other than a gateway tool. It is recorded when it ends, with its duration
    and error status.
    """

    def __init__(self, catalog: Any) -> None:
        """Feed tool spans to ``catalog``."""
        self._catalog = catalog
        self._turns: OrderedDict[int, str] = OrderedDict()

    def on_start(self, span: Any, parent_context: Any = None) -> None:
        """Note the turn a tool span starts in."""
        if not _is_host_tool_span(span):
            return
        turn_id = current_turn_id()
        key = _span_key(span)
        if turn_id is None or key is None:
            return
        self._turns[key] = turn_id
        while len(self._turns) > _PENDING_CAP:
            self._turns.popitem(last=False)

    def on_end(self, span: Any) -> None:
        """Report the tool call, once the span carries its outcome."""
        key = _span_key(span)
        turn_id = self._turns.pop(key, None) if key is not None else None
        if turn_id is None:
            return
        name = (getattr(span, "attributes", None) or {}).get("gen_ai.tool.name")
        if not isinstance(name, str) or not name or name in _GATEWAY_IDS:
            return
        start, end = getattr(span, "start_time", None), getattr(span, "end_time", None)
        took_ms = (end - start) / 1e6 if start is not None and end is not None else None
        status = getattr(span, "status", None)
        failed = getattr(getattr(status, "status_code", None), "name", None) == "ERROR"
        error = (
            (getattr(status, "description", None) or "tool span ended in error") if failed else None
        )
        self._catalog.record_tool_call(name, took_ms=took_ms, error=error, turn_id=turn_id)

    def shutdown(self) -> None:
        """Nothing to release."""

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        """Nothing is buffered."""
        return True


def experimental_tool_sequence_span_processor(
    catalog: Any,
) -> ExperimentalToolSequenceSpanProcessor:
    """⚠️ Experimental. A read-only span processor learning tool sequences (ADR-0028).

    Register it on your tracer provider (``provider.add_span_processor(...)``).
    A framework that starts tool spans outside the turn's context contributes
    nothing. Needs the OpenTelemetry SDK (``opentelemetry-sdk``).
    """
    # Subclassed, not duck-typed: the SDK calls hooks beyond the public four,
    # and its base class keeps those no-ops current across SDK versions.
    from opentelemetry.sdk.trace import SpanProcessor

    class _Processor(ExperimentalToolSequenceSpanProcessor, SpanProcessor):
        pass

    return _Processor(catalog)
