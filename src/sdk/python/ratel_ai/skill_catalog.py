"""Skill catalog — the Python mirror of `src/sdk/ts/src/skill-catalog.ts`.

`SkillRegistry` (the BM25 index) comes from the native binding; `SkillCatalog` is
the on-demand analogue of `ToolCatalog`: registered skills are ranked by
relevance, and the matching body is fetched only on `invoke`.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable

from ._native import SkillHit, SkillRegistry, TraceSession
from .catalog import SearchOrigin, TraceSinkConfig

__all__ = ["Skill", "SkillCatalog", "SkillHit", "TracedSkillSearch"]


@dataclass
class Skill:
    """Skill metadata: what the index ranks and the gateway surfaces."""

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


@dataclass(frozen=True)
class TracedSkillSearch:
    """A skill search result plus the emitted event's id (TS `TracedSkillSearch`)."""

    # Id stamped on the emitted event — attributed to later invokes.
    search_id: str
    hits: list[SkillHit]


class SkillCatalog:
    """Registry of skills. Register once, then search and load bodies by id."""

    def __init__(
        self,
        trace: TraceSinkConfig | None = None,
        trace_session: TraceSession | None = None,
    ) -> None:
        self._registry = SkillRegistry()
        self._skills: dict[str, Skill] = {}
        # skill id → id of the most recent search that surfaced it (ADR-0013).
        self._last_search_id_by_skill: dict[str, str] = {}
        self._change_listeners: list[Callable[[], None]] = []
        # Shared session buffer — see `ToolCatalog`'s `trace_session`. Takes
        # precedence over `trace`.
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

    def register(self, skill: Skill) -> None:
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
        self._notify_change()

    def upsert(self, skill: Skill) -> bool:
        """Register-or-replace by id. Returns `True` when an existing skill was
        replaced. The path catalog sync uses to hot-reload a changed skill.
        """
        replaced = self._registry.upsert(
            skill.id,
            skill.name,
            skill.description,
            skill.tags,
            skill.tools,
            skill.metadata,
            skill.body,
        )
        self._skills[skill.id] = skill
        self._notify_change()
        return replaced

    def remove(self, skill_id: str) -> bool:
        """Remove a skill by id. Returns `True` when something was removed."""
        removed = self._registry.remove(skill_id)
        self._skills.pop(skill_id, None)
        self._last_search_id_by_skill.pop(skill_id, None)
        if removed:
            self._notify_change()
        return removed

    def on_change(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Subscribe to catalog mutations (register/upsert/remove). Returns an
        unsubscribe function. The staleness hook for MCP `tools/list_changed`
        notifications and other cache invalidation.
        """
        self._change_listeners.append(listener)

        def unsubscribe() -> None:
            if listener in self._change_listeners:
                self._change_listeners.remove(listener)

        return unsubscribe

    def _notify_change(self) -> None:
        for listener in list(self._change_listeners):
            listener()

    def search(self, query: str, top_k: int, origin: SearchOrigin = "direct") -> list[SkillHit]:
        return self.search_traced(query, top_k, origin).hits

    def search_traced(
        self, query: str, top_k: int, origin: SearchOrigin = "direct"
    ) -> TracedSkillSearch:
        """Like `search`, but also returns the emitted event's `search_id`."""
        search_id, hits = self._registry.search_with_trace(query, top_k, origin)
        for hit in hits:
            self._last_search_id_by_skill[hit.skill_id] = search_id
        return TracedSkillSearch(search_id=search_id, hits=hits)

    def last_search_id(self, skill_id: str) -> str | None:
        """Id of the most recent search that surfaced this skill, if any."""
        return self._last_search_id_by_skill.get(skill_id)

    def has(self, skill_id: str) -> bool:
        return skill_id in self._skills

    def get(self, skill_id: str) -> Skill | None:
        return self._skills.get(skill_id)

    def size(self) -> int:
        return len(self._skills)

    def record_event(self, event: dict[str, Any]) -> None:
        self._registry.record_event(event)

    def drain_trace_events(self) -> list[dict[str, Any]]:
        return self._registry.drain_trace_events()

    def invoke(self, skill_id: str) -> str:
        """Return a skill's body for dispatch, recording a `skill_invoke` event.

        Raises `ValueError` on an unknown id — callers at the gateway boundary
        translate that into a structured error for the agent.
        """
        skill = self._skills.get(skill_id)
        if skill is None:
            raise ValueError(f"unknown skillId: {skill_id}")
        started = time.monotonic()
        body = skill.body
        search_id = self._last_search_id_by_skill.get(skill_id)
        self._registry.record_event(
            {
                "type": "skill_invoke",
                "skill_id": skill_id,
                "took_ms": int((time.monotonic() - started) * 1000),
                **({"search_id": search_id} if search_id is not None else {}),
            }
        )
        return body
