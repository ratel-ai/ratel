from __future__ import annotations

import asyncio
import inspect
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from .models import ContextStrategy, RankedTool, RecallConfig


ObserverEventName = Literal["context_assembled", "recall", "step"]

Listener = Callable[[Any], Any]
Unsubscribe = Callable[[], None]


@dataclass
class ContextAssembledEvent:
    session_id: str
    dataset_id: str
    strategy_used: ContextStrategy
    total_messages: int
    included_messages: int
    token_estimate: int
    fallback: bool
    recalled: dict[str, Any]
    duration_ms: float


@dataclass
class RecallEvent:
    session_id: str
    dataset_id: str
    config: RecallConfig | None
    matches: list[RankedTool]
    duration_ms: float


@dataclass
class StepEvent:
    step_index: int
    tool_calls: list[Any]
    tool_results: list[Any]
    session_id: str | None = None
    usage: Any | None = None
    finish_reason: str | None = None
    duration_ms: float | None = None


class ObserverEmitter:
    """Fire-and-forget event emitter. Supports sync + async listeners."""

    def __init__(self) -> None:
        self._listeners: dict[str, list[Listener]] = {}

    def on(self, name: ObserverEventName, cb: Listener) -> Unsubscribe:
        self._listeners.setdefault(name, []).append(cb)

        def unsub() -> None:
            lst = self._listeners.get(name)
            if lst and cb in lst:
                lst.remove(cb)

        return unsub

    def emit(self, name: ObserverEventName, evt: Any) -> None:
        for cb in list(self._listeners.get(name, [])):
            try:
                result = cb(evt)
            except Exception:
                continue
            if inspect.iscoroutine(result):
                try:
                    loop = asyncio.get_running_loop()
                    task = loop.create_task(result)
                    task.add_done_callback(lambda t: t.exception())
                except RuntimeError:
                    # No running loop — run the coroutine to completion.
                    try:
                        asyncio.run(result)
                    except Exception:
                        pass
