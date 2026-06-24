"""Anthropic drop-in wrapper — traced via fake clients (no SDK, no network)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from ratel_ai.anthropic import Anthropic, wrap_anthropic
from ratel_ai.observability import CaptureExporter


class _Usage:
    def __init__(self) -> None:
        self.input_tokens = 30
        self.output_tokens = 10


class _Response:
    def __init__(self) -> None:
        self.model = "claude-opus-4-8"
        self.content = [{"type": "text", "text": "hello"}]
        self.usage = _Usage()
        self.stop_reason = "end_turn"


class _Messages:
    def create(self, **kwargs: Any) -> _Response:
        return _Response()


class _AsyncMessages:
    async def create(self, **kwargs: Any) -> _Response:
        return _Response()


class _FakeClient:
    def __init__(self, async_: bool = False) -> None:
        self.messages: Any = _AsyncMessages() if async_ else _Messages()


def _gen(exporter: CaptureExporter) -> dict[str, Any]:
    obs = [e for e in exporter.events if e["type"] == "observation-create"]
    assert len(obs) == 1
    return obs[0]


def test_sync_messages_create_is_traced(capture: CaptureExporter) -> None:
    client = wrap_anthropic(_FakeClient())
    resp = client.messages.create(
        model="claude-opus-4-8",
        messages=[{"role": "user", "content": "hi"}],
        max_tokens=256,
    )
    assert isinstance(resp, _Response)

    obs = _gen(capture)
    assert obs["observation_type"] == "generation"
    assert obs["gen_ai"]["system"] == "anthropic"
    assert obs["gen_ai"]["request"]["model"] == "claude-opus-4-8"
    assert obs["gen_ai"]["request"]["max_tokens"] == 256
    assert obs["gen_ai"]["usage"] == {"input_tokens": 30, "output_tokens": 10, "total_tokens": 40}
    assert obs["gen_ai"]["response"]["finish_reasons"] == ["end_turn"]


def test_async_messages_create_is_traced(capture: CaptureExporter) -> None:
    client = wrap_anthropic(_FakeClient(async_=True))

    async def run() -> Any:
        return await client.messages.create(model="claude-opus-4-8", messages=[])

    asyncio.run(run())
    obs = _gen(capture)
    assert obs["gen_ai"]["usage"]["total_tokens"] == 40


def test_error_is_recorded_and_reraised(capture: CaptureExporter) -> None:
    class _Boom:
        def create(self, **kwargs: Any) -> Any:
            raise RuntimeError("overloaded")

    client = _FakeClient()
    client.messages = _Boom()
    wrap_anthropic(client)

    with pytest.raises(RuntimeError, match="overloaded"):
        client.messages.create(model="claude-opus-4-8", messages=[])
    obs = _gen(capture)
    assert obs["status"] == "error"


def test_system_prompt_captured_when_input_capture_on(capture: CaptureExporter) -> None:
    client = wrap_anthropic(_FakeClient())
    client.messages.create(
        model="claude-opus-4-8",
        messages=[],
        system="You are a helpful assistant with PII context.",
        max_tokens=128,
    )
    obs = _gen(capture)
    assert obs["gen_ai"]["request"]["system"] == "You are a helpful assistant with PII context."


def test_system_prompt_suppressed_when_input_capture_off() -> None:
    from ratel_ai.observability import RatelClient, set_global_client

    exporter = CaptureExporter()
    set_global_client(RatelClient(api_key="rk-test", capture_input=False, exporter=exporter))

    client = wrap_anthropic(_FakeClient())
    client.messages.create(
        model="claude-opus-4-8",
        messages=[],
        system="secret system prompt that must not leak",
        max_tokens=128,
    )
    obs = [e for e in exporter.events if e["type"] == "observation-create"][0]
    # capture_input=False → the system prompt is not shipped
    assert "system" not in obs["gen_ai"]["request"]
    assert obs["input"]["captured"] is False


def test_missing_sdk_raises_clear_hint() -> None:
    with pytest.raises(ImportError, match="pip install anthropic"):
        Anthropic()
