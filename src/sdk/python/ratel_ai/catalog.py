"""Tool catalog with executors — the Python mirror of `src/sdk/ts/src/catalog.ts`.

`ToolRegistry` is a typed facade over the private native index; `ToolCatalog`
layers executable handlers on top and emits the same trace events the TS SDK does
(see ADR-0007 for the core-owned schema).
"""

from __future__ import annotations

import asyncio
import inspect
import json
import threading
import time
from collections.abc import Awaitable, Iterable
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, TypedDict, TypeVar, Union, overload

from ._native import SearchHit
from ._native import ToolRegistry as _NativeToolRegistry
from .telemetry import SEARCH_TARGET_TOOL, trace_execute_tool, trace_search, trace_search_async

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


class _PrefixOptions(TypedDict, total=False):
    query_prefix: str
    doc_prefix: str


class _HuggingFaceOptions(_PrefixOptions, total=False):
    revision: str
    pooling: Literal["cls", "mean"]
    download: bool


class HuggingFaceEmbeddingConfig(_HuggingFaceOptions):
    """In-process HuggingFace embedding model configuration."""

    huggingface: str


class _LocalOptions(_PrefixOptions, total=False):
    pooling: Literal["cls", "mean"]


class LocalEmbeddingConfig(_LocalOptions):
    """In-process local-directory embedding model configuration."""

    local: str


class OllamaEmbeddingConfig(_PrefixOptions):
    """Local Ollama embedding endpoint configuration."""

    ollama: str


class _EndpointOptions(_PrefixOptions, total=False):
    api_key_env: str


class EndpointEmbeddingConfig(_EndpointOptions):
    """OpenAI-compatible embedding endpoint configuration."""

    url: str
    model: str


EmbeddingModelConfig = Union[
    HuggingFaceEmbeddingConfig,
    LocalEmbeddingConfig,
    OllamaEmbeddingConfig,
    EndpointEmbeddingConfig,
]
"""Mutually exclusive keyed embedding-source configurations."""

EmbeddingSpec = Union[str, EmbeddingModelConfig]
"""Embedding selection; a bare string is a local model directory path."""

_DenseResult = TypeVar("_DenseResult")
_REGISTRY_BUSY = "registry busy; await the active operation"

_EMBEDDING_KEYS = frozenset(
    {
        "huggingface",
        "local",
        "ollama",
        "url",
        "model",
        "revision",
        "api_key_env",
        "query_prefix",
        "doc_prefix",
        "pooling",
        "download",
    }
)


def _embedding_kwargs(embedding: EmbeddingSpec) -> dict[str, Any]:
    """Normalize the public string|dict embedding form into native constructor kwargs.

    A string becomes the inferred ``spec``; a dict is passed through after a key
    check (the native layer validates the combination). Values are heterogeneous
    (``download`` is a bool), so the native constructor's typed params apply.
    """
    if isinstance(embedding, str):
        return {"spec": embedding}
    if isinstance(embedding, dict):
        if not embedding:
            raise ValueError("embedding config must not be empty")
        unknown = set(embedding) - _EMBEDDING_KEYS
        if unknown:
            raise ValueError(
                f"unknown embedding keys {sorted(unknown)}; allowed: {sorted(_EMBEDDING_KEYS)}"
            )
        return dict(embedding)
    raise TypeError("embedding must be a local-path string or a keyed config dict")


def _registry_embedding_kwargs(
    embedding: EmbeddingSpec | None,
    *,
    spec: str | None,
    huggingface: str | None,
    local: str | None,
    ollama: str | None,
    url: str | None,
    model: str | None,
    revision: str | None,
    api_key_env: str | None,
    query_prefix: str | None,
    doc_prefix: str | None,
    pooling: str | None,
    download: bool | None,
) -> dict[str, Any]:
    legacy = {
        key: value
        for key, value in {
            "spec": spec,
            "huggingface": huggingface,
            "local": local,
            "ollama": ollama,
            "url": url,
            "model": model,
            "revision": revision,
            "api_key_env": api_key_env,
            "query_prefix": query_prefix,
            "doc_prefix": doc_prefix,
            "pooling": pooling,
            "download": download,
        }.items()
        if value is not None
    }
    if embedding is not None:
        if legacy:
            raise TypeError("pass either embedding or legacy embedding kwargs, not both")
        return _embedding_kwargs(embedding)
    return legacy


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


