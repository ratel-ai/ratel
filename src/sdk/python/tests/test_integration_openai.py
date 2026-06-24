"""OpenAI drop-in wrapper — traced via fake clients (no SDK, no network)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from ratel_ai.observability import CaptureExporter
from ratel_ai.openai import OpenAI, wrap_openai


class _Usage:
    def __init__(self) -> None:
        self.prompt_tokens = 12
        self.completion_tokens = 8
        self.total_tokens = 20


class _Message:
    def __init__(self) -> None:
        self.role = "assistant"
        self.content = "hi there"


class _Choice:
    def __init__(self) -> None:
        self.message = _Message()
        self.finish_reason = "stop"


class _Response:
    def __init__(self) -> None:
        self.model = "gpt-4o-2024-08-06"
        self.choices = [_Choice()]
        self.usage = _Usage()


class _Completions:
    def create(self, **kwargs: Any) -> _Response:
        return _Response()


class _AsyncCompletions:
    async def create(self, **kwargs: Any) -> _Response:
        return _Response()


class _Chat:
    def __init__(self, async_: bool = False) -> None:
        self.completions: Any = _AsyncCompletions() if async_ else _Completions()


class _FakeClient:
    def __init__(self, async_: bool = False) -> None:
        self.chat = _Chat(async_=async_)


def _gen(exporter: CaptureExporter) -> dict[str, Any]:
    obs = [e for e in exporter.events if e["type"] == "observation-create"]
    assert len(obs) == 1
    return obs[0]


def test_sync_create_is_traced(capture: CaptureExporter) -> None:
    client = wrap_openai(_FakeClient())
    resp = client.chat.completions.create(
        model="gpt-4o", messages=[{"role": "user", "content": "hi"}], temperature=0.2
    )
    assert isinstance(resp, _Response)  # original response passed through

    obs = _gen(capture)
    assert obs["observation_type"] == "generation"
    assert obs["gen_ai"]["system"] == "openai"
    assert obs["gen_ai"]["request"]["model"] == "gpt-4o"
    assert obs["gen_ai"]["request"]["temperature"] == 0.2
    assert obs["gen_ai"]["response"]["model"] == "gpt-4o-2024-08-06"
    assert obs["gen_ai"]["usage"] == {"input_tokens": 12, "output_tokens": 8, "total_tokens": 20}
    assert obs["status"] == "ok"


def test_async_create_is_traced(capture: CaptureExporter) -> None:
    client = wrap_openai(_FakeClient(async_=True))

    async def run() -> Any:
        return await client.chat.completions.create(model="gpt-4o", messages=[])

    asyncio.run(run())
    obs = _gen(capture)
    assert obs["gen_ai"]["usage"]["total_tokens"] == 20


def test_error_in_call_is_recorded_and_reraised(capture: CaptureExporter) -> None:
    class _Boom:
        def create(self, **kwargs: Any) -> Any:
            raise RuntimeError("rate limited")

    client = _FakeClient()
    client.chat.completions = _Boom()
    wrap_openai(client)

    with pytest.raises(RuntimeError, match="rate limited"):
        client.chat.completions.create(model="gpt-4o", messages=[])
    obs = _gen(capture)
    assert obs["status"] == "error"
    assert obs["status_message"] == "rate limited"


def test_streaming_captures_usage_at_end(capture: CaptureExporter) -> None:
    class _Chunk:
        def __init__(self, usage: Any = None) -> None:
            self.usage = usage

    class _Stream:
        def create(self, **kwargs: Any) -> Any:
            return iter([_Chunk(), _Chunk(), _Chunk(_Usage())])

    client = _FakeClient()
    client.chat.completions = _Stream()
    wrap_openai(client)

    stream = client.chat.completions.create(model="gpt-4o", messages=[], stream=True)
    chunks = list(stream)  # the wrapper yields through; observation ends after
    assert len(chunks) == 3
    obs = _gen(capture)
    assert obs["gen_ai"]["usage"]["total_tokens"] == 20


def test_streaming_preserves_stream_attributes(capture: CaptureExporter) -> None:
    class _SyncStream:
        def __init__(self) -> None:
            self.response = "RAW_RESPONSE"

        def __iter__(self) -> Any:
            return iter([_Chunk_with_usage()])

    class _Chunk_with_usage:  # noqa: N801
        def __init__(self) -> None:
            self.usage = _Usage()

    class _Stream:
        def create(self, **kwargs: Any) -> Any:
            return _SyncStream()

    client = _FakeClient()
    client.chat.completions = _Stream()
    wrap_openai(client)

    stream = client.chat.completions.create(model="gpt-4o", messages=[], stream=True)
    # provider-specific attributes survive the wrapper
    assert stream.response == "RAW_RESPONSE"
    list(stream)
    obs = _gen(capture)
    assert obs["gen_ai"]["usage"]["total_tokens"] == 20


def test_async_streaming_traced(capture: CaptureExporter) -> None:
    class _Chunk:
        def __init__(self, usage: Any = None) -> None:
            self.usage = usage

    class _AsyncStream:
        def __init__(self) -> None:
            self.response = "ARESP"

        async def __aiter__(self) -> Any:
            yield _Chunk()
            yield _Chunk(_Usage())

    class _AsyncStreamCompletions:
        async def create(self, **kwargs: Any) -> Any:
            return _AsyncStream()

    client = _FakeClient(async_=True)
    client.chat.completions = _AsyncStreamCompletions()
    wrap_openai(client)

    async def run() -> list[Any]:
        stream = await client.chat.completions.create(model="gpt-4o", messages=[], stream=True)
        assert stream.response == "ARESP"  # attribute passthrough on async proxy
        return [chunk async for chunk in stream]

    chunks = asyncio.run(run())
    assert len(chunks) == 2
    obs = _gen(capture)
    assert obs["gen_ai"]["usage"]["total_tokens"] == 20


def test_double_wrap_is_idempotent(capture: CaptureExporter) -> None:
    client = wrap_openai(wrap_openai(_FakeClient()))
    client.chat.completions.create(model="gpt-4o", messages=[])
    # patched once → a single observation, not two.
    assert len(_gen_list(capture)) == 1


def _gen_list(exporter: CaptureExporter) -> list[dict[str, Any]]:
    return [e for e in exporter.events if e["type"] == "observation-create"]


def test_missing_sdk_raises_clear_hint() -> None:
    # `openai` is not installed in the test env; constructing must hint clearly.
    with pytest.raises(ImportError, match="pip install openai"):
        OpenAI()
