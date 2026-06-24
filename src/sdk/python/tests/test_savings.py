"""Tool-selection savings metric (ADR-0013)."""

from __future__ import annotations

from typing import Any

from ratel_ai import ExecutableTool, ToolCatalog, TraceSinkConfig
from ratel_ai.observability import CaptureExporter, RatelClient
from ratel_ai.observability.estimator import HeuristicEstimator, default_estimator
from ratel_ai.observability.savings import compute_savings, tool_text


class _Tool:
    def __init__(self, name: str, description: str) -> None:
        self.name = name
        self.description = description
        self.input_schema: dict[str, Any] = {"properties": {"x": {"type": "string"}}}
        self.output_schema: dict[str, Any] = {}


def _exec_tool(tool_id: str, description: str) -> ExecutableTool:
    return ExecutableTool(
        id=tool_id,
        name=tool_id,
        description=description,
        input_schema={"properties": {"x": {"type": "string"}}},
        output_schema={},
        execute=lambda args: {},
    )


# -- estimator --------------------------------------------------------------


def test_heuristic_estimator_is_char_over_four() -> None:
    est = HeuristicEstimator()
    assert est.estimate("") == 0
    assert est.estimate("abcd") == 1
    assert est.estimate("a" * 40) == 10


def test_default_estimator_is_heuristic() -> None:
    assert isinstance(default_estimator(), HeuristicEstimator)


def test_tool_text_includes_name_description_schema() -> None:
    text = tool_text(_Tool("read_file", "Read a file"))
    assert "read_file" in text
    assert "Read a file" in text
    assert "properties" in text


# -- savings math -----------------------------------------------------------


def test_compute_savings_with_pluggable_estimator() -> None:
    class _Fixed:
        def estimate(self, text: str) -> int:
            return 100  # every tool counts as 100

    selected = [_Tool("a", "x"), _Tool("b", "y")]
    savings = compute_savings(selected, full_catalog_tokens=1000, top_k=2, estimator=_Fixed())
    assert savings.selected_tokens == 200
    assert savings.tokens_saved == 800
    assert savings.top_k == 2


def test_savings_never_negative() -> None:
    selected = [_Tool("a", "x")]
    savings = compute_savings(
        selected, full_catalog_tokens=0, top_k=1, estimator=HeuristicEstimator()
    )
    assert savings.tokens_saved == 0


# -- catalog integration ----------------------------------------------------


def _build_catalog(observe: Any) -> ToolCatalog:
    catalog = ToolCatalog(trace=TraceSinkConfig(kind="memory", session_id="s"), observe=observe)
    catalog.register(_exec_tool("read_file", "Read a file from disk and return its contents."))
    catalog.register(_exec_tool("send_email", "Send an email message to a recipient address."))
    catalog.register(_exec_tool("list_dir", "List the entries of a directory on local disk."))
    return catalog


def test_search_emits_tokens_saved_event_when_observing() -> None:
    exporter = CaptureExporter()
    client = RatelClient(api_key="rk-test", exporter=exporter)
    catalog = _build_catalog(observe=client)
    catalog.drain_trace_events()  # clear registration churn

    catalog.search("read a file from disk", top_k=1)

    core_events = catalog.drain_trace_events()
    saved = [e for e in core_events if e["type"] == "tokens_saved"]
    assert len(saved) == 1
    assert saved[0]["full_catalog_tokens"] > saved[0]["selected_tokens"]
    assert saved[0]["top_k"] == 1

    # a rich cloud event is queued too
    cloud = [e for e in exporter.events if e.get("name") == "ratel.tokens_saved"]
    assert len(cloud) == 1
    assert cloud[0]["metadata"]["tokens_saved"] > 0
    assert cloud[0]["metadata"]["query"] == "read a file from disk"


def test_search_emits_nothing_extra_when_not_observing() -> None:
    catalog = _build_catalog(observe=None)
    catalog.drain_trace_events()
    catalog.search("read a file", top_k=1)
    core_events = catalog.drain_trace_events()
    types = {e["type"] for e in core_events}
    assert "tokens_saved" not in types
    # only the ordinary search event is recorded
    assert types == {"search"}


def test_invoke_traces_a_cloud_span_when_observing() -> None:
    exporter = CaptureExporter()
    client = RatelClient(api_key="rk-test", exporter=exporter)
    catalog = ToolCatalog(observe=client)
    catalog.register(_exec_tool("read_file", "Read a file."))

    import asyncio

    asyncio.run(catalog.invoke("read_file", {"x": "/tmp/a"}))
    spans = [e for e in exporter.events if e["type"] == "observation-create"]
    assert any(s["name"] == "tool.read_file" for s in spans)


def test_observe_true_picks_up_later_configure() -> None:
    from ratel_ai.observability import configure, set_global_client

    set_global_client(None)  # global client starts absent / no-op
    catalog = ToolCatalog(observe=True)
    catalog.register(_exec_tool("read_file", "Read a file from disk and return its contents."))
    catalog.register(_exec_tool("send_email", "Send an email message to a recipient address."))
    catalog.register(_exec_tool("list_dir", "List the entries of a directory on local disk."))

    # Configure a real exporting client AFTER the catalog was constructed.
    exporter = CaptureExporter()
    configure(api_key="rk-test", exporter=exporter)

    catalog.search("read a file from disk", top_k=1)
    cloud = [e for e in exporter.events if e.get("name") == "ratel.tokens_saved"]
    assert len(cloud) == 1


def test_full_catalog_baseline_recomputes_after_register() -> None:
    catalog = ToolCatalog(observe=True)
    catalog.register(_exec_tool("a", "first tool"))
    # prime the cache
    catalog.search("a", top_k=1)
    primed = catalog._full_tokens
    assert primed is not None
    # registering a new tool invalidates the cached baseline
    catalog.register(_exec_tool("b", "second tool"))
    assert catalog._full_tokens is None
