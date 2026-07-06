"""Tests for `ToolCatalog` — mirrors `src/sdk/ts/src/catalog.test.ts`."""

import pytest

from ratel_ai import ExecutableTool, ToolCatalog, TraceSinkConfig


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


def test_search_defaults_to_bm25_stage() -> None:
    # Semantic/hybrid load a real model (network) and are covered in Rust; this
    # stays offline and asserts the model-free default + selection plumbing.
    catalog = ToolCatalog(trace=TraceSinkConfig(kind="memory", session_id="m"))
    catalog.register(_read_file_tool(lambda args: {}))
    hits = catalog.search("read a file", 5)
    assert hits[0].tool_id == "read_file"
    events = catalog.drain_trace_events()
    search = next(e for e in events if e["type"] == "search")
    assert any(stage["name"] == "bm25" for stage in search["stages"])


def test_per_call_method_overrides_the_catalog_default() -> None:
    # A semantic-default catalog, overridden back to bm25 per call (model-free).
    catalog = ToolCatalog(method="semantic")
    catalog.register(_read_file_tool(lambda args: {}))
    hits = catalog.search("read a file", 5, method="bm25")
    assert hits[0].tool_id == "read_file"


def test_unknown_method_raises() -> None:
    catalog = ToolCatalog()
    catalog.register(_read_file_tool(lambda args: {}))
    with pytest.raises(ValueError, match="unknown search method"):
        catalog.search("read", 5, method="keyword")


def test_warm_on_empty_catalog_is_a_noop() -> None:
    # Empty corpus short-circuits before any embedder load — the incremental
    # eager path proper is proven in the Rust core tests (counting embedder).
    catalog = ToolCatalog(method="semantic")
    catalog.warm()  # no tools → no model load, must not raise


def test_semantic_on_unwarmed_bm25_catalog_raises() -> None:
    # A BM25 catalog never warmed → a per-call semantic search refuses with a
    # clear error instead of silently embedding. Guard runs before any model
    # load, so this is offline-safe.
    catalog = ToolCatalog()
    catalog.register(_read_file_tool(lambda args: {}))
    with pytest.raises(RuntimeError, match="not computed for semantic"):
        catalog.search("read", 5, method="semantic")


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
