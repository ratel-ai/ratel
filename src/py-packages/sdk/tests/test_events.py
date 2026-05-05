import asyncio

import httpx
import pytest
import respx

from agentified.api_client import ApiClient
from agentified.context_builder import ContextBuilder
from agentified.events import (
    ContextAssembledEvent,
    ObserverEmitter,
    RecallEvent,
    StepEvent,
)
from agentified.instance import Instance
from agentified.models import ApiClientConfig, BackendTool, RecallConfig

TEST_URL = "http://localhost:9119"

CONTEXT_RESPONSE_BASE = {
    "messages": [{
        "id": "m1", "role": "user", "content": "hi",
        "tool_call_id": None, "tool_calls": None,
        "created_at": "2026-01-01T00:00:00Z", "seq": 1,
    }],
    "strategy_used": "recent",
    "total_messages": 1,
    "included_messages": 1,
    "recalled": {"tools": [], "memories": []},
    "token_estimate": 5,
    "conversation_messages": 1,
    "fallback": False,
}

RANKED = {
    "name": "get_weather",
    "description": "",
    "parameters": {},
    "score": 0.9,
}


class TestObserverEmitter:
    def test_calls_sync_listener(self):
        emitter = ObserverEmitter()
        calls = []
        emitter.on("context_assembled", lambda e: calls.append(e))
        emitter.emit("context_assembled", {"x": 1})
        assert calls == [{"x": 1}]

    def test_disposer_removes_listener(self):
        emitter = ObserverEmitter()
        calls = []
        off = emitter.on("context_assembled", lambda e: calls.append(e))
        off()
        emitter.emit("context_assembled", {})
        assert calls == []

    def test_swallows_listener_errors(self):
        emitter = ObserverEmitter()
        good = []

        def bad(_e):
            raise RuntimeError("boom")

        emitter.on("context_assembled", bad)
        emitter.on("context_assembled", lambda e: good.append(e))
        emitter.emit("context_assembled", {})
        assert good == [{}]

    async def test_async_listener_is_scheduled(self):
        emitter = ObserverEmitter()
        received: list[dict] = []

        async def async_cb(evt):
            await asyncio.sleep(0)
            received.append(evt)

        emitter.on("context_assembled", async_cb)
        emitter.emit("context_assembled", {"k": 1})
        # Let the scheduled task run
        for _ in range(3):
            await asyncio.sleep(0)
        assert received == [{"k": 1}]


class TestContextBuilderEvents:
    @respx.mock
    async def test_emits_context_assembled_once(self):
        respx.post(f"{TEST_URL}/api/v1/context").mock(
            return_value=httpx.Response(200, json=CONTEXT_RESPONSE_BASE)
        )
        emitter = ObserverEmitter()
        events: list[ContextAssembledEvent] = []
        emitter.on("context_assembled", lambda e: events.append(e))

        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        cb = ContextBuilder(sdk, "ds", "ns", "sess-1", emitter=emitter)
        await cb.messages(strategy="recent").assemble()

        assert len(events) == 1
        assert events[0].session_id == "sess-1"
        assert events[0].dataset_id == "ds"
        assert events[0].strategy_used == "recent"
        assert events[0].total_messages == 1
        assert events[0].included_messages == 1
        assert events[0].token_estimate == 5
        assert events[0].fallback is False
        assert events[0].recalled == {"tools": []}
        assert events[0].duration_ms >= 0

    @respx.mock
    async def test_does_not_emit_recall_when_not_configured(self):
        respx.post(f"{TEST_URL}/api/v1/context").mock(
            return_value=httpx.Response(200, json=CONTEXT_RESPONSE_BASE)
        )
        emitter = ObserverEmitter()
        recall_events: list[RecallEvent] = []
        emitter.on("recall", lambda e: recall_events.append(e))

        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        cb = ContextBuilder(sdk, "ds", "ns", "sess", emitter=emitter)
        await cb.assemble()
        assert recall_events == []

    @respx.mock
    async def test_emits_recall_when_configured(self):
        resp = dict(CONTEXT_RESPONSE_BASE)
        resp["recalled"] = {"tools": [RANKED], "memories": []}
        respx.post(f"{TEST_URL}/api/v1/context").mock(
            return_value=httpx.Response(200, json=resp)
        )
        emitter = ObserverEmitter()
        recall_events: list[RecallEvent] = []
        ctx_events: list[ContextAssembledEvent] = []
        emitter.on("recall", lambda e: recall_events.append(e))
        emitter.on("context_assembled", lambda e: ctx_events.append(e))

        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        cb = ContextBuilder(sdk, "ds", "ns", "sess", emitter=emitter)
        await cb.recall().assemble()

        assert len(recall_events) == 1
        assert recall_events[0].session_id == "sess"
        assert recall_events[0].config is not None
        assert recall_events[0].config.tools is True
        assert len(recall_events[0].matches) == 1
        assert recall_events[0].duration_ms >= 0

        assert len(ctx_events) == 1
        assert len(ctx_events[0].recalled["tools"]) == 1

    @respx.mock
    async def test_no_emitter_is_safe(self):
        respx.post(f"{TEST_URL}/api/v1/context").mock(
            return_value=httpx.Response(200, json=CONTEXT_RESPONSE_BASE)
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        cb = ContextBuilder(sdk, "ds", "ns", "sess")
        await cb.assemble()  # must not throw


class TestInstanceStepEvents:
    def test_on_step_finish_emits_step_event(self):
        emitter = ObserverEmitter()
        events: list[StepEvent] = []
        emitter.on("step", lambda e: events.append(e))

        # Build an Instance with a fake sdk (only needs as_discover_tool)
        class FakeSdk:
            def as_discover_tool(self, *args, **kwargs):
                class D:
                    definition = type("X", (), {"name": "agentified_discover", "description": "", "parameters": {}})
                    discovered_names = set()
                    execute = None
                return D()

        inst = Instance("i", "ds", FakeSdk(), [], emitter=emitter)
        inst.on_step_finish({
            "tool_calls": [{"name": "x"}],
            "tool_results": [{"result": 1}],
            "usage": {"input": 10},
            "finish_reason": "stop",
        })

        assert len(events) == 1
        assert events[0].step_index == 0
        assert events[0].tool_calls == [{"name": "x"}]
        assert events[0].tool_results == [{"result": 1}]
        assert events[0].finish_reason == "stop"

    def test_step_index_increments(self):
        emitter = ObserverEmitter()
        events: list[StepEvent] = []
        emitter.on("step", lambda e: events.append(e))

        class FakeSdk:
            def as_discover_tool(self, *args, **kwargs):
                class D:
                    definition = type("X", (), {"name": "d", "description": "", "parameters": {}})
                    discovered_names = set()
                    execute = None
                return D()

        inst = Instance("i", "ds", FakeSdk(), [], emitter=emitter)
        inst.on_step_finish({})
        inst.on_step_finish({})
        inst.on_step_finish({})
        assert [e.step_index for e in events] == [0, 1, 2]

    def test_on_step_finish_is_safe_without_emitter(self):
        class FakeSdk:
            def as_discover_tool(self, *args, **kwargs):
                class D:
                    definition = type("X", (), {"name": "d", "description": "", "parameters": {}})
                    discovered_names = set()
                    execute = None
                return D()

        inst = Instance("i", "ds", FakeSdk(), [])
        # Should not throw
        inst.on_step_finish({})
        off = inst.on("step", lambda e: None)
        off()
