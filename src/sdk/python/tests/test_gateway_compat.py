"""Tests for the deprecated 0.1.x compatibility shim.

Mirrors `src/sdk/ts/src/gateway-compat.test.ts`: the pre-0.2.0 `search_tools_tool`
keeps its `search_tools` id and tools-only ``{groups}`` result so code written
against `ratel-ai==0.1.x` keeps working after upgrading to 0.2.0.
"""

from ratel_ai import SEARCH_TOOLS_ID, ToolCatalog, TraceSinkConfig, search_tools_tool
from ratel_ai.catalog import ExecutableTool


def _tool(tool_id: str, description: str) -> ExecutableTool:
    return ExecutableTool(
        id=tool_id,
        name=tool_id,
        description=description,
        input_schema={"type": "object", "properties": {}},
        output_schema={"type": "object"},
        execute=lambda args: {},
    )


async def test_search_tools_keeps_old_id_and_groups_shape() -> None:
    catalog = ToolCatalog()
    catalog.register(_tool("ci__deploy", "Deploy the project to production."))
    tool = search_tools_tool(catalog)

    assert tool.id == SEARCH_TOOLS_ID == "search_tools"
    result = await tool.execute({"query": "deploy to production"})
    # Old shape: a top-level `groups`, not the new {tools, skills} buckets.
    assert "groups" in result
    assert "tools" not in result
    assert "skills" not in result
    assert result["groups"][0]["hits"][0]["toolId"] == "ci__deploy"


async def test_search_tools_respects_top_k() -> None:
    catalog = ToolCatalog()
    for i in range(5):
        catalog.register(_tool(f"ci__t{i}", "deploy the project to production"))
    tool = search_tools_tool(catalog)
    result = await tool.execute({"query": "deploy", "topK": 2})
    n = sum(len(g["hits"]) for g in result["groups"])
    assert n <= 2


async def test_search_tools_gateway_search_carries_search_id_and_tool_hits() -> None:
    catalog = ToolCatalog(trace=TraceSinkConfig(kind="memory", session_id="t"))
    catalog.register(_tool("ci__deploy", "Deploy the project to production."))
    tool = search_tools_tool(catalog)
    catalog.drain_trace_events()

    await tool.execute({"query": "deploy to production"})

    events = catalog.drain_trace_events()
    gw = next(e for e in events if e["type"] == "gateway_search")
    assert isinstance(gw["search_id"], str)
    tool_hits = gw["tool_hits"]
    assert tool_hits[0]["tool_id"] == "ci__deploy"
    assert tool_hits[0]["rank"] == 0
    assert gw["hits"] == len(tool_hits)
