"""Skill catalog — the Python mirror of `src/sdk/ts/src/skill-catalog.ts`.

`SkillRegistry` is a typed facade over the private native index; `SkillCatalog`
is the on-demand analogue of `ToolCatalog`: registered skills are ranked by
relevance, and the matching body is fetched only on `invoke`.
"""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Literal, TypeVar, overload

from ._native import SkillHit
from ._native import SkillRegistry as _NativeSkillRegistry
from .catalog import (
    _REGISTRY_BUSY,
    EmbeddingSpec,
    SearchMethod,
    SearchOrigin,
    TraceSinkConfig,
    _registry_embedding_kwargs,
)
from .telemetry import SEARCH_TARGET_SKILL, trace_search, trace_search_async, trace_skill_load

__all__ = ["Skill", "SkillCatalog", "SkillHit", "SkillRegistry"]

_DenseResult = TypeVar("_DenseResult")


@dataclass
class Skill:
    """Skill metadata: what the index ranks and the capability tools surface."""

    id: str
    name: str
    description: str
    # Author-declared labels and task phrases ("frontend", "login form");
    # indexed for ranking.
    tags: list[str] = field(default_factory=list)
    # Ids of tools this skill's instructions call; surfaced into the
    # search_capabilities tools bucket — not indexed as query terms.
    tools: list[str] = field(default_factory=list)
    # Free-form, non-indexed context for higher layers — e.g.
    # {"stacks": ["react"]} for the push ranker to boost by project context.
    metadata: dict[str, list[str]] = field(default_factory=dict)
    body: str = ""


class SkillRegistry:
    """Typed Python facade over the private native skill registry."""

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
        self._native = _NativeSkillRegistry(**kwargs)
        self._eager = method in ("semantic", "hybrid")
        self._dense_gate = threading.Lock()
        self._dense_state = threading.Lock()
        self._dense_pending = 0
        self._dense_tasks: set[asyncio.Task[Any]] = set()

    @overload
    async def register(self, item: Skill) -> None: ...

    @overload
    async def register(self, item: Iterable[Skill]) -> None: ...

    @overload
    async def register(
        self,
        item: str,
        name: str,
        description: str,
        tags: list[str],
        tools: list[str],
        metadata: dict[str, list[str]],
        body: str,
    ) -> None: ...

    async def register(
        self,
        item: Skill | Iterable[Skill] | str,
        name: str | None = None,
        description: str | None = None,
        tags: list[str] | None = None,
        tools: list[str] | None = None,
        metadata: dict[str, list[str]] | None = None,
        body: str | None = None,
    ) -> None:
        """Register one `Skill`, many `Skill`s, or a flat (id, name, …) tuple.

        Stores metadata and — on a "semantic"/"hybrid" registry — embeds in one
        batched, off-thread pass (embedding errors surface here). "bm25" registers
        metadata only.
        """
        flat_args = (name, description, tags, tools, metadata, body)
        if isinstance(item, Skill):
            if any(value is not None for value in flat_args):
                raise TypeError("item register accepts only the Skill argument")
            skills: list[Skill] = [item]
        elif isinstance(item, str):
            if any(value is None for value in flat_args):
                raise TypeError("flat register requires all metadata arguments")
            skills = [Skill(item, name, description, tags, tools, metadata, body)]  # type: ignore[arg-type]
        else:
            if any(value is not None for value in flat_args):
                raise TypeError("iterable register accepts only the items argument")
            skills = list(item)
            if not all(isinstance(skill, Skill) for skill in skills):
                raise TypeError("register requires Skill items")
        self._register_items(skills)
        if self._eager:
            await self._build()

    def search(self, query: str, top_k: int) -> list[SkillHit]:
        """Run synchronous, model-free BM25 retrieval."""
        return self._native.search(query, top_k)

    def search_with_origin(self, query: str, top_k: int, origin: SearchOrigin) -> list[SkillHit]:
        """Run BM25 retrieval with an explicit trace origin."""
        return self._native.search_with_origin(query, top_k, origin)

    def search_with_method(
        self, query: str, top_k: int, origin: SearchOrigin, method: SearchMethod
    ) -> list[SkillHit]:
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
    ) -> list[SkillHit]:
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
        return await asyncio.shield(task)

    async def _run_dense_task(self, operation: Callable[[], _DenseResult]) -> _DenseResult:
        try:
            return await asyncio.to_thread(self._run_dense_worker, operation)
        finally:
            self._finish_dense()

    def _run_dense_worker(self, operation: Callable[[], _DenseResult]) -> _DenseResult:
        with self._dense_gate:
            return operation()

    def _dense_task_done(self, task: asyncio.Task[Any]) -> None:
        self._dense_tasks.discard(task)
        if not task.cancelled():
            task.exception()

    def _queue_dense(self) -> None:
        with self._dense_state:
            self._dense_pending += 1

    def _finish_dense(self) -> None:
        with self._dense_state:
            self._dense_pending -= 1

    def _register_items(self, skills: Iterable[Skill]) -> None:
        skills = list(skills)
        with self._dense_state:
            self._raise_if_busy()
            self._native._register_many(
                [
                    (
                        skill.id,
                        skill.name,
                        skill.description,
                        skill.tags,
                        skill.tools,
                        skill.metadata,
                        skill.body,
                    )
                    for skill in skills
                ]
            )

    def _raise_if_busy(self) -> None:
        if self._dense_pending:
            raise RuntimeError(_REGISTRY_BUSY)


