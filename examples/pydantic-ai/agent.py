"""Wire a Ratel `ToolCatalog` into a Pydantic AI agent.

The pattern mirrors `examples/ai-sdk/src/agent.ts`:
1. BM25-prefilter the catalog for the prompt and expose the top-K directly.
2. Always expose the two gateway tools (`search_capabilities`, `invoke_tool`) so the
   agent can discover and call anything else in the catalog on demand.

Pydantic AI tools are built from the catalog's JSON schemas via `Tool.from_schema`,
so the same schema the model sees is the same one Ratel ranks.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic_ai import Agent, Tool

from ratel_ai import ToolCatalog, invoke_tool_tool, search_capabilities_tool


@dataclass
class AgentResult:
    text: str
    active_tools: list[str]


def _tool_from_fn(fn: Any, name: str, description: str, schema: dict[str, Any]) -> Tool:
    fn.__name__ = name
    # `Tool.from_schema` defines a tool purely from a JSON schema — no Python
    # signature introspection — which is exactly what a dynamic catalog needs.
    return Tool.from_schema(fn, name=name, description=description, json_schema=schema)


def _catalog_tool(catalog: ToolCatalog, tool_id: str, description: str, schema: dict[str, Any]) -> Tool:
    """Dispatch a real catalog tool through `ToolCatalog.invoke`.

    `invoke` is the SDK's tested entry point: it handles sync *and* async
    executors and emits the `invoke_*` trace events. The example deliberately
    does NOT re-implement that — re-wrapping the raw `execute` is how a sync
    executor ends up wrongly `await`-ed.
    """

    async def fn(**kwargs: Any) -> Any:
        return await catalog.invoke(tool_id, kwargs)

    return _tool_from_fn(fn, tool_id, description, schema)


def _gateway_tool(execute: Any, name: str, description: str, schema: dict[str, Any]) -> Tool:
    """Wrap a gateway meta-tool (`search_capabilities` / `invoke_tool`).

    These are not catalog entries; they own `async def` `execute` handlers, so
    they're awaited directly rather than routed through `catalog.invoke`.
    """

    async def fn(**kwargs: Any) -> Any:
        return await execute(kwargs)

    return _tool_from_fn(fn, name, description, schema)


def build_tools(catalog: ToolCatalog, prompt: str, initial_top_k: int = 3) -> list[Tool]:
    search = search_capabilities_tool(catalog)
    invoke = invoke_tool_tool(catalog)

    tools: dict[str, Tool] = {
        search.id: _gateway_tool(search.execute, search.id, search.description, search.input_schema),
        invoke.id: _gateway_tool(invoke.execute, invoke.id, invoke.description, invoke.input_schema),
    }

    for hit in catalog.search(prompt, initial_top_k):
        executable = catalog.get_executable(hit.tool_id)
        if executable is not None:
            tools[executable.id] = _catalog_tool(
                catalog,
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
