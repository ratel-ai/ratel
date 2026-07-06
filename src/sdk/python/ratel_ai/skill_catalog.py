"""Skill catalog — the Python mirror of `src/sdk/ts/src/skill-catalog.ts`.

`SkillRegistry` (the BM25 index) comes from the native binding; `SkillCatalog` is
the on-demand analogue of `ToolCatalog`: registered skills are ranked by
relevance, and the matching body is fetched only on `invoke`.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from ._native import SkillHit, SkillRegistry
from .catalog import SearchMethod, SearchOrigin, TraceSinkConfig

__all__ = ["Skill", "SkillCatalog", "SkillHit"]


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


class SkillCatalog:
    """Registry of skills. Register once, then search and load bodies by id."""

    def __init__(
        self,
        trace: TraceSinkConfig | None = None,
        method: SearchMethod = "bm25",
    ) -> None:
        self._registry = SkillRegistry()
        self._skills: dict[str, Skill] = {}
        self._method: SearchMethod = method
        self._eager: bool = method in ("semantic", "hybrid")
        if trace is not None:
            self._registry.set_trace_sink(trace.kind, trace.session_id, trace.path)

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
        if self._eager:
            self._registry.warm()

    def warm(self) -> None:
        """Pre-compute embeddings for not-yet-embedded skills. See
        `ToolCatalog.warm`."""
        self._registry.warm()

    def search(
        self,
        query: str,
        top_k: int,
        origin: SearchOrigin = "direct",
        method: SearchMethod | None = None,
    ) -> list[SkillHit]:
        return self._registry.search_with_method(query, top_k, origin, method or self._method)

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
        self._registry.record_event(
            {
                "type": "skill_invoke",
                "skill_id": skill_id,
                "took_ms": int((time.monotonic() - started) * 1000),
            }
        )
        return body
