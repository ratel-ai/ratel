"""Turn scope and external tool calls (ADR-0026): the Python mirror of turn.test.ts."""

from __future__ import annotations

import asyncio
import re
from typing import Any

import pytest

from ratel_ai import (
    TURN_USER_MESSAGE_MAX_BYTES,
    ExecutableTool,
    IntentGraph,
    RuntimeEvents,
    ToolCatalog,
    current_turn_id,
    invoke_tool_tool,
    search_capabilities_tool,
)


def _tool(tool_id: str, description: str) -> ExecutableTool:
    async def run(_args: dict[str, Any]) -> str:
        await asyncio.sleep(0)
        return "ok"

    return ExecutableTool(id=tool_id, name=tool_id, description=description, execute=run)


async def _catalog() -> ToolCatalog:
    catalog = ToolCatalog()
    await catalog.register(
        [
            _tool("deploy_app", "deploy the app to production servers"),
            _tool("read_logs", "read the application logs"),
        ]
    )
    return catalog


class _Capture:
    def __init__(self, catalog: ToolCatalog) -> None:
        self.events: list[dict[str, Any]] = []
        self._subscription = RuntimeEvents([catalog]).subscribe(self.events.extend)

    async def done(self) -> list[dict[str, Any]]:
        await self._subscription.flush()
        self._subscription.unsubscribe()
        return self.events


