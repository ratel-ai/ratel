"""Python SDK for Ratel — context engineering for AI agents.

Mirrors the public surface of the TypeScript SDK (`@ratel-ai/sdk`):
- `ToolRegistry` / `SearchHit`, `SkillRegistry` / `SkillHit` — metadata-only BM25
  indexes (native), one per corpus.
- `ToolCatalog` / `ExecutableTool` — registry plus executable handlers.
- `SkillCatalog` / `Skill` — the on-demand skill analogue of `ToolCatalog`.
- `search_capabilities_tool` / `invoke_tool_tool` / `get_skill_content_tool` —
  framework-neutral gateway tools.
- `TraceSession` — shared, bounded trace buffer for a whole session (ADR-0013).
- `register_mcp_server` — ingest an upstream MCP server's tools (extra: mcp).
"""

from ._native import SearchHit, SkillHit, SkillRegistry, ToolRegistry, TraceSession
from .catalog import (
    ExecutableTool,
    Executor,
    SearchOrigin,
    Tool,
    ToolCatalog,
    TracedSearch,
    TraceSinkConfig,
)
from .gateway import (
    INVOKE_TOOL_ID,
    SEARCH_CAPABILITIES_ID,
    OnUnauthorized,
    UpstreamServerInfo,
    format_upstream_line,
    invoke_tool_tool,
    search_capabilities_tool,
)

# Deprecated pre-0.2.0 surface (see gateway_compat.py) — kept so `ratel-ai==0.1.x`
# callers keep working after upgrading to 0.2.0. Slated for removal (RAT-250).
from .gateway_compat import SEARCH_TOOLS_ID, search_tools_tool
from .mcp import McpServerHandle, register_mcp_server
from .skill_catalog import Skill, SkillCatalog, TracedSkillSearch
from .skill_gateway import GET_SKILL_CONTENT_ID, get_skill_content_tool

__all__ = [
    "GET_SKILL_CONTENT_ID",
    "INVOKE_TOOL_ID",
    "SEARCH_CAPABILITIES_ID",
    "SEARCH_TOOLS_ID",
    "ExecutableTool",
    "Executor",
    "McpServerHandle",
    "OnUnauthorized",
    "SearchHit",
    "SearchOrigin",
    "Skill",
    "SkillCatalog",
    "SkillHit",
    "SkillRegistry",
    "Tool",
    "ToolCatalog",
    "ToolRegistry",
    "TraceSession",
    "TraceSinkConfig",
    "TracedSearch",
    "TracedSkillSearch",
    "UpstreamServerInfo",
    "format_upstream_line",
    "get_skill_content_tool",
    "invoke_tool_tool",
    "register_mcp_server",
    "search_capabilities_tool",
    "search_tools_tool",
]
