"""Python SDK for Ratel — context engineering for AI agents.

Mirrors the public surface of the TypeScript SDK (`@ratel-ai/sdk`):
- `ToolRegistry` / `SearchHit` — metadata-only BM25 index (native).
- `ToolCatalog` / `ExecutableTool` — registry plus executable handlers.
- `search_tools_tool` / `invoke_tool_tool` — framework-neutral gateway tools.
- `register_mcp_server` — ingest an upstream MCP server's tools (extra: mcp).
"""

from ._native import SearchHit, ToolRegistry
from .catalog import (
    ExecutableTool,
    Executor,
    SearchOrigin,
    Tool,
    ToolCatalog,
    TraceSinkConfig,
)
from .gateway import (
    INVOKE_TOOL_ID,
    SEARCH_TOOLS_ID,
    OnUnauthorized,
    UpstreamServerInfo,
    format_upstream_line,
    invoke_tool_tool,
    search_tools_tool,
)
from .mcp import McpServerHandle, register_mcp_server
from .observability import (
    ObservabilityConfig,
    Observation,
    RatelClient,
    Trace,
    configure,
    get_client,
    observe,
    set_global_client,
)

__all__ = [
    "INVOKE_TOOL_ID",
    "SEARCH_TOOLS_ID",
    "ExecutableTool",
    "Executor",
    "McpServerHandle",
    "Observation",
    "ObservabilityConfig",
    "OnUnauthorized",
    "RatelClient",
    "SearchHit",
    "SearchOrigin",
    "Tool",
    "ToolCatalog",
    "Trace",
    "TraceSinkConfig",
    "UpstreamServerInfo",
    "configure",
    "format_upstream_line",
    "get_client",
    "invoke_tool_tool",
    "observe",
    "register_mcp_server",
    "search_tools_tool",
    "set_global_client",
    "ToolRegistry",
]
