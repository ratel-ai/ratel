"""Tool catalog with executors — the Python mirror of `src/sdk/ts/src/catalog.ts`.

`ToolRegistry` (the BM25 index) comes from the native binding; `ToolCatalog`
layers executable handlers on top and emits the same trace events the TS SDK does
(see ADR-0007 for the core-owned schema).
"""

from __future__ import annotations

import inspect
import json
import time
import warnings
from collections.abc import Awaitable
from dataclasses import dataclass, field
from typing import Any, Callable, Union

from ._native import SearchHit, ToolRegistry
from .telemetry import SEARCH_TARGET_TOOL, trace_execute_tool, trace_search

# Tool inputs are heterogeneous across the catalog; handlers may be sync or async.
Executor = Callable[[dict[str, Any]], Union[Awaitable[Any], Any]]

SearchOrigin = str  # "direct" | "agent"
SearchMethod = str  # "bm25" | "semantic" | "hybrid"

# Embedding-model selection for semantic/hybrid retrieval: a string shortcut (a
# HuggingFace repo id like "BAAI/bge-base-en-v1.5", or a local dir path), or an
# object selecting an endpoint / pinning a revision:
#   {"huggingface": "org/name", "revision": "…"} | {"local": "/path"}
#   {"ollama": "nomic-embed-text"} | {"url": "…", "model": "…", "api_key_env": "…"}
EmbeddingSpec = Union[str, dict[str, str]]

_EMBEDDING_KEYS = frozenset(
    {"huggingface", "local", "ollama", "url", "model", "revision", "api_key_env", "query_prefix"}
)


def _embedding_kwargs(embedding: EmbeddingSpec) -> dict[str, str]:
    """Normalize the public string|dict embedding form into native constructor
    kwargs. A string becomes the inferred ``spec``; a dict is passed through after
    a key check (the native layer validates the combination)."""
    if isinstance(embedding, str):
        return {"spec": embedding}
    if isinstance(embedding, dict):
        unknown = set(embedding) - _EMBEDDING_KEYS
        if unknown:
            raise ValueError(
                f"unknown embedding keys {sorted(unknown)}; allowed: {sorted(_EMBEDDING_KEYS)}"
            )
        return dict(embedding)
    raise TypeError("embedding must be a str (repo id / path) or a dict")


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
        embedding: EmbeddingSpec | None = None,
    ) -> None:
        self._executors: dict[str, Executor] = {}
        self._tools: dict[str, Tool] = {}
        # Default retrieval method for `search`; "bm25" keeps the historical
        # (model-free) behavior. A per-call `method=` overrides it.
        self._method: SearchMethod = method
        # Semantic/hybrid default → eagerly embed each tool at registration so
        # searches never pay the embedding cost. BM25 default does nothing.
        self._eager: bool = method in ("semantic", "hybrid")
        if embedding is not None and not self._eager:
            warnings.warn(
                '`embedding` was provided but method is "bm25", which needs no model'
                " — the embedding config is ignored",
                stacklevel=2,
            )
        # A bm25 catalog ignores the model entirely (never loads it). An invalid
        # config raises ValueError here, at construction.
        kwargs = _embedding_kwargs(embedding) if (self._eager and embedding is not None) else {}
        self._registry = ToolRegistry(**kwargs)
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
        if self._eager:
            # Embed the just-registered tool now (incremental) so semantic/hybrid
            # searches stay fast. Raises RuntimeError if the model fails to load.
            self._registry.build_embeddings()

    def build_embeddings(self) -> None:
        """Pre-compute embeddings for any not-yet-embedded tools. Call after a
        bulk register, or rely on the automatic per-register embedding that a
        semantic/hybrid catalog does. No-op for a BM25 catalog's cache."""
        self._registry.build_embeddings()

    def search(
        self,
        query: str,
        top_k: int,
        origin: SearchOrigin = "direct",
        method: SearchMethod | None = None,
    ) -> list[SearchHit]:
        """Search the catalog. `method` overrides the catalog default for this
        call ("bm25" | "semantic" | "hybrid"); "semantic"/"hybrid" raise
        `RuntimeError` if the embedding model fails to load."""
        return trace_search(
            SEARCH_TARGET_TOOL,
            query,
            top_k,
            origin,
            lambda: self._registry.search_with_method(query, top_k, origin, method or self._method),
        )

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
                # Executors may be sync (a plain dict-returning function) or async
                # (`async def`, e.g. MCP/HTTP tools) — so call first, then await only
                # if awaitable. Never bare-`await fn(args)`: in Python that raises on a
                # sync result. This is the canonical place that absorbs the difference;
                # callers must route here, not re-derive it.
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
