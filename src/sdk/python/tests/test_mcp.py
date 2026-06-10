"""Tests for MCP ingestion — mirrors `src/sdk/ts/src/mcp.test.ts`.

The upstream session is duck-typed, so the ingestion logic (id namespacing,
trace events, executor wiring) is exercised with a fake session and does not
require the optional `mcp` package. A separate test pins the helpful error when
`mcp` is absent.
"""

import importlib.util

import pytest

from ratel_ai import ToolCatalog, TraceSinkConfig, register_mcp_server


class _FakeTool:
    def __init__(self, name, description, input_schema):
        self.name = name
        self.description = description
        self.inputSchema = input_schema
        self.outputSchema = None


class _FakeListResult:
    def __init__(self, tools):
        self.tools = tools


class _FakeSession:
    def __init__(self):
        self.calls = []

    async def list_tools(self):
        return _FakeListResult(
            [_FakeTool("create_issue", "Create a GitHub issue.", {"type": "object"})]
        )

    async def call_tool(self, name, args):
        self.calls.append((name, args))
        return {"ok": True, "name": name}


async def test_register_mcp_server_namespaces_and_wires(monkeypatch) -> None:
    monkeypatch.setattr("ratel_ai.mcp._require_mcp", lambda: None)
    catalog = ToolCatalog(trace=TraceSinkConfig(kind="memory", session_id="s"))
    session = _FakeSession()

    handle = await register_mcp_server(
        catalog,
        name="github",
        session=session,
        transport_label="memory",
        instructions="be nice",
    )

    assert handle.tool_ids == ["github__create_issue"]
    assert handle.server_instructions == "be nice"
    assert catalog.has("github__create_issue")

    register_events = [
        e for e in catalog.drain_trace_events() if e["type"] == "upstream_register"
    ]
    assert register_events[0]["server"] == "github"
    assert register_events[0]["tool_count"] == 1
    assert register_events[0]["transport"] == "memory"

    result = await catalog.invoke("github__create_issue", {"title": "bug"})
    assert result == {"ok": True, "name": "create_issue"}
    assert session.calls == [("create_issue", {"title": "bug"})]

    invoke_events = [
        e for e in catalog.drain_trace_events() if e["type"] == "upstream_invoke"
    ]
    assert invoke_events[0]["tool_id"] == "github__create_issue"

    await handle.close()  # default no-op close is awaitable


async def test_register_mcp_server_records_upstream_error(monkeypatch) -> None:
    monkeypatch.setattr("ratel_ai.mcp._require_mcp", lambda: None)

    class _BoomSession(_FakeSession):
        async def call_tool(self, name, args):
            raise RuntimeError("upstream down")

    catalog = ToolCatalog(trace=TraceSinkConfig(kind="memory", session_id="s"))
    await register_mcp_server(catalog, name="github", session=_BoomSession())
    catalog.drain_trace_events()
    with pytest.raises(RuntimeError, match="upstream down"):
        await catalog.invoke("github__create_issue", {})
    errors = [e for e in catalog.drain_trace_events() if e["type"] == "upstream_error"]
    assert errors[0]["server"] == "github"


async def test_register_mcp_server_requires_mcp_when_absent() -> None:
    if importlib.util.find_spec("mcp") is not None:
        pytest.skip("mcp is installed; the absent-dependency path cannot be exercised")
    with pytest.raises(ImportError, match=r"ratel-ai\[mcp\]"):
        await register_mcp_server(ToolCatalog(), name="x", session=object())