class SkillCatalog:
    """Registry of skills. Register once, then search and load bodies by id."""

    def __init__(
        self,
        trace: TraceSinkConfig | None = None,
        method: SearchMethod = "bm25",
        embedding: EmbeddingSpec | None = None,
    ) -> None:
        """Create an empty skill catalog.

        Args:
            trace: where trace events go; `None` keeps the default no-op sink.
            method: default retrieval method for `search` — see
                `ToolCatalog.__init__`; dense defaults use `search_async` after
                an explicit `build_embeddings`.
            embedding: model for semantic/hybrid retrieval — see
                `ToolCatalog.__init__`; retained and validated under "bm25" too.
        """
        self._skills: dict[str, Skill] = {}
        self._method: SearchMethod = method
        self._registry = SkillRegistry(embedding, method=method)
        if trace is not None:
            self._registry.set_trace_sink(trace.kind, trace.session_id, trace.path)

    async def register(self, skills: Skill | Iterable[Skill]) -> None:
        """Register one skill or many — the single entry point for both.

        Stores metadata (name/description/tags are indexed; `tools`, `metadata`,
        `body` are stored but not indexed), then — on a "semantic"/"hybrid"
        catalog — embeds the skills in one batched, off-thread pass. Embedding
        errors surface **here**, at registration; a BM25 catalog never loads a
        model. Re-registering an id replaces it in place.

        A model or dimension change is not recovered in place — construct a new
        catalog and re-register.

        Args:
            skills: a single `Skill` or an iterable of them. Pass the whole batch
                at once for a single embedding request.

        Raises:
            EmbedderError: on a semantic/hybrid catalog, if embedding fails.
            RuntimeError: if a dense operation already owns the registry.
        """
        batch = [skills] if isinstance(skills, Skill) else list(skills)
        self._registry._register_items(batch)
        for skill in batch:
            self._skills[skill.id] = skill
        if self._method in ("semantic", "hybrid"):
            await self._registry._build()

    def search(
        self,
        query: str,
        top_k: int,
        origin: SearchOrigin = "direct",
        method: SearchMethod | None = None,
    ) -> list[SkillHit]:
        """Rank registered skills synchronously with BM25.

        The skill twin of `ToolCatalog.search`: a dense resolved method raises
        immediately with guidance to use `search_async`.

        Returns:
            Up to `top_k` `SkillHit`s, best first.
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
            SEARCH_TARGET_SKILL,
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
    ) -> list[SkillHit]:
        """Rank skills asynchronously with BM25, semantic, or hybrid retrieval.

        Dense methods require a complete cache built explicitly beforehand.
        """
        resolved_method = method or self._method
        return await trace_search_async(
            SEARCH_TARGET_SKILL,
            query,
            top_k,
            origin,
            lambda: self._registry.search_async(query, top_k, origin, resolved_method),
        )

    def has(self, skill_id: str) -> bool:
        """Return whether a skill with this id is registered."""
        return skill_id in self._skills

    def get(self, skill_id: str) -> Skill | None:
        """Return the registered `Skill` for an id, or `None` if unknown."""
        return self._skills.get(skill_id)

    def size(self) -> int:
        """Return the number of registered skills."""
        return len(self._skills)

    def record_event(self, event: dict[str, Any]) -> None:
        """Record a trace event into the catalog's sink.

        See `ToolCatalog.record_event` for the event contract.
        """
        self._registry.record_event(event)

    def drain_trace_events(self) -> list[dict[str, Any]]:
        """Drain captured trace envelopes; `[]` unless the sink is "memory"."""
        return self._registry.drain_trace_events()

    def invoke(self, skill_id: str) -> str:
        """Return a skill's body for dispatch, recording a `skill_invoke` event.

        Synchronous, unlike `ToolCatalog.invoke` — the body is already in
        memory, there is no handler to run.

        Args:
            skill_id: id of a registered skill.

        Returns:
            The skill's body (Markdown), verbatim as registered.

        Raises:
            ValueError: on an unknown id — callers at the capability-tool
                boundary translate this into a structured error for the agent.
        """
        skill = self._skills.get(skill_id)
        if skill is None:
            raise ValueError(f"unknown skillId: {skill_id}")

        def _run() -> str:
            started = time.monotonic()
            body = skill.body
            self._registry.record_event(
                {
                    "type": "skill_invoke",
                    "skill_id": skill_id,
                    "took_ms": int((time.monotonic() - started) * 1000),
                }
            )
            return body

        return trace_skill_load(skill_id, _run)
