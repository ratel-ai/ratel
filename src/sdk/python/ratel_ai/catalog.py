"""Tool catalog with executors — the Python mirror of `src/sdk/ts/src/catalog.ts`.

`ToolRegistry` (the BM25 index) comes from the native binding; `ToolCatalog`
layers executable handlers on top and emits the same trace events the TS SDK does
(see ADR-0009 for the core-owned schema).
"""

from __future__ import annotations

import inspect
import json
import time
from collections.abc import Awaitable
from dataclasses import dataclass, field
from typing import Any, Callable, Union

from ._native import SearchHit, ToolRegistry

# Tool inputs are heterogeneous across the catalog; handlers may be sync or async.
Executor = Callable[[dict[str, Any]], Union[Awaitable[Any], Any]]

SearchOrigin = str  # "direct" | "agent"


@dataclass
class Tool:
    """Tool metadata: what the index ranks and the gateway surfaces."""

    id: str
    name: str
    description: str
    input_schema: dict[str, Any] = field(default_factory=dict)
    output_schema: dict[str, Any] = field(default_factory=dict)


@dataclass
class ExecutableTool(Tool):
    """A `Tool` plus the handler that runs it. Registered into a `ToolCatalog`."""

    # No default so `execute` stays required; placed last after the inherited fields.
    execute: Executor = field(default=None)  # type: ignore[assignment]


@dataclass
class TraceSinkConfig:
    """Where the catalog's trace events go. Mirrors the TS `TraceSinkConfig` union.

    kind: "noop" | "memory" | "jsonl". `session_id` is required for memory/jsonl;
    `path` is required for jsonl.
    """

    kind: str
    session_id: str | None = None
    path: str | None = None


class ToolCatalog:
    """Registry + executors. Register tools once, then search and invoke by id."""

    def __init__(self, trace: TraceSinkConfig | None = None) -> None:
        self._registry = ToolRegistry()
        self._executors: dict[str, Executor] = {}
        self._tools: dict[str, Tool] = {}
        if trace is not None:
            self._registry.set_trace_sink(trace.kind, trace.session_id, trace.path)

    def register(self, tool: ExecutableTool) -> None:
        if tool.execute is None:
            raise ValueError(f"tool {tool.id!r} has no execute handler")
        self._registry.register(
            tool.id,
            tool.name,
            tool.description,
            tool.input_schema,
            tool.output_schema,
        )
        self._executors[tool.id] = tool.execute
        self._tools[tool.id] = Tool(
            id=tool.id,
            name=tool.name,
            description=tool.description,
            input_schema=tool.input_schema,
            output_schema=tool.output_schema,
        )

    def search(
        self, query: str, top_k: int, origin: SearchOrigin = "direct"
    ) -> list[SearchHit]:
        return self._registry.search_with_origin(query, top_k, origin)

    def has(self, tool_id: str) -> bool:
        return tool_id in self._executors

    def get(self, tool_id: str) -> Tool | None:
        return self._tools.get(tool_id)

    def get_executable(self, tool_id: str) -> ExecutableTool | None:
        tool = self._tools.get(tool_id)
        execute = self._executors.get(tool_id)
        if tool is None or execute is None:
            return None
        return ExecutableTool(
            id=tool.id,
            name=tool.name,
            description=tool.description,
            input_schema=tool.input_schema,
            output_schema=tool.output_schema,
            execute=execute,
        )

    def record_event(self, event: dict[str, Any]) -> None:
        self._registry.record_event(event)

    def drain_trace_events(self) -> list[dict[str, Any]]:
        return self._registry.drain_trace_events()

    async def invoke(self, tool_id: str, args: dict[str, Any]) -> Any:
        fn = self._executors.get(tool_id)
        if fn is None:
            raise ValueError(f"unknown toolId: {tool_id}")
        self._registry.record_event(
            {
                "type": "invoke_start",
                "tool_id": tool_id,
                "args_size_bytes": _args_size_bytes(args),
            }
        )
        started = time.monotonic()
        try:
            result = fn(args)
            if inspect.isawaitable(result):
                result = await result
            self._registry.record_event(
                {
                    "type": "invoke_end",
                    "tool_id": tool_id,
                    "took_ms": _elapsed_ms(started),
                }
            )
            return result
        except Exception as err:
            self._registry.record_event(
                {
                    "type": "invoke_error",
                    "tool_id": tool_id,
                    "took_ms": _elapsed_ms(started),
                    "error": _error_message(err),
                }
            )
            raise


def _args_size_bytes(args: Any) -> int:
    try:
        return len(json.dumps(args))
    except Exception:
        return 0


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _error_message(err: BaseException) -> str:
    return str(err) or err.__class__.__name__
