"""Tests for `ToolCatalog` — mirrors `src/sdk/ts/src/catalog.test.ts`."""

import warnings

import pytest

from ratel_ai import (
    DimensionMismatchError,
    EmbedderError,
    ExecutableTool,
    ToolCatalog,
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


def test_per_call_bm25_matches_the_default() -> None:
    # Stays on a BM25 catalog so no model loads. (Registering into a semantic
    # catalog eagerly builds embeddings and would download the model — the override behaviour
    # proper is covered offline in the Rust core tests.)
    catalog = ToolCatalog()
    catalog.register(_read_file_tool(lambda args: {}))
    via_default = [h.tool_id for h in catalog.search("read a file", 5)]
    via_explicit = [h.tool_id for h in catalog.search("read a file", 5, method="bm25")]
    assert via_explicit == via_default
    assert via_explicit[0] == "read_file"


def test_per_call_method_overrides_default_and_reroutes() -> None:
    # Default is semantic, but with no registrations no model loads. A per-call
    # "bm25" must route to the bm25 engine — provable offline via the trace stage
    # the semantic default (empty corpus) never emits.
    catalog = ToolCatalog(
        method="semantic", trace=TraceSinkConfig(kind="memory", session_id="o")
    )
    catalog.search("anything", 5)  # default: semantic engine
    catalog.search("anything", 5, method="bm25")  # per-call override: bm25 engine
    searches = [e for e in catalog.drain_trace_events() if e["type"] == "search"]
    assert len(searches) == 2
    assert not any(s["name"] == "bm25" for s in searches[0]["stages"])
    assert any(s["name"] == "bm25" for s in searches[1]["stages"])


def test_unknown_method_raises() -> None:
    catalog = ToolCatalog()
    catalog.register(_read_file_tool(lambda args: {}))
    with pytest.raises(ValueError, match="unknown search method"):
        catalog.search("read", 5, method="keyword")


def test_build_embeddings_on_empty_catalog_is_a_noop() -> None:
    # Empty corpus short-circuits before any embedder load — the incremental
    # eager path proper is proven in the Rust core tests (counting embedder).
    catalog = ToolCatalog(method="semantic")
    catalog.build_embeddings()  # no tools → no model load, must not raise


def test_semantic_on_bm25_without_embeddings_raises() -> None:
    # A BM25 catalog with no embeddings built → a per-call semantic search refuses with a
    # clear error instead of silently embedding. Guard runs before any model
    # load, so this is offline-safe.
    catalog = ToolCatalog()
    catalog.register(_read_file_tool(lambda args: {}))
    with pytest.raises(RuntimeError, match="not computed for semantic"):
        catalog.search("read", 5, method="semantic")


def test_embedding_invalid_config_raises_valueerror_at_construction() -> None:
    # A bare URL has no model name → construction-time ValueError.
    with pytest.raises(ValueError, match="model"):
        ToolCatalog(method="semantic", embedding="https://api.openai.com/v1/embeddings")


def test_embedding_bare_repo_id_string_points_to_huggingface() -> None:
    # A string is a local path only; a repo id must use {"huggingface": ...}.
    with pytest.raises(ValueError, match="huggingface"):
        ToolCatalog(method="semantic", embedding="BAAI/bge-base-en-v1.5")


def test_embedding_conflicting_endpoint_keys_raise() -> None:
    with pytest.raises(ValueError, match="conflicting"):
        ToolCatalog(
            method="semantic",
            embedding={"ollama": "nomic", "url": "http://h:11434/v1/embeddings", "model": "nomic"},
        )


def test_embedding_unknown_dict_key_raises() -> None:
    with pytest.raises(ValueError, match="unknown embedding keys"):
        ToolCatalog(method="semantic", embedding={"bogus": "x"})


def test_embedding_pooling_override_and_doc_prefix_accepted() -> None:
    # Construction validates (does not load); a valid pooling + doc_prefix is fine.
    ToolCatalog(
        method="semantic",
        embedding={"huggingface": "org/m", "pooling": "mean", "doc_prefix": "passage: "},
    )


def test_embedding_invalid_pooling_value_raises() -> None:
    with pytest.raises(ValueError, match="pooling"):
        ToolCatalog(method="semantic", embedding={"huggingface": "org/m", "pooling": "median"})


def test_embedding_pooling_on_endpoint_raises() -> None:
    with pytest.raises(ValueError, match="pooling"):
        ToolCatalog(method="semantic", embedding={"ollama": "nomic", "pooling": "mean"})


def test_embedding_download_opt_in_accepted() -> None:
    ToolCatalog(method="semantic", embedding={"huggingface": "org/m", "download": True})


def test_embedding_download_on_non_huggingface_raises() -> None:
    with pytest.raises(ValueError, match="download"):
        ToolCatalog(method="semantic", embedding={"local": "/opt/models/x", "download": True})


def test_embedding_ignored_and_warns_under_bm25() -> None:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        catalog = ToolCatalog(embedding={"huggingface": "BAAI/bge-base-en-v1.5"})  # bm25 default
        catalog.register(_read_file_tool(lambda args: {}))
        catalog.search("read", 5)  # bm25, no model loaded
    assert any("bm25" in str(w.message) for w in caught)


def test_typed_embedder_exceptions_are_runtimeerror_subclasses() -> None:
    assert issubclass(EmbedderError, RuntimeError)
    assert issubclass(DimensionMismatchError, EmbedderError)


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


async def test_re_register_replaces_in_place() -> None:
    # Re-registering an id replaces it in the native corpus, not appends a
    # duplicate: the id ranks once and the latest executor wins (RAT-378).
    catalog = ToolCatalog()
    catalog.register(_read_file_tool(lambda args: {"contents": "v1"}))
    catalog.register(
        ExecutableTool(
            id="read_file",
            name="read_file",
            description="Fetch and return a document over the network.",
            input_schema={"properties": {"path": {"type": "string"}}},
            output_schema={"properties": {"contents": {"type": "string"}}},
            execute=lambda args: {"contents": "v2"},
        )
    )
    hits = catalog.search("fetch a document over the network", 10)
    assert [h.tool_id for h in hits].count("read_file") == 1
    assert await catalog.invoke("read_file", {"path": "/x"}) == {"contents": "v2"}
