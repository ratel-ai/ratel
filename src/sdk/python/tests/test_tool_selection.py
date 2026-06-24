"""Transparent BM25 tool selection in the provider wrappers (ADR-0015)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from ratel_ai.integrations.openai import OPENAI_TOOLS
from ratel_ai.integrations.selection import last_user_text, rank_tools
from ratel_ai.observability import CaptureExporter
from ratel_ai.openai import OpenAI, ToolSelection, wrap_openai

# -- fixtures: provider tool shapes + recording fake clients -----------------


def _openai_tool(name: str, description: str) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": {"x": {"type": "string"}}},
        },
    }


def _big_toolset() -> list[dict[str, Any]]:
    tools = [
        _openai_tool(f"widget_{i}", f"Compute the checksum of widget number {i}.")
        for i in range(27)
    ]
    tools.append(_openai_tool("read_file", "Read a file from local disk and return its contents."))
    tools.append(_openai_tool("send_email", "Send an email message to a recipient address."))
    tools.append(_openai_tool("send_sms", "Send an SMS text message to a recipient phone number."))
    tools.append(_openai_tool("send_push", "Send a push notification message to a recipient."))
    return tools


def _rank(query: str, *, tools: list[dict[str, Any]] | None = None, **sel: Any) -> Any:
    kwargs: dict[str, Any] = {
        "messages": [{"role": "user", "content": query}],
        "tools": _big_toolset() if tools is None else tools,
    }
    return rank_tools(kwargs, OPENAI_TOOLS, ToolSelection(enabled=True, **sel), query=query)


class _Usage:
    prompt_tokens, completion_tokens, total_tokens = 10, 5, 15


class _Message:
    def __init__(self, tool_calls: Any = None) -> None:
        self.role = "assistant"
        self.content = "ok"
        self.tool_calls = tool_calls


class _Choice:
    def __init__(self, tool_calls: Any = None) -> None:
        self.message = _Message(tool_calls)
        self.finish_reason = "stop"


class _Response:
    def __init__(self, tool_calls: Any = None) -> None:
        self.model = "gpt-4o-2024-08-06"
        self.choices = [_Choice(tool_calls)]
        self.usage = _Usage()


class _RecordingCompletions:
    def __init__(self, response: Any = None) -> None:
        self.last_kwargs: dict[str, Any] | None = None
        self._response = response or _Response()

    def create(self, **kwargs: Any) -> Any:
        self.last_kwargs = kwargs
        return self._response


class _Chat:
    def __init__(self, completions: Any) -> None:
        self.completions = completions


class _FakeClient:
    def __init__(self, completions: Any) -> None:
        self.chat = _Chat(completions)


def _names(tools: list[dict[str, Any]]) -> set[str]:
    return {t["function"]["name"] for t in tools}


# -- ToolSelection.resolve ---------------------------------------------------


def test_selection_disabled_by_default(monkeypatch: Any) -> None:
    monkeypatch.delenv("RATEL_TOOL_SELECTION", raising=False)
    assert ToolSelection.resolve(None).enabled is False
    assert ToolSelection.resolve(True).enabled is True
    assert ToolSelection.resolve(ToolSelection(enabled=True, top_k=3)).top_k == 3


def test_selection_enabled_via_env(monkeypatch: Any) -> None:
    monkeypatch.setenv("RATEL_TOOL_SELECTION", "on")
    assert ToolSelection.resolve(None).enabled is True


# -- rank_tools unit ---------------------------------------------------------


def test_rank_keeps_relevant_drops_irrelevant() -> None:
    result = _rank("send a message to a recipient", top_k=5, min_tools=5)
    assert result is not None
    kept = _names(result.kwargs["tools"])
    assert {"send_email", "send_sms", "send_push"} <= kept  # the relevant cluster survives
    assert "read_file" not in kept  # irrelevant dropped
    assert result.tools_selected < result.tools_offered
    assert result.savings.tokens_saved > 0


def test_rank_skips_when_below_min_tools() -> None:
    assert _rank("send email", tools=_big_toolset()[:4], min_tools=25) is None


def test_rank_skips_when_query_empty() -> None:
    kwargs = {"messages": [], "tools": _big_toolset()}
    sel = ToolSelection(enabled=True, min_tools=5)
    assert rank_tools(kwargs, OPENAI_TOOLS, sel, query="") is None


def test_rank_does_not_nuke_when_nothing_matches() -> None:
    # a query that shares no terms with any tool — must NOT prune to empty
    assert _rank("zzzzqqq", top_k=5, min_tools=5) is None


def test_rank_pins_tool_choice() -> None:
    kwargs: dict[str, Any] = {
        "messages": [{"role": "user", "content": "send a message"}],
        "tools": _big_toolset(),
        "tool_choice": {"type": "function", "function": {"name": "read_file"}},
    }
    result = rank_tools(
        kwargs, OPENAI_TOOLS, ToolSelection(enabled=True, top_k=3, min_tools=5),
        query="send a message",
    )
    assert result is not None
    # read_file is irrelevant to the query but pinned by tool_choice → kept
    assert "read_file" in _names(result.kwargs["tools"])


# -- last_user_text ----------------------------------------------------------


def test_last_user_text_handles_shapes() -> None:
    assert last_user_text([{"role": "user", "content": "hello"}]) == "hello"
    parts = [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]
    assert last_user_text([{"role": "user", "content": parts}]) == "a b"
    assert last_user_text([{"role": "assistant", "content": "x"}]) == ""
    assert last_user_text([]) == ""


# -- end-to-end through the wrapper ------------------------------------------


def test_wrapper_prunes_tools_and_passes_through(capture: CaptureExporter) -> None:
    completions = _RecordingCompletions()
    client = _FakeClient(completions)
    wrap_openai(client, select_tools=True)

    resp = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": "send a message to the user"}],
        tools=_big_toolset(),
    )
    assert isinstance(resp, _Response)  # original response passes through

    sent = completions.last_kwargs["tools"]
    assert len(sent) < 31  # pruned
    assert "send_email" in _names(sent)  # relevant survived

    events = capture.events
    assert any(e.get("name") == "ratel.tokens_saved" for e in events)
    gen = next(e for e in events if e.get("name") == "openai.chat.completions")
    assert gen["metadata"]["ratel"]["tools_offered"] == 31
    assert gen["metadata"]["ratel"]["tools_selected"] < 31


def test_wrapper_does_not_prune_when_disabled(monkeypatch: Any, capture: CaptureExporter) -> None:
    monkeypatch.delenv("RATEL_TOOL_SELECTION", raising=False)
    completions = _RecordingCompletions()
    client = _FakeClient(completions)
    wrap_openai(client)  # tracing only, no selection

    tools = _big_toolset()
    client.chat.completions.create(
        model="gpt-4o", messages=[{"role": "user", "content": "x"}], tools=tools
    )
    assert completions.last_kwargs["tools"] == tools  # untouched


def test_wrapper_fails_open_when_ranking_errors(monkeypatch: Any, capture: CaptureExporter) -> None:
    import ratel_ai.integrations._wrap as wrap

    def boom(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("ranking exploded")

    monkeypatch.setattr(wrap, "rank_tools", boom)
    completions = _RecordingCompletions()
    client = _FakeClient(completions)
    wrap_openai(client, select_tools=True)

    tools = _big_toolset()
    resp = client.chat.completions.create(
        model="gpt-4o", messages=[{"role": "user", "content": "send a message"}], tools=tools
    )
    assert isinstance(resp, _Response)
    assert completions.last_kwargs["tools"] == tools  # fell back to original


def test_wrapper_captures_tool_calls(capture: CaptureExporter) -> None:
    class _Call:
        def __init__(self, name: str) -> None:
            self.function = type("F", (), {"name": name})()

    completions = _RecordingCompletions(_Response(tool_calls=[_Call("send_email")]))
    client = _FakeClient(completions)
    wrap_openai(client)  # selection off; tool-call capture is independent

    client.chat.completions.create(
        model="gpt-4o", messages=[{"role": "user", "content": "email them"}]
    )
    gen = next(e for e in capture.events if e.get("name") == "openai.chat.completions")
    assert gen["metadata"]["ratel"]["tool_calls"] == ["send_email"]


def test_constructor_accepts_select_tools_without_openai_installed() -> None:
    # select_tools is consumed by our wrapper, not forwarded to the (absent) SDK.
    with pytest.raises(ImportError, match="pip install openai"):
        OpenAI(select_tools=True)


def test_streaming_with_selection_prunes_and_streams(capture: CaptureExporter) -> None:
    class _Chunk:
        def __init__(self, usage: Any = None) -> None:
            self.usage = usage

    class _StreamCompletions:
        def __init__(self) -> None:
            self.last_kwargs: dict[str, Any] | None = None

        def create(self, **kwargs: Any) -> Any:
            self.last_kwargs = kwargs
            return iter([_Chunk(), _Chunk(_Usage())])

    completions = _StreamCompletions()
    client = _FakeClient(completions)
    wrap_openai(client, select_tools=True)

    stream = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": "send a message"}],
        tools=_big_toolset(),
        stream=True,
    )
    chunks = list(stream)
    assert len(chunks) == 2
    assert len(completions.last_kwargs["tools"]) < 31  # pruned even when streaming


def test_async_selection_prunes(capture: CaptureExporter) -> None:
    class _AsyncCompletions:
        def __init__(self) -> None:
            self.last_kwargs: dict[str, Any] | None = None

        async def create(self, **kwargs: Any) -> Any:
            self.last_kwargs = kwargs
            return _Response()

    completions = _AsyncCompletions()
    client = _FakeClient(completions)
    wrap_openai(client, select_tools=True)

    async def run() -> Any:
        return await client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "send a message"}],
            tools=_big_toolset(),
        )

    asyncio.run(run())
    assert len(completions.last_kwargs["tools"]) < 31


def test_anthropic_wrapper_prunes_tools(capture: CaptureExporter) -> None:
    from ratel_ai.anthropic import wrap_anthropic

    def _atool(name: str, desc: str) -> dict[str, Any]:
        return {
            "name": name,
            "description": desc,
            "input_schema": {"type": "object", "properties": {}},
        }

    tools = [_atool(f"widget_{i}", f"Compute widget {i}.") for i in range(28)]
    tools.append(_atool("send_email", "Send an email message to a recipient address."))
    tools.append(_atool("send_sms", "Send an SMS message to a recipient phone number."))
    tools.append(_atool("read_file", "Read a file from disk."))

    class _AMessages:
        def __init__(self) -> None:
            self.last_kwargs: dict[str, Any] | None = None

        def create(self, **kwargs: Any) -> Any:
            self.last_kwargs = kwargs
            return type(
                "R", (), {"model": "claude", "content": [], "usage": None, "stop_reason": "end"}
            )()

    class _AClient:
        def __init__(self, messages: Any) -> None:
            self.messages = messages

    messages = _AMessages()
    client = _AClient(messages)
    wrap_anthropic(client, select_tools=True)

    client.messages.create(
        model="claude-opus-4-8",
        messages=[{"role": "user", "content": "send a message to a recipient"}],
        tools=tools,
    )
    sent = {t["name"] for t in messages.last_kwargs["tools"]}
    assert "send_email" in sent
    assert "read_file" not in sent
    assert len(messages.last_kwargs["tools"]) < len(tools)
