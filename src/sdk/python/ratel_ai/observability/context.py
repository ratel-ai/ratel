"""Trace-tree context — async-safe current trace and observation tracking.

Uses `contextvars` so nesting works correctly across both threads and asyncio
tasks: a child observation reads the current observation as its parent, and a
fresh asyncio task inherits a copied context (its own stack) rather than racing.
"""

from __future__ import annotations

import time
import uuid
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any


def now_ms() -> int:
    """Wall-clock epoch milliseconds (for event timestamps)."""
    return int(time.time() * 1000)


def _short() -> str:
    return uuid.uuid4().hex


def new_trace_id() -> str:
    return f"trc_{_short()}"


def new_observation_id() -> str:
    return f"obs_{_short()}"


def new_event_id() -> str:
    return f"evt_{_short()}"


@dataclass
class TraceContext:
    """Mutable per-trace state. Attributes are upserted via the client and
    re-emitted as a `trace-create`."""

    trace_id: str
    name: str | None = None
    session_id: str | None = None
    user_id: str | None = None
    version: str | None = None
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    # False when the trace lost the sample-rate draw: its events are dropped.
    sampled: bool = True


_current_trace: ContextVar[TraceContext | None] = ContextVar("ratel_current_trace", default=None)
_current_observation_id: ContextVar[str | None] = ContextVar(
    "ratel_current_observation_id", default=None
)


def current_trace() -> TraceContext | None:
    return _current_trace.get()


def current_trace_id() -> str | None:
    trace = _current_trace.get()
    return trace.trace_id if trace is not None else None


def current_observation_id() -> str | None:
    return _current_observation_id.get()


def set_current_trace(trace: TraceContext) -> Token[TraceContext | None]:
    return _current_trace.set(trace)


def reset_current_trace(token: Token[TraceContext | None]) -> None:
    try:
        _current_trace.reset(token)
    except ValueError:
        # Token created in a different context (e.g. crossed a task boundary);
        # clearing is the safe best-effort fallback.
        _current_trace.set(None)


def clear() -> None:
    """Reset the current trace and observation to empty. For test isolation and
    explicit teardown between independent units of work."""
    _current_trace.set(None)
    _current_observation_id.set(None)


def push_observation(observation_id: str) -> Token[str | None]:
    return _current_observation_id.set(observation_id)


def reset_observation(token: Token[str | None]) -> None:
    try:
        _current_observation_id.reset(token)
    except ValueError:
        _current_observation_id.set(None)
