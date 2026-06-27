"""Tool-selection savings + native usage maths (ADR-0013).

The token/cost/savings maths live in `ratel-ai-core`; these tests pin the native
surface and the `ToolCatalog(observe=True)` recording that builds on it.
"""

from __future__ import annotations

from ratel_ai import ExecutableTool, ToolCatalog, TraceSinkConfig, _native


def _exec_tool(tool_id: str, description: str) -> ExecutableTool:
    return ExecutableTool(
        id=tool_id,
        name=tool_id,
        description=description,
        input_schema={"properties": {"x": {"type": "string"}}},
        output_schema={},
        execute=lambda args: {},
    )


# -- native token maths -----------------------------------------------------


def test_estimate_tokens_is_char_over_four() -> None:
    assert _native.estimate_tokens("") == 0
    assert _native.estimate_tokens("abcd") == 1
    assert _native.estimate_tokens("a" * 40) == 10


def test_estimate_cost_scales_with_model_tier() -> None:
    opus = _native.estimate_cost_usd("claude-opus-4-8", 1_000_000, 0)
    haiku = _native.estimate_cost_usd("claude-haiku-4-5", 1_000_000, 0)
    assert opus > haiku > 0


def test_registry_catalog_and_selected_tokens() -> None:
    reg = _native.ToolRegistry()
    reg.register(
        "read_file",
        "read_file",
        "Read a file from disk and return its contents.",
        {"properties": {"x": {"type": "string"}}},
        {},
    )
    reg.register("send_email", "send_email", "Send an email message to a recipient.", {}, {})
    full = reg.catalog_tokens()
    one = reg.tokens_for(["read_file"])
    assert full > one > 0
    # an unknown id contributes nothing
    assert reg.tokens_for(["nope"]) == 0


# -- catalog observe --------------------------------------------------------


def _build_catalog(observe: bool) -> ToolCatalog:
    catalog = ToolCatalog(trace=TraceSinkConfig(kind="memory", session_id="s"), observe=observe)
    catalog.register(_exec_tool("read_file", "Read a file from disk and return its contents."))
    catalog.register(_exec_tool("send_email", "Send an email message to a recipient address."))
    catalog.register(_exec_tool("list_dir", "List the entries of a directory on local disk."))
    return catalog


def test_search_records_tokens_saved_when_observing() -> None:
    catalog = _build_catalog(observe=True)
    catalog.drain_trace_events()  # clear registration churn

    catalog.search("read a file from disk", top_k=1)

    events = catalog.drain_trace_events()
    saved = [e for e in events if e["type"] == "tokens_saved"]
    assert len(saved) == 1
    assert saved[0]["full_catalog_tokens"] > saved[0]["selected_tokens"]
    assert saved[0]["top_k"] == 1
    assert catalog.last_savings is not None
    assert catalog.last_savings["tokens_saved"] > 0


def test_search_records_nothing_extra_when_not_observing() -> None:
    catalog = _build_catalog(observe=False)
    catalog.drain_trace_events()
    catalog.search("read a file", top_k=1)
    types = {e["type"] for e in catalog.drain_trace_events()}
    assert "tokens_saved" not in types
    # only the ordinary search event is recorded
    assert types == {"search"}
    assert catalog.last_savings is None
