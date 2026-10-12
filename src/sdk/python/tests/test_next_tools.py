"""Next-tool prediction from the tool transition graph (ADR-0028): the Python
mirror of next-tools.test.ts."""

from __future__ import annotations

import json
from typing import Any

import pytest

from ratel_ai import ExecutableTool, IntentGraph, ToolCatalog, search_capabilities_tool

QUERY = "assign task to developer"
IDS = ("find_task", "assign_task", "notify")


def _tool(tool_id: str) -> ExecutableTool:
    async def run(_args: dict[str, Any]) -> str:
        return tool_id

    return ExecutableTool(
        id=tool_id, name=tool_id, description=tool_id.replace("_", " "), execute=run
    )


async def _catalog() -> ToolCatalog:
    catalog = ToolCatalog()
    await catalog.register([_tool(i) for i in IDS])
    return catalog


async def _trained() -> tuple[ToolCatalog, IntentGraph]:
    """Ten turns of find -> assign, two of which go on to notify."""
    catalog = await _catalog()
    graph = IntentGraph()
    catalog.experimental_enable_adaptive_ranking(graph)
    for i in range(10):
        with catalog.turn():
            catalog.search(QUERY, 5, "agent")
            catalog.record_tool_call("find_task")
            catalog.record_tool_call("assign_task")
            if i < 2:
                catalog.record_tool_call("notify")
    return catalog, graph


async def test_predicts_the_strong_chain_of_a_new_turn_and_what_follows_a_tool() -> None:
    catalog, _ = await _trained()
    p = catalog.experimental_predict_next_tools(query=QUERY, ids=["assign_task"])
    assert [c["tool_id"] for c in p["chain"]] == ["find_task", "assign_task"]
    assert p["chain"][0]["from"] == "<start>"
    assert all(c["strong"] for c in p["chain"])
    (after,) = [a for a in p["after"] if a["tool_id"] == "assign_task"]
    assert after["next"][0]["tool_id"] == "notify"
    assert after["next"][0]["p"] == pytest.approx(2 / 11, rel=1e-5)
    assert after["next"][0]["strong"] is False


async def test_predicts_from_the_current_turns_last_tool() -> None:
    catalog, _ = await _trained()
    with catalog.turn():
        catalog.search(QUERY, 5, "agent")
        catalog.record_tool_call("find_task")
        p = catalog.experimental_predict_next_tools()
    assert [c["tool_id"] for c in p["chain"]] == ["assign_task"]


async def test_is_empty_without_adaptive_ranking() -> None:
    catalog = await _catalog()
    p = catalog.experimental_predict_next_tools(query=QUERY)
    assert (p["intent"], p["chain"], p["after"]) == (None, [], [])


async def test_follows_the_turn_with_learn_false_and_never_changes_the_graph() -> None:
    _, graph = await _trained()
    before = graph.to_json()
    consumer = await _catalog()
    consumer.experimental_enable_adaptive_ranking(graph, learn=False)
    with consumer.turn():
        consumer.search(QUERY, 5, "agent")
        consumer.record_tool_call("find_task")
        p = consumer.experimental_predict_next_tools(query=QUERY)
    assert [c["tool_id"] for c in p["chain"]] == ["assign_task"]
    assert graph.to_json() == before


async def _search(catalog: ToolCatalog, *, enabled: bool = True, **input: Any) -> dict[str, Any]:
    tool = search_capabilities_tool(catalog, experimental_next_tools=enabled)
    result: dict[str, Any] = await tool.execute({"query": QUERY, **input})
    return result


async def test_search_returns_the_chain_with_a_schema_only_for_tools_the_hits_lack() -> None:
    catalog, _ = await _trained()
    with catalog.turn():
        result = await _search(catalog, topKTools=1)
    hit_ids = {h["toolId"] for g in result["tools"]["groups"] for h in g["hits"]}
    nxt = result["experimentalNext"]
    assert [c["toolId"] for c in nxt["chain"]] == ["find_task", "assign_task"]
    for step in nxt["chain"]:
        assert ("inputSchema" in step) is (step["toolId"] not in hit_ids)
    (after,) = [a for a in nxt["after"] if a["toolId"] == "assign_task"]
    assert after["next"] == [{"toolId": "notify", "p": 0.18, "n": 10}]


async def test_search_hints_are_absent_unless_enabled() -> None:
    catalog, _ = await _trained()
    with catalog.turn():
        result = await _search(catalog, enabled=False)
    assert "experimentalNext" not in result


async def test_search_description_explains_hints_only_when_enabled() -> None:
    catalog, _ = await _trained()
    on = search_capabilities_tool(catalog, experimental_next_tools=True)
    assert "experimentalNext" in on.description
    assert "experimentalNext" not in search_capabilities_tool(catalog).description


async def test_a_followed_search_hint_never_counts_as_organic() -> None:
    catalog, graph = await _trained()
    with catalog.turn():
        await _search(catalog)
        catalog.record_tool_call("find_task")
    start = json.loads(graph.to_json())["transitions"]["<start>"]
    assert start["hinted"]["find_task"] == {"offered": 1, "followed": 1}
