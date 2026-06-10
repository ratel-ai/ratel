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
from .catalog import SearchOrigin, TraceSinkConfig

__all__ = ["Skill", "SkillCatalog", "SkillHit"]


@dataclass
class Skill:
    """Skill metadata: what the index ranks and the gateway surfaces."""

    id: str
    name: str
    description: str
    tags: list[str] = field(default_factory=list)
    # Author-declared task phrases ("login form"); indexed for ranking.
    triggers: list[str] = field(default_factory=list)
    # Project stacks the skill applies to ("react"); carried for the push-path
    # ranker to boost by context — not indexed as query terms.
    stacks: list[str] = field(default_factory=list)
    body: str = ""


class SkillCatalog:
    """Registry of skills. Register once, then search and load bodies by id."""

    def __init__(self, trace: TraceSinkConfig | None = None) -> None:
        self._registry = SkillRegistry()
        self._skills: dict[str, Skill] = {}
        if trace is not None:
            self._registry.set_trace_sink(trace.kind, trace.session_id, trace.path)

    def register(self, skill: Skill) -> None:
        self._registry.register(
            skill.id,
            skill.name,
            skill.description,
            skill.tags,
            skill.triggers,
            skill.stacks,
            skill.body,
        )
        self._skills[skill.id] = skill

    def search(self, query: str, top_k: int, origin: SearchOrigin = "direct") -> list[SkillHit]:
        return self._registry.search_with_origin(query, top_k, origin)

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
