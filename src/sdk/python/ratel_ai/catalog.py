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
from .observability import RatelClient, get_client
from .observability import context as obs_context
from .observability.estimator import TokenEstimator, default_estimator
from .observability.savings import catalog_tokens, compute_savings

# Tool inputs are heterogeneous across the catalog; handlers may be sync or async.
Executor = Callable[[dict[str, Any]], Union[Awaitable[Any], Any]]

# Sentinel distinguishing "argument omitted" from an explicit `None` output.
_UNSET: Any = object()

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


def _resolve_observe(
    observe: bool | RatelClient | None,
) -> tuple[RatelClient | None, bool, bool]:
    """Resolve the `observe` opt-in to (explicit_client, use_global, enabled).

    None/False → off. True → the global client, resolved lazily at use time so a
    later `configure()` is honored. A `RatelClient` → use it directly.
    """
    if observe is None or observe is False:
        return None, False, False
    if observe is True:
        return None, True, True
    if isinstance(observe, RatelClient):
        return observe, False, True
    return None, False, False


class ToolCatalog:
    """Registry + executors. Register tools once, then search and invoke by id.

    Pass `observe=True` (or a `RatelClient`) to also emit Ratel's tokens-saved
    metric on every search and trace each tool invocation to the cloud, alongside
    the existing local trace stream. Omit it and behavior is unchanged.
    """

    def __init__(
        self,
        trace: TraceSinkConfig | None = None,
        observe: bool | RatelClient | None = None,
    ) -> None:
        self._registry = ToolRegistry()
        self._executors: dict[str, Executor] = {}
        self._tools: dict[str, Tool] = {}
        if trace is not None:
            self._registry.set_trace_sink(trace.kind, trace.session_id, trace.path)
        (
            self._observe_client_explicit,
            self._observe_use_global,
            self._observe_enabled,
        ) = _resolve_observe(observe)
        self._estimator: TokenEstimator = default_estimator()
        # Lazily computed full-catalog token estimate, invalidated on register.
        self._full_tokens: int | None = None

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
        self._full_tokens = None  # catalog changed; recompute savings baseline lazily

    def _obs_client(self) -> RatelClient | None:
        """The observability client, resolving the global one lazily for
        `observe=True` so a `configure()` after construction is honored."""
        if self._observe_client_explicit is not None:
            return self._observe_client_explicit
        if self._observe_use_global:
            try:
                return get_client()
            except Exception:
                return None
        return None

    def search(
        self, query: str, top_k: int, origin: SearchOrigin = "direct"
    ) -> list[SearchHit]:
        hits = self._registry.search_with_origin(query, top_k, origin)
        if self._observe_enabled:
            self._emit_savings(query, hits, top_k)
        return hits

    def _emit_savings(self, query: str, hits: list[SearchHit], top_k: int) -> None:
        """Record the full-catalog-vs-top-K token saving. Best-effort: never raises."""
        try:
            if self._full_tokens is None:
                self._full_tokens = catalog_tokens(self._tools.values(), self._estimator)
            selected = [self._tools[h.tool_id] for h in hits if h.tool_id in self._tools]
            savings = compute_savings(selected, self._full_tokens, top_k, self._estimator)
            self._registry.record_event(
                {
                    "type": "tokens_saved",
                    "trace_id": obs_context.current_trace_id() or "",
                    "full_catalog_tokens": savings.full_catalog_tokens,
                    "selected_tokens": savings.selected_tokens,
                    "top_k": top_k,
                }
            )
            client = self._obs_client()
            if client is not None:
                client.event(
                    "ratel.tokens_saved", metadata={**savings.as_metadata(), "query": query}
                )
        except Exception:
            pass

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
        # When observing, also surface the call as a cloud span so tool usage is
        # analyzable alongside generations; the local invoke_* events are unchanged.
        span = self._start_invoke_span(tool_id, args)
        self._registry.record_event(
            {
                "type": "invoke_start",
                "tool_id": tool_id,
                "args_size_bytes": _args_size_bytes(args),
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
                }
            )
            self._end_invoke_span(span, output=result)
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
            self._end_invoke_span(span, error=err)
            raise

    def _start_invoke_span(self, tool_id: str, args: dict[str, Any]) -> Any:
        client = self._obs_client()
        if client is None:
            return None
        try:
            return client.start_observation(f"tool.{tool_id}", kind="span", input=args)
        except Exception:
            return None

    def _end_invoke_span(
        self, span: Any, *, output: Any = _UNSET, error: Exception | None = None
    ) -> None:
        if span is None:
            return
        try:
            if error is not None:
                span.end(error=error)
            elif output is not _UNSET:
                span.end(output=output)
            else:
                span.end()
        except Exception:
            pass


def _args_size_bytes(args: Any) -> int:
    try:
        return len(json.dumps(args))
    except Exception:
        return 0


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _error_message(err: BaseException) -> str:
    return str(err) or err.__class__.__name__
