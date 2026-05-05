from __future__ import annotations

from typing import TYPE_CHECKING

from .events import Listener, ObserverEmitter, ObserverEventName, StepEvent, Unsubscribe
from .models import AgentifiedTool, DiscoverTool
from .namespace import Namespace
from .session import Session

if TYPE_CHECKING:
    from .api_client import ApiClient


class Instance:
    def __init__(
        self,
        instance_id: str,
        dataset_id: str,
        sdk: ApiClient,
        registered_tools: list[AgentifiedTool],
        emitter: ObserverEmitter | None = None,
    ) -> None:
        self.instance_id = instance_id
        self.dataset_id = dataset_id
        self._sdk = sdk
        self._registered_tools = registered_tools
        self.discover_tool: DiscoverTool = sdk.as_discover_tool(dataset_id)
        self._emitter = emitter
        self._step_count = 0

    @property
    def emitter(self) -> ObserverEmitter | None:
        return self._emitter

    def on(self, name: ObserverEventName, cb: Listener) -> Unsubscribe:
        if self._emitter is None:
            return lambda: None
        return self._emitter.on(name, cb)

    def on_step_finish(self, data: dict) -> None:
        """Forward a step event to registered listeners. Call from your agent's
        per-step callback (e.g. LangGraph node post-hook)."""
        if self._emitter is None:
            return
        step_index = int(data.get("step_index", self._step_count))
        self._step_count = step_index + 1
        evt = StepEvent(
            step_index=step_index,
            tool_calls=list(data.get("tool_calls", [])),
            tool_results=list(data.get("tool_results", [])),
            session_id=data.get("session_id"),
            usage=data.get("usage"),
            finish_reason=data.get("finish_reason"),
            duration_ms=data.get("duration_ms"),
        )
        self._emitter.emit("step", evt)

    def session(self, id: str) -> Session:
        return Session(id, "default", self._sdk, self.dataset_id, self._registered_tools, emitter=self._emitter)

    def namespace(self, id: str) -> Namespace:
        return Namespace(id, self._sdk, self.dataset_id, self._registered_tools, emitter=self._emitter)
