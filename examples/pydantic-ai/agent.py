"""Wire a Ratel `ToolCatalog` into a Pydantic AI agent.

The pattern mirrors `examples/ai-sdk/src/agent.ts`:
1. BM25-prefilter the catalog for the prompt and expose the top-K directly.
2. Always expose the two gateway tools (`search_tools`, `invoke_tool`) so the
   agent can discover and call anything else in the catalog on demand.

Pydantic AI tools are built from the catalog's JSON schemas via `Tool.from_schema`,
so the same schema the model sees is the same one Ratel ranks.
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any

from pydantic_ai import Agent, Tool

from ratel_ai import ToolCatalog, invoke_tool_tool, search_tools_tool


@dataclass
class AgentResult:
    text: str
    active_tools: list[str]


def _tool_from_executable(execute, name: str, description: str, schema: dict[str, Any]) -> Tool:
    async def fn(**kwargs: Any) -> Any:
        # Catalog executors may be sync (plain dict-returning lambdas) or async
        # (`async def`); mirror `ToolCatalog.invoke` and only await awaitables.
        result = execute(kwargs)
        if inspect.isawaitable(result):
            result = await result
        return result

    fn.__name__ = name
    # `Tool.from_schema` defines a tool purely from a JSON schema — no Python
    # signature introspection — which is exactly what a dynamic catalog needs.
    return Tool.from_schema(fn, name=name, description=description, json_schema=schema)


def build_tools(catalog: ToolCatalog, prompt: str, initial_top_k: int = 3) -> list[Tool]:
    search = search_tools_tool(catalog)
    invoke = invoke_tool_tool(catalog)

    tools: dict[str, Tool] = {
        search.id: _tool_from_executable(
            search.execute, search.id, search.description, search.input_schema
        ),
        invoke.id: _tool_from_executable(
            invoke.execute, invoke.id, invoke.description, invoke.input_schema
        ),
    }

    for hit in catalog.search(prompt, initial_top_k):
        executable = catalog.get_executable(hit.tool_id)
        if executable is not None:
            tools[executable.id] = _tool_from_executable(
                executable.execute,
                executable.id,
                executable.description,
                executable.input_schema,
            )

    return list(tools.values())


async def run_agent(*, prompt: str, model: str, catalog: ToolCatalog) -> AgentResult:
    tools = build_tools(catalog, prompt)
    active = [t.name for t in tools]
    print(f"active tools: {', '.join(active)}")

    agent = Agent(model, tools=tools)
    result = await agent.run(prompt)
    return AgentResult(text=result.output, active_tools=active)