def _of_type(events: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    return [event for event in events if event["type"] == kind]


async def test_stamps_turn_and_end_user_on_everything_inside_with_one_turn_start() -> None:
    catalog = await _catalog()
    capture = _Capture(catalog)
    async with catalog.turn("req-1", user_message="please deploy", end_user_id="user-7"):
        assert current_turn_id() == "req-1"
        catalog.search("deploy the app", 3)
        await asyncio.sleep(0)
        await catalog.invoke("deploy_app", {})
    assert current_turn_id() is None
    events = await capture.done()

    starts = _of_type(events, "turn_start")
    assert len(starts) == 1
    assert starts[0]["turn_id"] == "req-1"
    assert starts[0]["user_message"] == "please deploy"
    assert starts[0]["end_user_id"] == "user-7"
    for kind in ("search", "invoke_start", "invoke_end"):
        (event,) = _of_type(events, kind)
        assert event["turn_id"] == "req-1"
        assert event["end_user_id"] == "user-7"


async def test_sync_with_mints_an_id_and_omits_unset_fields() -> None:
    catalog = await _catalog()
    capture = _Capture(catalog)
    with catalog.turn() as turn:
        minted = current_turn_id()
        catalog.search("deploy the app", 3)
    events = await capture.done()

    assert minted is not None and re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{26}", minted)
    assert turn.id == minted
    (start,) = _of_type(events, "turn_start")
    assert start["turn_id"] == minted
    assert "user_message" not in start
    assert "end_user_id" not in start
    assert _of_type(events, "search")[0]["turn_id"] == minted


async def test_two_interleaved_async_turns_keep_their_own_ids() -> None:
    catalog = await _catalog()
    capture = _Capture(catalog)

    async def run(turn_id: str, query: str, tool_id: str) -> None:
        async with catalog.turn(turn_id, end_user_id=f"user-{turn_id}"):
            await asyncio.sleep(0)
            catalog.search(query, 3)
            await asyncio.sleep(0)
            await catalog.invoke(tool_id, {})
            await asyncio.sleep(0)
            await catalog.invoke(tool_id, {})

    await asyncio.gather(
        run("a", "deploy the app", "deploy_app"), run("b", "read the logs", "read_logs")
    )
    events = await capture.done()

    invokes = _of_type(events, "invoke_start")
    assert len(invokes) == 4
    for event in invokes:
        assert event["turn_id"] == ("a" if event["tool_id"] == "deploy_app" else "b")
        assert event["end_user_id"] == f"user-{event['turn_id']}"
    searches = {event["query"]: event["turn_id"] for event in _of_type(events, "search")}
    assert searches == {"deploy the app": "a", "read the logs": "b"}


async def test_nested_turn_wins_and_restores_the_outer_one() -> None:
    catalog = await _catalog()
    capture = _Capture(catalog)
    seen: list[str | None] = []
    async with catalog.turn("outer", end_user_id="user-1"):
        seen.append(current_turn_id())
        async with catalog.turn("inner"):
            seen.append(current_turn_id())
            await catalog.invoke("deploy_app", {})
        seen.append(current_turn_id())
        await catalog.invoke("read_logs", {})
    events = await capture.done()

    assert seen == ["outer", "inner", "outer"]
    assert [(e["turn_id"], e["end_user_id"]) for e in _of_type(events, "turn_start")] == [
        ("outer", "user-1"),
        ("inner", "user-1"),
    ]
    assert [(e["tool_id"], e["turn_id"]) for e in _of_type(events, "invoke_start")] == [
        ("deploy_app", "inner"),
        ("read_logs", "outer"),
    ]


async def test_explicit_turn_id_argument_wins_over_the_scope() -> None:
    catalog = await _catalog()
    capture = _Capture(catalog)
    async with catalog.turn("scoped", end_user_id="user-1"):
        catalog.search("deploy the app", 3, turn_id="explicit")
        await catalog.invoke("deploy_app", {}, "explicit")
    events = await capture.done()

    (search,) = _of_type(events, "search")
    assert search["turn_id"] == "explicit"
    assert search["end_user_id"] == "user-1"
    assert _of_type(events, "invoke_end")[0]["turn_id"] == "explicit"


async def test_turn_start_is_emitted_once_per_turn_id() -> None:
    catalog = await _catalog()
    capture = _Capture(catalog)
    with catalog.turn("req-1", user_message="first"):
        pass
    async with catalog.turn("req-1", user_message="resumed"):
        async with catalog.turn("req-1"):
            pass
    events = await capture.done()

    starts = _of_type(events, "turn_start")
    assert [(e["turn_id"], e["user_message"]) for e in starts] == [("req-1", "first")]


async def test_user_message_is_capped_at_4_kib_without_splitting_a_character() -> None:
    catalog = await _catalog()
    capture = _Capture(catalog)
    with catalog.turn(user_message="é" * TURN_USER_MESSAGE_MAX_BYTES):
        pass
    events = await capture.done()

    message = _of_type(events, "turn_start")[0]["user_message"]
    assert len(message.encode()) == TURN_USER_MESSAGE_MAX_BYTES
    assert message == "é" * (TURN_USER_MESSAGE_MAX_BYTES // 2)


async def test_events_outside_any_turn_carry_no_turn_id() -> None:
    catalog = await _catalog()
    capture = _Capture(catalog)
    catalog.search("deploy the app", 3)
    await catalog.invoke("deploy_app", {})
    events = await capture.done()

    assert events
    assert not _of_type(events, "turn_start")
    assert all("turn_id" not in e and "end_user_id" not in e for e in events)


async def test_capability_tools_called_inside_a_turn_carry_it() -> None:
    catalog = await _catalog()
    search = search_capabilities_tool(catalog)
    invoke = invoke_tool_tool(catalog)
    capture = _Capture(catalog)
    async with catalog.turn("model-turn"):
        await search.execute({"query": "deploy the app"})
        await invoke.execute({"toolId": "deploy_app", "args": {}})
    events = await capture.done()

    for kind in ("gateway_search", "search", "gateway_invoke", "invoke_start"):
        assert [e["turn_id"] for e in _of_type(events, kind)] == ["model-turn"], kind


def test_rejects_bad_turn_options() -> None:
    catalog = ToolCatalog()
    with pytest.raises(TypeError):
        catalog.turn("")
    with pytest.raises(TypeError):
        catalog.turn(user_message=1)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        catalog.turn(end_user_id=1)  # type: ignore[arg-type]


async def test_record_tool_call_records_one_external_lifecycle_in_the_current_turn() -> None:
    catalog = await _catalog()
    capture = _Capture(catalog)
    async with catalog.turn("turn-1", end_user_id="user-1"):
        catalog.record_tool_call("web_search", took_ms=12.4)
    events = await capture.done()

    (start,) = _of_type(events, "invoke_start")
    (end,) = _of_type(events, "invoke_end")
    assert start["tool_id"] == end["tool_id"] == "web_search"
    assert start["args_size_bytes"] == 0
    assert end["took_ms"] == 12
    for event in (start, end):
        assert event["origin"] == "external"
        assert event["turn_id"] == "turn-1"
        assert event["end_user_id"] == "user-1"
    assert start["invocation_id"] == end["invocation_id"]
    assert start["event_id"] != end["event_id"]
    assert not _of_type(events, "invoke_error")


async def test_record_tool_call_error_path() -> None:
    catalog = await _catalog()
    capture = _Capture(catalog)
    catalog.record_tool_call("web_search", took_ms=5, error=RuntimeError("rate limited"))
    catalog.record_tool_call("web_search", error="timed out", turn_id="explicit")
    events = await capture.done()

    assert not _of_type(events, "invoke_end")
    first, second = _of_type(events, "invoke_error")
    assert (first["took_ms"], first["error"], first["origin"]) == (5, "rate limited", "external")
    assert "turn_id" not in first
    assert (second["took_ms"], second["error"], second["turn_id"]) == (0, "timed out", "explicit")


async def test_invoke_is_not_marked_external() -> None:
    catalog = await _catalog()
    capture = _Capture(catalog)
    await catalog.invoke("deploy_app", {})
    events = await capture.done()

    assert _of_type(events, "invoke_start")
    assert all(event.get("origin") != "external" for event in events)


async def test_record_tool_call_teaches_adaptive_ranking_like_an_invoke() -> None:
    catalog = ToolCatalog()
    await catalog.register(
        [
            _tool("docker_build", "Build a Docker image from a Dockerfile"),
            _tool("gh_run_list", "List CI workflow runs and whether the build passed"),
        ]
    )
    assert catalog.search("why is the build broken", 5)[0].tool_id == "docker_build"
    graph = IntentGraph()
    catalog.experimental_enable_adaptive_ranking(graph)

    for query in (
        "why is the build broken",
        "is the build broken again",
        "the build broken on main",
    ):
        with catalog.turn():
            catalog.search(query, 5, "agent")
            catalog.record_tool_call("gh_run_list", took_ms=3)

    assert graph.cluster_count == 1
    order = [hit.tool_id for hit in catalog.search("why is the build broken", 5)]
    assert order.index("gh_run_list") < order.index("docker_build")


@pytest.mark.parametrize(
    ("args", "kwargs"),
    [
        (("",), {}),
        (("x",), {"took_ms": -1}),
        (("x",), {"took_ms": float("nan")}),
        (("x",), {"took_ms": True}),
        (("x",), {"turn_id": ""}),
    ],
)
async def test_record_tool_call_rejects_malformed_calls(
    args: tuple[Any, ...], kwargs: dict[str, Any]
) -> None:
    catalog = await _catalog()
    capture = _Capture(catalog)
    with pytest.raises(TypeError):
        catalog.record_tool_call(*args, **kwargs)
    assert await capture.done() == []


async def test_turn_start_and_external_calls_join_the_callers_trace() -> None:
    pytest.importorskip("opentelemetry.sdk.trace")
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider

    if not isinstance(trace.get_tracer_provider(), TracerProvider):
        trace.set_tracer_provider(TracerProvider())
    catalog = await _catalog()
    capture = _Capture(catalog)
    with trace.get_tracer("host").start_as_current_span("request") as span:
        trace_id = f"{span.get_span_context().trace_id:032x}"
        with catalog.turn("t"):
            catalog.record_tool_call("host_tool")
    events = await capture.done()

    assert _of_type(events, "turn_start")[0]["trace_id"] == trace_id
    assert _of_type(events, "invoke_end")[0]["trace_id"] == trace_id


async def test_failed_turn_start_restores_the_context_and_can_be_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog = await _catalog()

    def broken(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("sink down")

    with monkeypatch.context() as patch:
        patch.setattr(catalog, "record_event", broken)
        with pytest.raises(RuntimeError, match="sink down"):
            async with catalog.turn("retry-turn"):
                pass
        assert current_turn_id() is None

    capture = _Capture(catalog)
    with catalog.turn("retry-turn"):
        pass
    events = await capture.done()
    assert [e["turn_id"] for e in _of_type(events, "turn_start")] == ["retry-turn"]
