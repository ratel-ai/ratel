"""Adaptive usage ranking through the Python SDK (ADR-0013).

The catalog learns from what people invoke after a search, then ranks with it.
The load-bearing negative is that a query with no evidence behind it is
completely unaffected.
"""

import json

import pytest

from ratel_ai import ExecutableTool, IntentGraph, SkillCatalog, ToolCatalog
from ratel_ai.skill_catalog import Skill


async def build_catalog() -> ToolCatalog:
    """A catalog where lexical retrieval is confidently wrong.

    "why is the build broken" hits `docker_build` on the token *build*, while
    the tool people actually reach for is `gh_run_list`.
    """
    catalog = ToolCatalog()
    await catalog.register(
        [
            ExecutableTool(
                id="docker_build",
                name="docker_build",
                description="Build a Docker image from a Dockerfile",
                execute=lambda _args: "built",
            ),
            ExecutableTool(
                id="gh_run_list",
                name="gh_run_list",
                description="List CI workflow runs and whether the build passed",
                execute=lambda _args: "listed",
            ),
            ExecutableTool(
                id="read_file",
                name="read_file",
                description="Read a file from disk",
                execute=lambda _args: "read",
            ),
        ]
    )
    return catalog


def ids(hits) -> list[str]:
    return [hit.tool_id for hit in hits]


async def use_it(catalog: ToolCatalog, query: str, chosen: str) -> None:
    """One confirmed observation: search, then invoke what you actually wanted."""
    catalog.search(query, 5)
    await catalog.invoke(chosen, {})


@pytest.mark.asyncio
async def test_ranking_is_untouched_until_enabled() -> None:
    catalog = await build_catalog()
    assert ids(catalog.search("why is the build broken", 5))[0] == "docker_build"


@pytest.mark.asyncio
async def test_learns_from_use_and_then_ranks_better() -> None:
    catalog = await build_catalog()
    graph = IntentGraph()
    catalog.enable_adaptive_ranking(graph)
    assert graph.cluster_count == 0

    await use_it(catalog, "why is the build broken", "gh_run_list")
    await use_it(catalog, "is the build broken again", "gh_run_list")
    await use_it(catalog, "the build broken on main", "gh_run_list")

    assert graph.cluster_count == 1
    order = ids(catalog.search("why is the build broken", 5))
    assert order.index("gh_run_list") < order.index("docker_build")


@pytest.mark.asyncio
async def test_a_query_with_no_evidence_is_unaffected() -> None:
    baseline = ids((await build_catalog()).search("read a file from disk", 5))

    catalog = await build_catalog()
    catalog.enable_adaptive_ranking(IntentGraph())
    await use_it(catalog, "why is the build broken", "gh_run_list")
    await use_it(catalog, "is the build broken again", "gh_run_list")
    await use_it(catalog, "the build broken on main", "gh_run_list")

    assert ids(catalog.search("read a file from disk", 5)) == baseline


@pytest.mark.asyncio
async def test_learning_survives_a_restart_via_the_wire_form() -> None:
    """The graph is in memory, so this is how a restart keeps what was learned."""
    first = await build_catalog()
    graph = IntentGraph()
    first.enable_adaptive_ranking(graph)
    await use_it(first, "why is the build broken", "gh_run_list")
    await use_it(first, "is the build broken again", "gh_run_list")
    await use_it(first, "the build broken on main", "gh_run_list")

    restored = IntentGraph.from_json(graph.to_json())
    assert restored.cluster_count == 1

    second = await build_catalog()
    second.enable_adaptive_ranking(restored)
    order = ids(second.search("why is the build broken", 5))
    assert order.index("gh_run_list") < order.index("docker_build")


def test_a_future_schema_version_is_rejected() -> None:
    future = json.dumps({"v": 2, "half_life_days": 30, "built_from_ts": 1, "intents": []})
    with pytest.raises(ValueError, match="version"):
        IntentGraph.from_json(future)


@pytest.mark.asyncio
async def test_disabling_stops_ranking_but_keeps_what_was_learned() -> None:
    catalog = await build_catalog()
    graph = IntentGraph()
    catalog.enable_adaptive_ranking(graph)
    await use_it(catalog, "why is the build broken", "gh_run_list")
    await use_it(catalog, "is the build broken again", "gh_run_list")
    await use_it(catalog, "the build broken on main", "gh_run_list")

    catalog.disable_adaptive_ranking()
    assert ids(catalog.search("why is the build broken", 5))[0] == "docker_build"
    assert graph.cluster_count == 1
    assert "gh_run_list" in graph.to_json()


@pytest.mark.asyncio
async def test_one_graph_is_shared_between_tool_and_skill_catalogs() -> None:
    """One cluster, two edge maps.

    Giving each catalog its own graph would duplicate the cluster and split the
    evidence behind it.
    """
    graph = IntentGraph()
    tools = await build_catalog()
    skills = SkillCatalog()
    await skills.register(
        [
            Skill(
                id="ci-triage",
                name="ci-triage",
                description="Diagnose why the build failed in CI",
                tags=[],
                tools=[],
                metadata={},
                body="# steps",
            )
        ]
    )
    tools.enable_adaptive_ranking(graph)
    skills.enable_adaptive_ranking(graph)

    await use_it(tools, "why is the build broken", "gh_run_list")
    skills.search("why is the build broken", 5)
    skills.invoke("ci-triage")

    assert graph.cluster_count == 1
    wire = json.loads(graph.to_json())
    assert "gh_run_list" in wire["intents"][0]["tools"]
    assert "ci-triage" in wire["intents"][0]["skills"]
