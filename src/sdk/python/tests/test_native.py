"""Tests for the PyO3 native binding (`ratel_ai._native`)."""

import pytest

from ratel_ai import SearchHit, ToolRegistry


def _register_read_file(reg: ToolRegistry) -> None:
    reg.register(
        "read_file",
        "read_file",
        "Read a file from local disk and return its textual contents.",
        {"properties": {"path": {"type": "string"}}},
        {"properties": {"contents": {"type": "string"}}},
    )


def test_register_and_search_returns_hit() -> None:
    reg = ToolRegistry()
    _register_read_file(reg)
    hits = reg.search("read a text file", 5)
    assert len(hits) >= 1
    assert isinstance(hits[0], SearchHit)
    assert hits[0].tool_id == "read_file"
    assert hits[0].score > 0


def test_search_empty_registry_returns_empty() -> None:
    reg = ToolRegistry()
    assert reg.search("anything", 5) == []


def test_search_with_origin_accepts_agent_and_direct() -> None:
    reg = ToolRegistry()
    _register_read_file(reg)
    assert reg.search_with_origin("read file", 3, "agent")[0].tool_id == "read_file"
    assert reg.search_with_origin("read file", 3, "direct")[0].tool_id == "read_file"


def test_memory_sink_captures_and_drains_events() -> None:
    reg = ToolRegistry()
    reg.set_trace_sink("memory", "sess-1")
    _register_read_file(reg)  # emits an index_churn event
    reg.search("read file", 3)  # emits a search event
    events = reg.drain_trace_events()
    types = [e["type"] for e in events]
    assert "index_churn" in types
    assert "search" in types
    # every envelope is stamped
    assert all(e["session_id"] == "sess-1" for e in events)
    # draining is destructive
    assert reg.drain_trace_events() == []


def test_noop_sink_drains_nothing() -> None:
    reg = ToolRegistry()
    _register_read_file(reg)
    reg.search("read file", 3)
    assert reg.drain_trace_events() == []


def test_record_event_accepts_valid_event() -> None:
    reg = ToolRegistry()
    reg.set_trace_sink("memory", "sess-2")
    reg.record_event({"type": "invoke_start", "tool_id": "x", "args_size_bytes": 12})
    events = reg.drain_trace_events()
    assert events[0]["type"] == "invoke_start"
    assert events[0]["tool_id"] == "x"
    assert events[0]["args_size_bytes"] == 12


def test_record_event_rejects_invalid_event() -> None:
    reg = ToolRegistry()
    with pytest.raises(ValueError, match="invalid trace event"):
        reg.record_event({"type": "not_a_real_event"})


def test_memory_sink_requires_session_id() -> None:
    reg = ToolRegistry()
    with pytest.raises(ValueError, match="session_id"):
        reg.set_trace_sink("memory")


def _skill_args(description: str) -> tuple:
    return ("api-design", "api-design", description, ["api"], [], {}, "# body")


def test_skill_registry_upsert_replaces_by_id_and_reports_replacement() -> None:
    from ratel_ai import SkillRegistry

    reg = SkillRegistry()
    assert reg.upsert(*_skill_args("REST API design patterns")) is False
    assert reg.upsert(*_skill_args("GraphQL schema modeling")) is True
    assert reg.search("GraphQL schema", 5)[0].skill_id == "api-design"
    assert reg.search("REST patterns", 5) == []


def test_skill_registry_remove_drops_the_skill_and_reports_membership() -> None:
    from ratel_ai import SkillRegistry

    reg = SkillRegistry()
    reg.register(*_skill_args("REST API design patterns"))
    assert reg.remove("api-design") is True
    assert reg.remove("api-design") is False
    assert reg.search("REST API", 5) == []
