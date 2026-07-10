"""Tool catalog with executors — the Python mirror of `src/sdk/ts/src/catalog.ts`.

`ToolRegistry` (the BM25 index) comes from the native binding; `ToolCatalog`
layers executable handlers on top and emits the same trace events the TS SDK does
(see ADR-0007 for the core-owned schema).
"""

from __future__ import annotations

import inspect
import json
import time
from collections.abc import Awaitable
from dataclasses import dataclass, field
from typing import Any, Callable, Union

from ._native import SearchHit, ToolRegistry
from .telemetry import SEARCH_TARGET_TOOL, trace_execute_tool, trace_search

Executor = Callable[[dict[str, Any]], Union[Awaitable[Any], Any]]
"""A tool handler: takes the tool's arguments dict, returns the result.

May be sync or async (tool inputs are heterogeneous across the catalog);
`ToolCatalog.invoke` absorbs the difference.
"""

SearchOrigin = str
"""Who initiated a search: ``"direct"`` (host code, the default) or ``"agent"``
(a model calling a capability tool). Labels the emitted trace event only —
ranking is unaffected.
"""

SearchMethod = str
"""Retrieval engine: ``"bm25"`` (lexical, model-free, the default),
``"semantic"`` (dense embeddings) or ``"hybrid"`` (both, fused).
"""


@dataclass
class Tool:
    """Tool metadata: what the index ranks and the capability tools surface."""

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

    def __init__(
        self,
        trace: TraceSinkConfig | None = None,
        method: SearchMethod = "bm25",
    ) -> None:
        """Create an empty catalog.

        Args:
            trace: where trace events go; `None` keeps the default no-op sink.
            method: default retrieval method for `search` — "bm25" (the
                historical, model-free behavior), "semantic" or "hybrid". A
                per-call `method=` overrides it. A semantic/hybrid catalog
                eagerly embeds each tool at registration so searches never pay
                the embedding cost; a BM25 catalog never touches the model.
        """
        self._registry = ToolRegistry()
        self._executors: dict[str, Executor] = {}
        self._tools: dict[str, Tool] = {}
        self._method: SearchMethod = method
        self._eager: bool = method in ("semantic", "hybrid")
        if trace is not None:
            self._registry.set_trace_sink(trace.kind, trace.session_id, trace.path)

    def register(self, tool: ExecutableTool) -> None:
        """Add a tool to the catalog (metadata into the index, handler by id).

        Registering an id that is already present replaces it in place — the
        index never holds a duplicate.

        Args:
            tool: the tool to register; `execute` must be set.

        Raises:
            ValueError: if `tool.execute` is `None`, or if `input_schema` /
                `output_schema` contain values that are not JSON-serializable.
            RuntimeError: on a semantic/hybrid catalog, if the embedding model
                fails to load while eagerly embedding the new tool.
        """
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
        if self._eager:
            # Embed the just-registered tool now (incremental) so semantic/hybrid
            # searches stay fast. Raises RuntimeError if the model fails to load.
            self._registry.build_embeddings()

    def build_embeddings(self) -> None:
        """Pre-compute embeddings for any not-yet-embedded tools.

        Incremental: only tools registered since the last call are embedded.
        Call after a bulk register, or rely on the automatic per-register
        embedding that a semantic/hybrid catalog does. A BM25 catalog never
        needs it.

        Raises:
            RuntimeError: if the embedding model fails to load.
        """
        self._registry.build_embeddings()

    def search(
        self,
        query: str,
        top_k: int,
        origin: SearchOrigin = "direct",
        method: SearchMethod | None = None,
    ) -> list[SearchHit]:
        """Rank registered tools against a natural-language query.

        Args:
            query: what the caller wants to do.
            top_k: max hits to return.
            origin: who initiated the search — labels the trace event only.
            method: per-call override of the catalog's default retrieval
                method ("bm25" | "semantic" | "hybrid").

        Returns:
            Up to `top_k` `SearchHit`s, best first.

        Raises:
            ValueError: if `method` is not "bm25", "semantic" or "hybrid".
            RuntimeError: for "semantic"/"hybrid" when the embedding cache is
                not built (call `build_embeddings`) or query embedding fails.
        """
        return trace_search(
            SEARCH_TARGET_TOOL,
            query,
            top_k,
            origin,
            lambda: self._registry.search_with_method(query, top_k, origin, method or self._method),
        )

    def has(self, tool_id: str) -> bool:
        """Return whether a tool with this id is registered."""
        return tool_id in self._executors

    def get(self, tool_id: str) -> Tool | None:
        """Return the metadata-only `Tool` for an id, or `None` if unknown."""
        return self._tools.get(tool_id)

    def get_executable(self, tool_id: str) -> ExecutableTool | None:
        """Return the `ExecutableTool` (metadata plus handler) for an id, or `None`."""
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
        """Record a trace event into the catalog's sink.

        Args:
            event: a dict matching one of the core-owned `TraceEvent` shapes
                (ADR-0007), e.g. `{"type": "gateway_search", ...}`.

        Raises:
            ValueError: if the dict doesn't match any known event shape.
        """
        self._registry.record_event(event)

    def drain_trace_events(self) -> list[dict[str, Any]]:
        """Drain captured trace envelopes; `[]` unless the sink is "memory"."""
        return self._registry.drain_trace_events()

    async def invoke(self, tool_id: str, args: dict[str, Any]) -> Any:
        """Run a registered tool's handler and return its result.

        This is the canonical place that absorbs the sync/async executor
        difference: the handler is called first and the result awaited only if
        it is awaitable, so plain functions and `async def` executors (e.g.
        MCP/HTTP tools) are both supported. Callers must route invocations
        here rather than re-deriving that logic. Emits `invoke_start` /
        `invoke_end` / `invoke_error` trace events and wraps the call in an
        `execute_tool` OTel span (ADR-0007).

        Args:
            tool_id: id of a registered tool.
            args: the arguments dict passed to the handler.

        Returns:
            Whatever the handler returns (awaited if it returned an awaitable).

        Raises:
            ValueError: if `tool_id` is not registered.
            Exception: whatever the handler raises, re-raised after an
                `invoke_error` trace event is recorded.
        """
        fn = self._executors.get(tool_id)
        if fn is None:
            raise ValueError(f"unknown toolId: {tool_id}")

        async def _run() -> Any:
            self._registry.record_event(
                {
                    "type": "invoke_start",
                    "tool_id": tool_id,
                    "args_size_bytes": _args_size_bytes(args),
                }
            )
            started = time.monotonic()
            try:
                # Call first, await only if awaitable (see the `invoke` docstring).
                # Never bare-`await fn(args)`: in Python that raises on a sync result.
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

        # The `execute_tool` OTel span wraps the local trace stream; both record the
        # same invocation, on their two independent channels (ADR-0007).
        return await trace_execute_tool(tool_id, args, _run)


def _args_size_bytes(args: Any) -> int:
    try:
        return len(json.dumps(args))
    except Exception:
        return 0


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _error_message(err: BaseException) -> str:
    return str(err) or err.__class__.__name__
