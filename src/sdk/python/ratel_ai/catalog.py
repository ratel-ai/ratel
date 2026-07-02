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

from ._native import SearchHit, ToolRegistry, TraceSession

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
    `path` is required for jsonl. The optional envelope context (`harness`,
    `environment`, `sdk_version`, `catalog_version`) is stamped on every event —
    see ADR-0013.
    """

    kind: str
    session_id: str | None = None
    path: str | None = None
    harness: str | None = None
    environment: str | None = None
    sdk_version: str | None = None
    catalog_version: str | None = None


@dataclass(frozen=True)
class TracedSearch:
    """A search result plus the emitted event's id (mirrors the TS `TracedSearch`)."""

    # Id stamped on the emitted search event — attributed to later invokes.
    search_id: str
    hits: list[SearchHit]


class ToolCatalog:
    """Registry + executors. Register tools once, then search and invoke by id."""

    def __init__(
        self,
        trace: TraceSinkConfig | None = None,
        trace_session: TraceSession | None = None,
    ) -> None:
        self._registry = ToolRegistry()
        self._executors: dict[str, Executor] = {}
        self._tools: dict[str, Tool] = {}
        # tool id → id of the most recent search that surfaced it (ADR-0013).
        self._last_search_id_by_tool: dict[str, str] = {}
        # Shared session buffer (one per process/session). Attach the same session
        # to every catalog so `(session_id, seq)` stays unique and the Cloud
        # exporter has a single drain point. Takes precedence over `trace`.
        if trace_session is not None:
            self._registry.attach_trace_session(trace_session)
        elif trace is not None:
            self._registry.set_trace_sink(
                trace.kind,
                trace.session_id,
                trace.path,
                trace.harness,
                trace.environment,
                trace.sdk_version,
                trace.catalog_version,
            )

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

    def search(self, query: str, top_k: int, origin: SearchOrigin = "direct") -> list[SearchHit]:
        return self.search_traced(query, top_k, origin).hits

    def search_traced(
        self, query: str, top_k: int, origin: SearchOrigin = "direct"
    ) -> TracedSearch:
        """Like `search`, but also returns the emitted event's `search_id`."""
        search_id, hits = self._registry.search_with_trace(query, top_k, origin)
        for hit in hits:
            self._last_search_id_by_tool[hit.tool_id] = search_id
        return TracedSearch(search_id=search_id, hits=hits)

    def last_search_id(self, tool_id: str) -> str | None:
        """Id of the most recent search that surfaced this tool, if any."""
        return self._last_search_id_by_tool.get(tool_id)

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
        search_id = self._last_search_id_by_tool.get(tool_id)
        attribution = {"search_id": search_id} if search_id is not None else {}
        self._registry.record_event(
            {
                "type": "invoke_start",
                "tool_id": tool_id,
                "args_size_bytes": _json_size_bytes(args),
                **attribution,
            }
        )
        started = time.monotonic()
        try:
            # Executors may be sync (a plain dict-returning function) or async
            # (`async def`, e.g. MCP/HTTP tools) — so call first, then await only
            # if awaitable. Never bare-`await fn(args)`: in Python that raises on a
            # sync result. (See docs/lessons.md — this is the canonical place that
            # absorbs the difference; callers must route here, not re-derive it.)
            result = fn(args)
            if inspect.isawaitable(result):
                result = await result
            self._registry.record_event(
                {
                    "type": "invoke_end",
                    "tool_id": tool_id,
                    "took_ms": _elapsed_ms(started),
                    "result_size_bytes": _json_size_bytes(result),
                    **attribution,
                }
            )
            return result
        except Exception as err:
            # Same detection as the gateway's `_is_unauthorized_error` — by class
            # name, so any upstream's UnauthorizedError classifies without a dep.
            unauthorized = type(err).__name__ == "UnauthorizedError"
            classification = (
                {"error_code": "needs_auth", "error_kind": "transient"} if unauthorized else {}
            )
            self._registry.record_event(
                {
                    "type": "invoke_error",
                    "tool_id": tool_id,
                    "took_ms": _elapsed_ms(started),
                    "error": _error_message(err),
                    **attribution,
                    **classification,
                }
            )
            raise


def _json_size_bytes(value: Any) -> int:
    try:
        return len(json.dumps(value))
    except Exception:
        return 0


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _error_message(err: BaseException) -> str:
    return str(err) or err.__class__.__name__
