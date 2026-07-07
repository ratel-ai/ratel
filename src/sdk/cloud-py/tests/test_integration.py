"""End-to-end over real HTTP: a `MockSource` hydrates a real
`ratel_ai.SkillCatalog`, and the capability tools surface the synced skills —
discovery, live advertising, source-side removal, and the ownership rule."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any

import pytest
from ratel_ai import Skill, SkillCatalog, ToolCatalog, search_capabilities_tool

from ratel_ai_cloud import create_skill_sync
from ratel_ai_cloud.testing.mock_source import MockSource

API_KEY = "test-key"

DEPLOY_SKILL: dict[str, Any] = {
    "id": "deploy-frontend",
    "name": "deploy-frontend",
    "description": "Deploy the frontend app to production with smoke checks.",
    "tags": ["deploy", "frontend"],
    "tools": [],
    "metadata": {"stacks": ["react"]},
    "body": "# Deploy the frontend\n1. Build.\n2. Ship.\n",
}


@pytest.fixture()
def source() -> Iterator[MockSource]:
    with MockSource(api_key=API_KEY) as src:
        src.set_skills([DEPLOY_SKILL])
        yield src


def _search(tool: Any, query: str) -> dict[str, Any]:
    result: dict[str, Any] = asyncio.run(tool.execute({"query": query}))
    return result


def test_synced_skills_flow_through_the_capability_tools(source: MockSource) -> None:
    skills = SkillCatalog()
    search = search_capabilities_tool(ToolCatalog(), skills)

    # Before hydration the tool advertises no skills bucket.
    assert "get_skill_content" not in search.description

    sync = create_skill_sync(skills, url=source.url, api_key=API_KEY, env={})

    # The live description reflects the hydrated catalog without rebuilding.
    assert "get_skill_content" in search.description

    hits = _search(search, "deploy the frontend to production")["skills"]
    assert [h["skillId"] for h in hits] == ["deploy-frontend"]
    assert skills.invoke("deploy-frontend") == DEPLOY_SKILL["body"]

    # A source-side removal disappears on the next refresh.
    source.set_skills([])
    sync.refresh()
    assert not skills.has("deploy-frontend")
    assert _search(search, "deploy the frontend to production")["skills"] == []
    assert "get_skill_content" not in search.description
    sync.stop()


def test_host_collision_lands_in_conflicts_untouched(source: MockSource) -> None:
    skills = SkillCatalog()
    host_skill = Skill(
        id="deploy-frontend",
        name="host-deploy",
        description="The host's own deploy playbook.",
        body="host body\n",
    )
    skills.register(host_skill)

    sync = create_skill_sync(skills, url=source.url, api_key=API_KEY, env={})
    assert skills.get("deploy-frontend") == host_skill
    assert sync.owned_count == 0

    # A source-side change re-reports the conflict on the 200 path — and still
    # never touches the host's skill.
    source.set_skills([{**DEPLOY_SKILL, "body": "still not yours\n"}])
    result = sync.refresh()
    assert result.conflicts == ["deploy-frontend"]
    assert skills.get("deploy-frontend") == host_skill
    assert sync.owned_count == 0
    sync.stop()
