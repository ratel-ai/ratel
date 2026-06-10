"""Gateway tools — the Python mirror of `src/sdk/ts/src/gateway.ts`.

`search_tools_tool` and `invoke_tool_tool` give an agent a self-service surface
over a `ToolCatalog`: discover tools by natural-language query, then invoke the
chosen one by id. The tool descriptions and JSON schemas here are a product
contract shown to the model — kept verbatim with the TS SDK.
"""

from __future__ import annotations

import inspect
import time
from collections.abc import Awaitable, Sequence
from dataclasses import dataclass
from typing import Any, Callable, Union

from .catalog import ExecutableTool, ToolCatalog

SEARCH_TOOLS_ID = "search_tools"
INVOKE_TOOL_ID = "invoke_tool"

SEARCH_TOOLS_BASE_DESCRIPTION = (
    "Discover tools beyond the ones already visible in your direct tool list. "
    "Call this BEFORE refusing a request, falling back to a generic capability "
    "(web fetch, shell, built-in search), or deciding none of the visible tools "
    "fits — a purpose-built tool may be in the catalog but not pre-loaded. "
    "Pass a natural-language query describing what you want to do; you'll get "
    "back the most relevant tool ids with their descriptions and input schemas. "
    "Then run the chosen one via invoke_tool."
)

_MAX_DESCRIPTION_LEN = 160


@dataclass
class UpstreamServerInfo:
    name: str
    description: str | None = None
    instructions: str | None = None
    tool_count: int | None = None
    # True when the upstream rejected its boot connection with 401 / re-auth needed.
    needs_auth: bool = False


def format_upstream_line(s: UpstreamServerInfo) -> str:
    line = f"- {s.name}"
    if s.description:
        line += f" — {_compact_description(s.description)}"
    if s.tool_count is not None:
        line += f" ({s.tool_count} tools)"
    if s.needs_auth:
        line += " (auth required)"
    return line


def _compact_description(s: str) -> str:
    collapsed = " ".join(s.split())
    if len(collapsed) <= _MAX_DESCRIPTION_LEN:
        return collapsed
    cut = collapsed[: _MAX_DESCRIPTION_LEN - 1]
    last_space = cut.rfind(" ")
    head = cut[:last_space] if last_space > 80 else cut
    return f"{head.rstrip()}…"


def _build_search_tools_description(
    upstreams: Sequence[UpstreamServerInfo],
) -> str:
    if not upstreams:
        return SEARCH_TOOLS_BASE_DESCRIPTION
    listing = "\n".join(format_upstream_line(u) for u in upstreams)
    return (
        f"{SEARCH_TOOLS_BASE_DESCRIPTION}\n\n"
        f"This catalog aggregates tools from these upstream MCP servers:\n{listing}"
    )


def search_tools_tool(
    catalog: ToolCatalog,
    *,
    upstream_servers: Sequence[UpstreamServerInfo] | None = None,
) -> ExecutableTool:
    upstreams = list(upstream_servers or [])
    upstream_by_name = {u.name: u for u in upstreams}

    async def execute(input: dict[str, Any]) -> dict[str, Any]:
        query = input["query"]
        top_k = input.get("topK")
        k = top_k if isinstance(top_k, int) and top_k > 0 else 5
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
                    "type": "number",
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


# Notified when the underlying tool raises UnauthorizedError, with the upstream
# name inferred from the toolId. May be sync or async.
OnUnauthorized = Callable[[str], Union[Awaitable[None], None]]


def invoke_tool_tool(
    catalog: ToolCatalog,
    *,
    on_unauthorized: OnUnauthorized | None = None,
) -> ExecutableTool:
    async def execute(input: dict[str, Any]) -> Any:
        tool_id = input["toolId"]
        if not catalog.has(tool_id):
            catalog.record_event(
                {"type": "gateway_error", "tool_id": tool_id, "error": "unknown_tool_id"}
            )
            return {
                "error": (
                    f"unknown toolId: {tool_id}. "
                    "Use search_tools to discover available ids."
                )
            }
        nested = input.get("args")
        if isinstance(nested, dict):
            args = nested
        else:
            args = {k: v for k, v in input.items() if k != "toolId"}
        started_at = time.monotonic()
        try:
            result = await catalog.invoke(tool_id, args)
            catalog.record_event(
                {
                    "type": "gateway_invoke",
                    "tool_id": tool_id,
                    "took_ms": int((time.monotonic() - started_at) * 1000),
                }
            )
            return result
        except Exception as err:
            if _is_unauthorized_error(err):
                upstream = _upstream_from_tool_id(tool_id)
                if upstream and on_unauthorized is not None:
                    maybe = on_unauthorized(upstream)
                    if inspect.isawaitable(maybe):
                        await maybe
                catalog.record_event(
                    {"type": "gateway_error", "tool_id": tool_id, "error": "needs_auth"}
                )
                payload: dict[str, Any] = {
                    "error": "needs_auth",
                    "hint": "call the auth tool to re-authorize"
                    + (f" {upstream}" if upstream else ""),
                }
                if upstream:
                    payload["upstream"] = upstream
                return payload
            catalog.record_event(
                {"type": "gateway_error", "tool_id": tool_id, "error": str(err)}
            )
            return {"error": f"tool {tool_id} threw: {err}"}

    return ExecutableTool(
        id=INVOKE_TOOL_ID,
        name=INVOKE_TOOL_ID,
        description=(
            "Invoke a tool from the catalog by its id. Use this to call tools that "
            "aren't in your direct tool list — first find one via search_tools, then "
            "run it here. Pass the tool's arguments nested under the `args` field — "
            "do NOT flatten them to the top level."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "toolId": {
                    "type": "string",
                    "description": (
                        "id of the tool to invoke "
                        "(use search_tools to find available ids)"
                    ),
                },
                "args": {
                    "type": "object",
                    "description": (
                        "arguments object matching the tool's inputSchema, "
                        "nested as a single object"
                    ),
                    "additionalProperties": True,
                },
            },
            "required": ["toolId", "args"],
        },
        output_schema={"type": "object"},
        execute=execute,
    )


def _is_unauthorized_error(err: BaseException) -> bool:
    return type(err).__name__ == "UnauthorizedError"


def _upstream_from_tool_id(tool_id: str) -> str | None:
    idx = tool_id.find("__")
    if idx <= 0:
        return None
    return tool_id[:idx]
