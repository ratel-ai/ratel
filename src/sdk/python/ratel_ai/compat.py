"""Backward-compatibility shim for the pre-0.2.0 capability-tools surface.

0.2.0 renamed `search_tools` → `search_capabilities` and changed its result
shape from `{groups}` to `{tools: {groups}, skills}`. To keep code written
against `ratel-ai==0.1.x` working after an upgrade, the old `search_tools_tool` /
`SEARCH_TOOLS_ID` are preserved here **with their original behaviour** — a
tools-only `{groups}` result and the `search_tools` id — not aliased to the new
two-bucket tool.

Deprecated:
    Since 0.2.0: migrate to `ratel_ai.search_capabilities_tool` /
    `ratel_ai.SEARCH_CAPABILITIES_ID`. Tracked for removal in RAT-250.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from typing import Any

from .capabilities import UpstreamServerInfo, format_upstream_line
from .catalog import ExecutableTool, ToolCatalog

SEARCH_TOOLS_ID = "search_tools"
"""Id (and name) of the deprecated pre-0.2.0 discovery tool built by
`search_tools_tool`; superseded by `ratel_ai.SEARCH_CAPABILITIES_ID`.
"""

_SEARCH_TOOLS_BASE_DESCRIPTION = (
    "Discover tools beyond the ones already visible in your direct tool list. "
    "Call this BEFORE refusing a request, falling back to a generic capability "
    "(web fetch, shell, built-in search), or deciding none of the visible tools "
    "fits — a purpose-built tool may be in the catalog but not pre-loaded. "
    "Pass a natural-language query describing what you want to do; you'll get "
    "back the most relevant tool ids with their descriptions and input schemas. "
    "Then run the chosen one via invoke_tool."
)


def _build_search_tools_description(upstreams: Sequence[UpstreamServerInfo]) -> str:
    if not upstreams:
        return _SEARCH_TOOLS_BASE_DESCRIPTION
    listing = "\n".join(format_upstream_line(u) for u in upstreams)
    return (
        f"{_SEARCH_TOOLS_BASE_DESCRIPTION}\n\n"
        f"This catalog aggregates tools from these upstream MCP servers:\n{listing}"
    )


def search_tools_tool(
    catalog: ToolCatalog,
    *,
    upstream_servers: Sequence[UpstreamServerInfo] | None = None,
) -> ExecutableTool:
    """Build the pre-0.2.0 tools-only discovery tool (id ``search_tools``).

    Keeps the original behaviour: a flat ``{groups}`` result and no skills
    bucket. New code should use `ratel_ai.search_capabilities_tool` instead.
    Registering both lets a host serve the old and new names during a
    migration window.

    Args:
        catalog: the tool catalog to search.
        upstream_servers: upstream MCP servers to advertise in the tool
            description and to enrich result server groups with.

    Returns:
        An `ExecutableTool` to put in the agent's direct tool list.

    Deprecated:
        Since 0.2.0: use `ratel_ai.search_capabilities_tool`. Tracked for
        removal in RAT-250.
    """
    upstreams = list(upstream_servers or [])
    upstream_by_name = {u.name: u for u in upstreams}

    async def execute(input: dict[str, Any]) -> dict[str, Any]:
        query = input["query"]
        top_k = input.get("topK")
        k = top_k if isinstance(top_k, int) and not isinstance(top_k, bool) and top_k > 0 else 5
        started_at = time.monotonic()
        hits = catalog.search(query, k, "agent")
        catalog.record_event(
            {
                "type": "gateway_search",
                "query": query,
                "origin": "agent",
                "top_k": k,
                "hits": len(hits),
                "took_ms": int((time.monotonic() - started_at) * 1000),
            }
        )
        order: list[str] = []
        groups: dict[str, dict[str, Any]] = {}
        for h in hits:
            sep = h.tool_id.find("__")
            server_name = h.tool_id[:sep] if sep > 0 else h.tool_id
            group = groups.get(server_name)
            if group is None:
                meta = upstream_by_name.get(server_name)
                server: dict[str, Any] = {"name": server_name}
                if meta is not None and meta.description:
                    server["description"] = meta.description
                if meta is not None and meta.instructions:
                    server["instructions"] = meta.instructions
                group = {"server": server, "hits": []}
                groups[server_name] = group
                order.append(server_name)
            tool = catalog.get(h.tool_id)
            group["hits"].append(
                {
                    "toolId": h.tool_id,
                    "score": h.score,
                    "description": tool.description if tool else "",
                    "inputSchema": tool.input_schema if tool else {},
                }
            )
        return {"groups": [groups[n] for n in order]}

    return ExecutableTool(
        id=SEARCH_TOOLS_ID,
        name=SEARCH_TOOLS_ID,
        description=_build_search_tools_description(upstreams),
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "describe what you want to do"},
                "topK": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "max number of tool ids to return (default 5)",
                },
            },
            "required": ["query"],
        },
        output_schema={
            "type": "object",
            "properties": {
                "groups": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "server": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string"},
                                    "description": {"type": "string"},
                                    "instructions": {"type": "string"},
                                },
                                "required": ["name"],
                            },
                            "hits": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "toolId": {"type": "string"},
                                        "score": {"type": "number"},
                                        "description": {"type": "string"},
                                        "inputSchema": {"type": "object"},
                                    },
                                },
                            },
                        },
                        "required": ["server", "hits"],
                    },
                },
            },
            "required": ["groups"],
        },
        execute=execute,
    )
