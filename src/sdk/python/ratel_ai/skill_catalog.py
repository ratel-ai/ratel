"""Skill catalog — the Python mirror of `src/sdk/ts/src/skill-catalog.ts`.

`SkillRegistry` (the BM25 index) comes from the native binding; `SkillCatalog` is
the on-demand analogue of `ToolCatalog`: registered skills are ranked by
relevance, and the matching body is fetched only on `invoke`.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ._native import SkillHit, SkillRegistry
from .catalog import SearchMethod, SearchOrigin, TraceSinkConfig
from .telemetry import SEARCH_TARGET_SKILL, trace_search, trace_skill_load

__all__ = ["Skill", "SkillCatalog", "SkillHit"]


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


class SkillCatalog:
    """Registry of skills: search, load bodies by id, and mutate at runtime.

    The mutation surface is the loader-facing seam: an external loader (any
    package holding a catalog and mirroring a source into it) pushes with
    `upsert`, drops with `remove`, and the host observes churn via `on_change`.
    """

    def __init__(
        self,
        trace: TraceSinkConfig | None = None,
        method: SearchMethod = "bm25",
    ) -> None:
        """Create an empty skill catalog.

        Args:
            trace: where trace events go; `None` keeps the default no-op sink.
            method: default retrieval method for `search` — see
                `ToolCatalog.__init__`; a semantic/hybrid catalog eagerly
                embeds each skill at registration.
        """
        self._registry = SkillRegistry()
        self._skills: dict[str, Skill] = {}
        self._method: SearchMethod = method
        self._eager: bool = method in ("semantic", "hybrid")
        self._listeners: set[Callable[[], None]] = set()
        if trace is not None:
            self._registry.set_trace_sink(trace.kind, trace.session_id, trace.path)

    def register(self, skill: Skill) -> None:
        """Add a skill to the catalog (metadata into the index, body stored).

        Registering an id that is already present replaces it in place — the
        index never holds a duplicate. Name, description and tags are indexed
        for ranking; `tools`, `metadata` and `body` are stored but not indexed.

        Args:
            skill: the skill to register.

        Raises:
            RuntimeError: on a semantic/hybrid catalog, if the embedding model
                fails to load while eagerly embedding the new skill — the skill
                is registered by then, so subscribers are still notified before
                the error propagates.
        """
        self._registry.register(
            skill.id,
            skill.name,
            skill.description,
            skill.tags,
            skill.tools,
            skill.metadata,
            skill.body,
        )
        self._skills[skill.id] = skill
        try:
            if self._eager:
                self._registry.build_embeddings()
        finally:
            # The mutation is committed above; a failed eager embed must not
            # swallow the staleness signal.
            self._notify_change()

    def upsert(self, skill: Skill) -> bool:
        """`register` that also reports whether the id was already present.

        The added-vs-replaced signal an external loader needs to mirror a
        source into the catalog. Same replace-in-place, eager-embedding, and
        change-notification behavior as `register`.

        Args:
            skill: the skill to add or replace; `id` is its lookup key.

        Returns:
            `True` when an already-registered id was replaced, `False` when
            the skill is new.
        """
        replaced = skill.id in self._skills
        self.register(skill)
        return replaced

    def remove(self, skill_id: str) -> bool:
        """Remove a skill by id.

        The index entry and its cached embedding drop together, so a
        semantic/hybrid catalog keeps searching with no rebuild. Notifies
        `on_change` subscribers on a hit; an unknown id is a silent no-op
        (no notification).

        Args:
            skill_id: id of the skill to remove.

        Returns:
            `True` when the id was present, `False` otherwise.
        """
        removed = self._registry.remove(skill_id)
        self._skills.pop(skill_id, None)
        if removed:
            self._notify_change()
        return removed

    def on_change(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Subscribe to catalog churn.

        The listener fires after every mutation — `register`, `upsert`, and a
        `remove` that hit. It is a low-level signal (an initial registration
        burst fires it per skill; debouncing is the subscriber's job) and the
        single staleness hook for hosts: re-emit `tools/list_changed` from it,
        and if the `search_capabilities` description was cached, re-read it on
        an empty↔non-empty transition. A listener that raises is swallowed —
        it breaks neither the mutation nor other listeners. Subscribing the
        same function twice keeps one subscription.

        Args:
            listener: called (with no arguments) after each mutation.

        Returns:
            An unsubscribe function; call it to stop the notifications.
        """
        self._listeners.add(listener)

        def unsubscribe() -> None:
            self._listeners.discard(listener)

        return unsubscribe

    def build_embeddings(self) -> None:
        """Pre-compute embeddings for not-yet-embedded skills.

        See `ToolCatalog.build_embeddings` for when to call and what it raises.
        """
        self._registry.build_embeddings()

    def search(
        self,
        query: str,
        top_k: int,
        origin: SearchOrigin = "direct",
        method: SearchMethod | None = None,
    ) -> list[SkillHit]:
        """Rank registered skills against a natural-language query.

        The skill twin of `ToolCatalog.search` — same arguments, same
        method-override and `ValueError`/`RuntimeError` semantics, ranked
        against the skill corpus.

        Returns:
            Up to `top_k` `SkillHit`s, best first.
        """
        return trace_search(
            SEARCH_TARGET_SKILL,
            query,
            top_k,
            origin,
            lambda: self._registry.search_with_method(query, top_k, origin, method or self._method),
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

    def _notify_change(self) -> None:
        """Fire every subscriber over a snapshot; a raising one is isolated."""
        for listener in tuple(self._listeners):
            try:
                listener()
            except Exception:
                # A bad subscriber must not break the mutation or its siblings.
                pass
