"""Tests for `ToolCatalog` — mirrors `src/sdk/ts/src/catalog.test.ts`."""

import pytest

from ratel_ai import (
    ExecutableTool,
    Skill,
    SkillCatalog,
    ToolCatalog,
    TraceSession,
    TraceSinkConfig,
)


def _read_file_tool(execute) -> ExecutableTool:
    return ExecutableTool(
        id="read_file",
        name="read_file",
        description="Read a file from local disk and return its textual contents.",
        input_schema={"properties": {"path": {"type": "string"}}},
        output_schema={"properties": {"contents": {"type": "string"}}},
        execute=execute,
    )


def test_register_then_get_and_has() -> None:
    catalog = ToolCatalog()
    catalog.register(_read_file_tool(lambda args: {"contents": "hi"}))
    assert catalog.has("read_file")
    assert not catalog.has("missing")
    tool = catalog.get("read_file")
    assert tool is not None and tool.name == "read_file"
    # get() returns metadata only — no execute attribute leaked as a Tool
    assert not hasattr(tool, "execute")
    executable = catalog.get_executable("read_file")
    assert executable is not None and executable.execute is not None


def test_register_rejects_tool_without_execute() -> None:
    catalog = ToolCatalog()
    with pytest.raises(ValueError, match="no execute handler"):
        catalog.register(
            ExecutableTool(id="x", name="x", description="d", execute=None)  # type: ignore[arg-type]
        )


def test_search_ranks_the_relevant_tool_first() -> None:
    catalog = ToolCatalog()
    catalog.register(_read_file_tool(lambda args: {}))
    catalog.register(
        ExecutableTool(
            id="send_email",
            name="send_email",
            description="Send an email message to a recipient.",
            input_schema={},
            output_schema={},
            execute=lambda args: {},
        )
    )
    hits = catalog.search("read a file from disk", 5)
    assert hits[0].tool_id == "read_file"


async def test_invoke_runs_sync_executor() -> None:
    catalog = ToolCatalog()
    catalog.register(_read_file_tool(lambda args: {"contents": f"read {args['path']}"}))
    result = await catalog.invoke("read_file", {"path": "/tmp/x"})
    assert result == {"contents": "read /tmp/x"}


async def test_invoke_runs_async_executor() -> None:
    async def handler(args):
        return {"contents": f"async {args['path']}"}

    catalog = ToolCatalog()
    catalog.register(_read_file_tool(handler))
    result = await catalog.invoke("read_file", {"path": "/tmp/y"})
    assert result == {"contents": "async /tmp/y"}


async def test_invoke_unknown_tool_raises() -> None:
    catalog = ToolCatalog()
    with pytest.raises(ValueError, match="unknown toolId"):
        await catalog.invoke("nope", {})


async def test_invoke_emits_start_then_end_telemetry() -> None:
    catalog = ToolCatalog(trace=TraceSinkConfig(kind="memory", session_id="s"))
    catalog.register(_read_file_tool(lambda args: {"ok": True}))
    catalog.drain_trace_events()  # clear registration churn
    await catalog.invoke("read_file", {"path": "/a"})
    events = catalog.drain_trace_events()
    types = [e["type"] for e in events]
    assert types == ["invoke_start", "invoke_end"]
    assert events[0]["tool_id"] == "read_file"
    assert events[0]["args_size_bytes"] > 0
    assert "took_ms" in events[1]


async def test_invoke_emits_error_telemetry_and_reraises() -> None:
    def boom(args):
        raise RuntimeError("kaboom")

    catalog = ToolCatalog(trace=TraceSinkConfig(kind="memory", session_id="s"))
    catalog.register(_read_file_tool(boom))
    catalog.drain_trace_events()
    with pytest.raises(RuntimeError, match="kaboom"):
        await catalog.invoke("read_file", {"path": "/a"})
    events = catalog.drain_trace_events()
    types = [e["type"] for e in events]
    assert types == ["invoke_start", "invoke_error"]
    assert events[1]["error"] == "kaboom"


def test_shared_trace_session_collects_both_catalogs_with_one_seq_counter() -> None:
    session = TraceSession("shared", harness="pytest")
    tools = ToolCatalog(trace_session=session)
    skills = SkillCatalog(trace_session=session)

    tools.register(_read_file_tool(lambda args: {}))
    skills.register(Skill(id="s1", name="s1", description="REST API design"))
    tools.search("read", 5)

    events = session.drain()
    assert [e["seq"] for e in events] == [0, 1, 2]
    assert events[0]["harness"] == "pytest"


def test_trace_session_takes_precedence_over_trace() -> None:
    session = TraceSession("s2")
    catalog = ToolCatalog(
        trace=TraceSinkConfig(kind="memory", session_id="ignored"), trace_session=session
    )
    catalog.register(_read_file_tool(lambda args: {}))
    assert [e["type"] for e in session.drain()] == ["index_churn"]


async def test_invoke_carries_latest_search_id_on_start_and_end() -> None:
    catalog = ToolCatalog(trace=TraceSinkConfig(kind="memory", session_id="s"))
    catalog.register(_read_file_tool(lambda args: {"ok": True}))
    catalog.drain_trace_events()

    first = catalog.search_traced("read file", 5, "agent")
    second = catalog.search_traced("read the file again", 5, "agent")
    await catalog.invoke("read_file", {"path": "/x"})

    assert first.search_id != second.search_id
    assert catalog.last_search_id("read_file") == second.search_id
    events = catalog.drain_trace_events()
    start = next(e for e in events if e["type"] == "invoke_start")
    end = next(e for e in events if e["type"] == "invoke_end")
    assert start["search_id"] == second.search_id
    assert end["search_id"] == second.search_id


async def test_invoke_end_carries_result_size_bytes() -> None:
    catalog = ToolCatalog(trace=TraceSinkConfig(kind="memory", session_id="s"))
    catalog.register(_read_file_tool(lambda args: {"contents": "data"}))
    catalog.drain_trace_events()

    await catalog.invoke("read_file", {"path": "/x"})

    events = catalog.drain_trace_events()
    end = next(e for e in events if e["type"] == "invoke_end")
    assert isinstance(end["result_size_bytes"], int)
    assert end["result_size_bytes"] > 0


async def test_unauthorized_invoke_classified_needs_auth_transient() -> None:
    class UnauthorizedError(Exception):
        pass

    def locked(args):
        raise UnauthorizedError("401")

    catalog = ToolCatalog(trace=TraceSinkConfig(kind="memory", session_id="s"))
    catalog.register(_read_file_tool(locked))
    catalog.drain_trace_events()

    with pytest.raises(UnauthorizedError):
        await catalog.invoke("read_file", {})

    events = catalog.drain_trace_events()
    err = next(e for e in events if e["type"] == "invoke_error")
    assert err["error_code"] == "needs_auth"
    assert err["error_kind"] == "transient"


def test_trace_sink_config_context_fields_stamp_events() -> None:
    catalog = ToolCatalog(
        trace=TraceSinkConfig(
            kind="memory",
            session_id="s",
            harness="pytest",
            environment="ci",
            sdk_version="0.2.0",
            catalog_version="v1",
        )
    )
    catalog.register(_read_file_tool(lambda args: {}))
    events = catalog.drain_trace_events()
    assert events
    assert events[0]["harness"] == "pytest"
    assert events[0]["environment"] == "ci"
    assert events[0]["sdk_version"] == "0.2.0"
    assert events[0]["catalog_version"] == "v1"