class ToolRegistry:
    """Typed Python facade over the private native tool registry."""

    @overload
    def __init__(
        self, embedding: EmbeddingSpec | None = None, *, method: SearchMethod = "bm25"
    ) -> None: ...

    @overload
    def __init__(
        self,
        *,
        spec: str,
        query_prefix: str | None = None,
        doc_prefix: str | None = None,
        pooling: Literal["cls", "mean"] | None = None,
    ) -> None: ...

    @overload
    def __init__(
        self,
        *,
        huggingface: str,
        revision: str | None = None,
        query_prefix: str | None = None,
        doc_prefix: str | None = None,
        pooling: Literal["cls", "mean"] | None = None,
        download: bool | None = None,
    ) -> None: ...

    @overload
    def __init__(
        self,
        *,
        local: str,
        query_prefix: str | None = None,
        doc_prefix: str | None = None,
        pooling: Literal["cls", "mean"] | None = None,
    ) -> None: ...

    @overload
    def __init__(
        self,
        *,
        ollama: str,
        query_prefix: str | None = None,
        doc_prefix: str | None = None,
    ) -> None: ...

    @overload
    def __init__(
        self,
        *,
        url: str,
        model: str,
        api_key_env: str | None = None,
        query_prefix: str | None = None,
        doc_prefix: str | None = None,
    ) -> None: ...

    def __init__(
        self,
        embedding: EmbeddingSpec | None = None,
        *,
        method: SearchMethod = "bm25",
        spec: str | None = None,
        huggingface: str | None = None,
        local: str | None = None,
        ollama: str | None = None,
        url: str | None = None,
        model: str | None = None,
        revision: str | None = None,
        api_key_env: str | None = None,
        query_prefix: str | None = None,
        doc_prefix: str | None = None,
        pooling: str | None = None,
        download: bool | None = None,
    ) -> None:
        """Create a metadata registry with an optional embedding model.

        A "semantic"/"hybrid" `method` makes `register` embed eagerly (inside the
        call, on a worker thread); "bm25" keeps registration model-free.
        """
        kwargs = _registry_embedding_kwargs(
            embedding,
            spec=spec,
            huggingface=huggingface,
            local=local,
            ollama=ollama,
            url=url,
            model=model,
            revision=revision,
            api_key_env=api_key_env,
            query_prefix=query_prefix,
            doc_prefix=doc_prefix,
            pooling=pooling,
            download=download,
        )
        self._native = _NativeToolRegistry(**kwargs)
        self._eager = method in ("semantic", "hybrid")
        self._dense_gate = threading.Lock()
        self._dense_state = threading.Lock()
        self._dense_pending = 0
        self._dense_tasks: set[asyncio.Task[Any]] = set()

    @overload
    async def register(self, item: Tool) -> None: ...

    @overload
    async def register(self, item: Iterable[Tool]) -> None: ...

    @overload
    async def register(
        self,
        item: str,
        name: str,
        description: str,
        input_schema: dict[str, Any],
        output_schema: dict[str, Any],
    ) -> None: ...

    async def register(
        self,
        item: Tool | Iterable[Tool] | str,
        name: str | None = None,
        description: str | None = None,
        input_schema: dict[str, Any] | None = None,
        output_schema: dict[str, Any] | None = None,
    ) -> None:
        """Register one `Tool`, many `Tool`s, or a flat (id, name, …) tuple.

        Stores metadata and — on a "semantic"/"hybrid" registry — embeds in one
        batched, off-thread pass (embedding errors surface here). "bm25" registers
        metadata only.
        """
        flat_args = (name, description, input_schema, output_schema)
        if isinstance(item, Tool):
            if any(value is not None for value in flat_args):
                raise TypeError("item register accepts only the Tool argument")
            tools: list[Tool] = [item]
        elif isinstance(item, str):
            if any(value is None for value in flat_args):
                raise TypeError("flat register requires all metadata arguments")
            tools = [Tool(item, name, description, input_schema, output_schema)]  # type: ignore[arg-type]
        else:
            if any(value is not None for value in flat_args):
                raise TypeError("iterable register accepts only the items argument")
            tools = list(item)
            if not all(isinstance(tool, Tool) for tool in tools):
                raise TypeError("register requires Tool items")
        self._register_items(tools)
        if self._eager:
            await self._build()

    def search(self, query: str, top_k: int) -> list[SearchHit]:
        """Run synchronous, model-free BM25 retrieval."""
        return self._native.search(query, top_k)

    def search_with_origin(self, query: str, top_k: int, origin: SearchOrigin) -> list[SearchHit]:
        """Run BM25 retrieval with an explicit trace origin."""
        return self._native.search_with_origin(query, top_k, origin)

    def search_with_method(
        self, query: str, top_k: int, origin: SearchOrigin, method: SearchMethod
    ) -> list[SearchHit]:
        """Run BM25 synchronously; dense retrieval is async-only."""
        if method not in ("bm25", "semantic", "hybrid"):
            raise ValueError(f"unknown search method: {method}")
        if method != "bm25":
            raise RuntimeError(
                f'{method} search is asynchronous; use `await registry.search_async(..., '
                f'method="{method}")`'
            )
        return self.search_with_origin(query, top_k, origin)

    async def _build(self) -> None:
        """Embed not-yet-embedded items on a worker thread (used by `register`)."""
        await self._run_dense(self._native._build_embeddings)

    async def _rebuild(self) -> None:
        """Recompute and atomically replace the full embedding cache (internal)."""
        await self._run_dense(self._native._rebuild_embeddings)

    async def search_async(
        self,
        query: str,
        top_k: int,
        origin: SearchOrigin = "direct",
        method: SearchMethod = "bm25",
    ) -> list[SearchHit]:
        """Search immediately with BM25 or run dense retrieval on a worker thread."""
        if method not in ("bm25", "semantic", "hybrid"):
            raise ValueError(f"unknown search method: {method}")
        if method == "bm25":
            return self.search_with_origin(query, top_k, origin)
        return await self._run_dense(
            lambda: self._native._search_with_method(query, top_k, origin, method)
        )

    def record_event(self, event: dict[str, Any]) -> None:
        """Record an SDK-layer trace event."""
        self._native.record_event(event)

    def set_trace_sink(
        self, kind: str, session_id: str | None = None, path: str | None = None
    ) -> None:
        """Replace the native trace sink."""
        with self._dense_state:
            self._raise_if_busy()
            self._native.set_trace_sink(kind, session_id, path)

    def drain_trace_events(self) -> list[dict[str, Any]]:
        """Drain captured native trace events."""
        return self._native.drain_trace_events()

    async def _run_dense(self, operation: Callable[[], _DenseResult]) -> _DenseResult:
        self._queue_dense()
        runner = self._run_dense_task(operation)
        try:
            task = asyncio.create_task(runner)
        except BaseException:
            runner.close()
            self._finish_dense()
            raise
        self._dense_tasks.add(task)
        task.add_done_callback(self._dense_task_done)
        # Shielding prevents cancellation from cancelling queued executor work;
        # the retained runner clears busy state only after native work ends.
        return await asyncio.shield(task)

    async def _run_dense_task(self, operation: Callable[[], _DenseResult]) -> _DenseResult:
        try:
            return await asyncio.to_thread(self._run_dense_worker, operation)
        finally:
            # Also runs when the default executor rejects submission, before a
            # worker exists to clear the queued-operation state.
            self._finish_dense()

    def _run_dense_worker(self, operation: Callable[[], _DenseResult]) -> _DenseResult:
        with self._dense_gate:
            return operation()

    def _dense_task_done(self, task: asyncio.Task[Any]) -> None:
        self._dense_tasks.discard(task)
        if not task.cancelled():
            # A shielded worker outlives a cancelled caller. Retrieve any later
            # failure so asyncio does not report an unhandled task exception.
            task.exception()

    def _queue_dense(self) -> None:
        with self._dense_state:
            self._dense_pending += 1

    def _finish_dense(self) -> None:
        with self._dense_state:
            self._dense_pending -= 1

    def _register_items(self, tools: Iterable[Tool]) -> None:
        tools = list(tools)
        with self._dense_state:
            self._raise_if_busy()
            self._native._register_many(
                [
                    (
                        tool.id,
                        tool.name,
                        tool.description,
                        tool.input_schema,
                        tool.output_schema,
                    )
                    for tool in tools
                ]
            )

    def _raise_if_busy(self) -> None:
        if self._dense_pending:
            raise RuntimeError(_REGISTRY_BUSY)


