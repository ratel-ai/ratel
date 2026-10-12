"""Next-tool prediction from the tool transition graph (ADR-0028): the Python
mirror of next-tools.test.ts."""

from __future__ import annotations

from typing import Any

import pytest

from ratel_ai import ExecutableTool, IntentGraph, ToolCatalog

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
