from __future__ import annotations

from typing import Any

from .models import McpTool

try:
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client
    _HAS_MCP = True
except ImportError:
    _HAS_MCP = False

_client_cache: dict[str, Any] = {}


async def mcp_tools(*, server: str) -> list[McpTool]:
    """Connect to an MCP server and return its tools as McpTool instances.

    Requires the ``mcp`` package: ``pip install agentified[mcp]``
    """
    if not _HAS_MCP:
        raise ImportError(
            "The 'mcp' package is required for MCP tool support. "
            "Install it with: pip install agentified[mcp]"
        )

    if server not in _client_cache:
        async with streamablehttp_client(server) as (read_stream, write_stream, _):
            session = ClientSession(read_stream, write_stream)
            async with session:
                await session.initialize()
                _client_cache[server] = session

                all_tools: list[dict[str, Any]] = []
                cursor: str | None = None
                while True:
                    result = await session.list_tools(cursor=cursor)
                    for t in result.tools:
                        all_tools.append({
                            "name": t.name,
                            "description": t.description or "",
                            "inputSchema": dict(t.inputSchema) if t.inputSchema else {},
                        })
                    cursor = getattr(result, "nextCursor", None)
                    if not cursor:
                        break

    else:
        session = _client_cache[server]
        all_tools = []
        cursor = None
        while True:
            result = await session.list_tools(cursor=cursor)
            for t in result.tools:
                all_tools.append({
                    "name": t.name,
                    "description": t.description or "",
                    "inputSchema": dict(t.inputSchema) if t.inputSchema else {},
                })
            cursor = getattr(result, "nextCursor", None)
            if not cursor:
                break

    cached_session = _client_cache.get(server)

    def _make_handler(tool_name: str, srv: str):
        async def handler(args: dict[str, Any]) -> Any:
            s = _client_cache.get(srv)
            if s is None:
                raise RuntimeError(f"MCP session for {srv} not found. Call mcp_tools() first.")
            try:
                return await s.call_tool(tool_name, args)
            except Exception as err:
                _client_cache.pop(srv, None)
                return {
                    "isError": True,
                    "content": [{"type": "text", "text": f"MCP tool '{tool_name}' failed: {err}"}],
                }
        return handler

    return [
        McpTool(
            name=t["name"],
            description=t["description"],
            parameters=t["inputSchema"],
            server=server,
            handler=_make_handler(t["name"], server),
        )
        for t in all_tools
    ]


def _reset_client_cache() -> None:
    """Test-only: clear the MCP client cache."""
    _client_cache.clear()
