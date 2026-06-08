"""Upstream MCP ingestion — the Python mirror of `src/sdk/ts/src/mcp.ts`.

`register_mcp_server` lists an upstream MCP server's tools, registers each into a
`ToolCatalog` under a namespaced id (`<server>__<tool>`), and wires each executor
to the upstream `call_tool`. The same `upstream_*` trace events the TS SDK emits
are emitted here (ADR-0009).

The `mcp` package is an optional dependency (`pip install ratel-ai[mcp]`) and is
imported lazily, so the base SDK installs without it.

Divergence from the TS SDK, by design: the Python MCP client is built around
async context managers, so the **caller owns the `ClientSession` lifecycle**
(set up the transport + session with `async with`) and passes the initialized
session in. The returned handle's `close()` exists for symmetry and defaults to a
no-op; pass `on_close` if you want the handle to tear something down.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Any, Callable

from .catalog import ExecutableTool, ToolCatalog


def _require_mcp() -> None:
    try:
        import mcp  # noqa: F401
    except ImportError as err:  # pragma: no cover - exercised only without the extra
        raise ImportError(
            "register_mcp_server requires the 'mcp' package. "
            "Install it with: pip install 'ratel-ai[mcp]'"
        ) from err


@dataclass
class McpServerHandle:
    tool_ids: list[str]
    server_instructions: str | None
    close: Callable[[], Awaitable[None]]


async def _noop_close() -> None:
    return None


async def register_mcp_server(
    catalog: ToolCatalog,
    *,
    name: str,
    session: Any,
    transport_label: str = "unknown",
    instructions: str | None = None,
    on_close: Callable[[], Awaitable[None]] | None = None,
) -> McpServerHandle:
    """Ingest an initialized MCP `ClientSession` into the catalog.

    Args:
        catalog: the catalog to register the upstream tools into.
        name: namespace prefix for tool ids (`<name>__<tool>`).
        session: an initialized `mcp.ClientSession` owned by the caller.
        transport_label: recorded on the `upstream_register` trace event.
        instructions: the upstream's server instructions (from `initialize`), if any.
        on_close: optional async teardown invoked by the handle's `close()`.
    """
    _require_mcp()

    list_result = await session.list_tools()
    tools = list_result.tools
    catalog.record_event(
        {
            "type": "upstream_register",
            "server": name,
            "transport": transport_label,
            "tool_count": len(tools),
        }
    )

    tool_ids: list[str] = []
    for tool in tools:
        tool_id = f"{name}__{tool.name}"
        catalog.register(
            ExecutableTool(
                id=tool_id,
                name=tool.name,
                description=getattr(tool, "description", None) or "",
                input_schema=getattr(tool, "inputSchema", None) or {},
                output_schema=getattr(tool, "outputSchema", None) or {"type": "object"},
                execute=_make_executor(catalog, session, name, tool_id, tool.name),
            )
        )
        tool_ids.append(tool_id)

    return McpServerHandle(
        tool_ids=tool_ids,
        server_instructions=instructions,
        close=on_close or _noop_close,
    )


def _make_executor(
    catalog: ToolCatalog,
    session: Any,
    server: str,
    tool_id: str,
    tool_name: str,
) -> Callable[[dict[str, Any]], Awaitable[Any]]:
    async def execute(args: dict[str, Any]) -> Any:
        started_at = time.monotonic()
        try:
            result = await session.call_tool(tool_name, args)
            catalog.record_event(
                {
                    "type": "upstream_invoke",
                    "server": server,
                    "tool_id": tool_id,
                    "took_ms": int((time.monotonic() - started_at) * 1000),
                }
            )
            return result
        except Exception as err:
            catalog.record_event(
                {
                    "type": "upstream_error",
                    "server": server,
                    "tool_id": tool_id,
                    "error": str(err),
                }
            )
            raise

    return execute
