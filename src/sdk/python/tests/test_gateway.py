"""Tests for the gateway tools — mirrors `src/sdk/ts/src/gateway.test.ts`."""

from ratel_ai import (
    INVOKE_TOOL_ID,
    SEARCH_TOOLS_ID,
    ExecutableTool,
    ToolCatalog,
    TraceSinkConfig,
    UpstreamServerInfo,
    invoke_tool_tool,
    search_tools_tool,
)
from ratel_ai.gateway import format_upstream_line


def _tool(tool_id: str, description: str, execute=lambda args: {}) -> ExecutableTool:
    return ExecutableTool(
        id=tool_id,
        name=tool_id.split("__")[-1],
        description=description,
        input_schema={"type": "object", "properties": {}},
        output_schema={"type": "object"},
        execute=execute,
    )


def test_factories_set_ids_and_descriptions() -> None:
    catalog = ToolCatalog()
    search = search_tools_tool(catalog)
    invoke = invoke_tool_tool(catalog)
    assert search.id == SEARCH_TOOLS_ID
    assert invoke.id == INVOKE_TOOL_ID
    assert "Discover tools" in search.description
    assert search.input_schema["required"] == ["query"]


async def test_search_tools_groups_hits_by_upstream() -> None:
    catalog = ToolCatalog()
    catalog.register(_tool("github__create_issue", "Create a GitHub issue on a repo."))
    catalog.register(_tool("github__list_issues", "List GitHub issues on a repo."))
    catalog.register(_tool("local_read", "Read a file from disk."))
    search = search_tools_tool(
        catalog,
        upstream_servers=[
            UpstreamServerInfo(name="github", description="GitHub API", instructions="be nice")
        ],
    )
    result = await search.execute({"query": "create a github issue", "topK": 5})
    servers = {g["server"]["name"] for g in result["groups"]}
    assert "github" in servers
    gh_group = next(g for g in result["groups"] if g["server"]["name"] == "github")
    assert gh_group["server"]["description"] == "GitHub API"
    assert gh_group["server"]["instructions"] == "be nice"
    # hit shape mirrors the TS SearchToolHit
    hit = gh_group["hits"][0]
    assert set(hit) == {"toolId", "score", "description", "inputSchema"}


async def test_search_tools_records_gateway_search_event() -> None:
    catalog = ToolCatalog(trace=TraceSinkConfig(kind="memory", session_id="s"))
    catalog.register(_tool("local_read", "Read a file from disk."))
    catalog.drain_trace_events()
    search = search_tools_tool(catalog)
    await search.execute({"query": "read", "topK": 3})
    events = [e for e in catalog.drain_trace_events() if e["type"] == "gateway_search"]
    assert events and events[0]["origin"] == "agent" and events[0]["top_k"] == 3


def test_search_description_lists_upstreams() -> None:
    catalog = ToolCatalog()
    search = search_tools_tool(
        catalog,
        upstream_servers=[UpstreamServerInfo(name="github", description="GitHub", tool_count=12)],
    )
    assert "upstream MCP servers" in search.description
    assert "- github — GitHub (12 tools)" in search.description


def test_format_upstream_line_flags_auth() -> None:
    line = format_upstream_line(UpstreamServerInfo(name="slack", needs_auth=True))
    assert line == "- slack (auth required)"


async def test_invoke_tool_runs_a_catalog_tool() -> None:
    catalog = ToolCatalog()
    catalog.register(
        _tool("echo", "Echo the message back.", execute=lambda args: {"echo": args["msg"]})
    )
    invoke = invoke_tool_tool(catalog)
    result = await invoke.execute({"toolId": "echo", "args": {"msg": "hello"}})
    assert result == {"echo": "hello"}


async def test_invoke_tool_unknown_id_returns_error_payload() -> None:
    catalog = ToolCatalog()
    invoke = invoke_tool_tool(catalog)
    result = await invoke.execute({"toolId": "missing", "args": {}})
    assert "unknown toolId" in result["error"]


async def test_invoke_tool_accepts_flattened_args() -> None:
    catalog = ToolCatalog()
    catalog.register(_tool("echo", "Echo back.", execute=lambda args: {"echo": args.get("msg")}))
    invoke = invoke_tool_tool(catalog)
    # args not nested under "args" — fall back to top-level minus toolId
    result = await invoke.execute({"toolId": "echo", "msg": "flat"})
    assert result == {"echo": "flat"}


async def test_invoke_tool_unauthorized_triggers_callback_and_needs_auth() -> None:
    class UnauthorizedError(Exception):
        pass

    def boom(args):
        raise UnauthorizedError("401")

    seen = []

    async def on_unauthorized(upstream: str) -> None:
        seen.append(upstream)

    catalog = ToolCatalog()
    catalog.register(_tool("github__create_issue", "Create issue.", execute=boom))
    invoke = invoke_tool_tool(catalog, on_unauthorized=on_unauthorized)
    result = await invoke.execute({"toolId": "github__create_issue", "args": {}})
    assert result["error"] == "needs_auth"
    assert result["upstream"] == "github"
    assert seen == ["github"]


async def test_invoke_tool_generic_error_is_reported() -> None:
    def boom(args):
        raise RuntimeError("nope")

    catalog = ToolCatalog()
    catalog.register(_tool("flaky", "Flaky tool.", execute=boom))
    invoke = invoke_tool_tool(catalog)
    result = await invoke.execute({"toolId": "flaky", "args": {}})
    assert "threw: nope" in result["error"]
