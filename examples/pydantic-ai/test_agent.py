"""Model-free wiring test for the example.

`main.py` diagnostic mode prints the BM25 top-K and returns *before any tool is
constructed or called*, so it never exercised the path where the model invokes a
tool. This test closes that gap: pydantic-ai's `TestModel` drives the agent with
no API key, actually calling a BM25-selected (sync-executor) tool.

It is the guard for the class of bug rstagi caught — a top-K tool that raises
when invoked (e.g. a sync executor wrongly `await`-ed). Before the fix, this test
fails with `TypeError: object dict can't be used in 'await' expression`.
"""

from __future__ import annotations

from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel

from agent import build_tools
from tools import build_catalog


async def test_bm25_selected_tool_is_actually_invocable() -> None:
    catalog = build_catalog()
    tools = build_tools(catalog, "read a file from disk", initial_top_k=3)

    # The prompt must surface a real (non-gateway) sync-executor tool in the
    # top-K — that's the path the bug lived on.
    names = {t.name for t in tools}
    assert "read_file" in names, f"expected read_file in top-K, got {names}"

    # TestModel calls the named tool once with schema-generated args; no LLM,
    # no network. If the tool can't be executed, `run` raises here.
    agent = Agent(TestModel(call_tools=["read_file"]), tools=tools)
    result = await agent.run("read a file from disk")

    assert result.output is not None