class ToolCatalog:
    """Registry + executors. Register tools once, then search and invoke by id."""

    def __init__(
        self,
        trace: TraceSinkConfig | None = None,
        method: SearchMethod = "bm25",
        embedding: EmbeddingSpec | None = None,
    ) -> None:
        """Create an empty catalog.

        Args:
            trace: where trace events go; `None` keeps the default no-op sink.
            method: default retrieval method for `search` — "bm25" (the
                historical, model-free behavior), "semantic" or "hybrid". A
                per-call `method=` overrides it. Dense defaults must use
                `search_async` after an explicit `build_embeddings`.
            embedding: model for semantic/hybrid retrieval (a path string or a
                keyed dict — see `EmbeddingSpec`). Retained and validated even
                under "bm25" so a later async semantic override can use it.
        """
        self._executors: dict[str, Executor] = {}
        self._tools: dict[str, Tool] = {}
        self._method: SearchMethod = method
        # A semantic/hybrid catalog embeds inside `register`; a bm25 catalog stays
        # model-free. The model is validated at construction regardless.
        self._registry = ToolRegistry(embedding, method=method)
        if trace is not None:
            self._registry.set_trace_sink(trace.kind, trace.session_id, trace.path)

    async def register(self, tools: ExecutableTool | Iterable[ExecutableTool]) -> None:
        """Register one tool or many — the single entry point for both.

        Stores metadata and the executor handler, then — on a "semantic"/"hybrid"
        catalog — embeds the tools in one batched pass on a worker thread (so the
        event loop is never blocked). Embedding errors (model load / endpoint /
        auth / dimension) surface **here**, at registration. A BM25 catalog never
        loads a model and resolves immediately. Re-registering an id replaces it
        in place; the index never holds a duplicate.

        A model or dimension change is not recovered in place — construct a new
        catalog and re-register.

        Args:
            tools: a single `ExecutableTool` or an iterable of them; each
                `execute` must be set. Pass the whole batch at once for a single
                embedding request; separate `register` calls embed separately.

        Raises:
            ValueError: if any `execute` is `None`, or a schema isn't JSON-serializable.
            EmbedderError: on a semantic/hybrid catalog, if embedding fails.
            RuntimeError: if a dense operation already owns the registry.
        """
        batch = [tools] if isinstance(tools, ExecutableTool) else list(tools)
        for tool in batch:
            if tool.execute is None:
                raise ValueError(f"tool {tool.id!r} has no execute handler")
        self._registry._register_items(batch)
        for tool in batch:
            self._executors[tool.id] = tool.execute
            self._tools[tool.id] = Tool(
                id=tool.id,
                name=tool.name,
                description=tool.description,
                input_schema=tool.input_schema,
                output_schema=tool.output_schema,
            )
        if self._method in ("semantic", "hybrid"):
            await self._registry._build()

    def search(
        self,
        query: str,
        top_k: int,
        origin: SearchOrigin = "direct",
        method: SearchMethod | None = None,
    ) -> list[SearchHit]:
        """Rank registered tools synchronously with BM25.

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
            RuntimeError: if the resolved method is semantic/hybrid; use
                `search_async` for dense retrieval.
        """
        resolved_method = method or self._method
        if resolved_method not in ("bm25", "semantic", "hybrid"):
            raise ValueError(f"unknown search method: {resolved_method}")
        if resolved_method != "bm25":
            raise RuntimeError(
                f'{resolved_method} search is asynchronous; use `await catalog.search_async(..., '
                f'method="{resolved_method}")`'
            )
        return trace_search(
            SEARCH_TARGET_TOOL,
            query,
            top_k,
            origin,
            lambda: self._registry.search_with_origin(query, top_k, origin),
        )

    async def search_async(
        self,
        query: str,
        top_k: int,
        origin: SearchOrigin = "direct",
        method: SearchMethod | None = None,
    ) -> list[SearchHit]:
        """Rank tools asynchronously with BM25, semantic, or hybrid retrieval.

        Dense methods require a complete cache built by `build_embeddings` or
        `rebuild_embeddings`; searching never builds missing corpus embeddings.
        """
        resolved_method = method or self._method
        return await trace_search_async(
            SEARCH_TARGET_TOOL,
            query,
            top_k,
            origin,
            lambda: self._registry.search_async(query, top_k, origin, resolved_method),
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
