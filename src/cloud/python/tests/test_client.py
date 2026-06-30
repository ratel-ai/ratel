from __future__ import annotations

import json

import httpx

from ratel_ai_cloud import Event, RatelCloud


def event() -> Event:
    return {
        "provider": "openai",
        "model": "gpt-5.5",
        "ts": "2026-06-30T12:00:00Z",
        "stream": False,
        "messages": [{"role": "user", "content": "hi"}],
    }


def recording_client() -> tuple[httpx.AsyncClient, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(202, json={"accepted": 1})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler)), seen


async def test_record_does_not_send_until_flush() -> None:
    http, seen = recording_client()
    async with http:
        cloud = RatelCloud(endpoint="https://x", api_key="k", flush_interval=0, client=http)
        cloud.record(event())
        cloud.record(event())
        assert seen == []

        await cloud.flush()
        assert len(seen) == 1
        assert len(json.loads(seen[0].content)) == 2


async def test_drops_invalid_events_without_enqueuing() -> None:
    http, seen = recording_client()
    errors: list[Exception] = []
    async with http:
        cloud = RatelCloud(
            endpoint="https://x",
            api_key="k",
            flush_interval=0,
            client=http,
            on_error=errors.append,
        )
        cloud.record({**event(), "provider": ""})
        await cloud.flush()

    assert len(errors) == 1
    assert seen == []


async def test_close_flushes_remaining() -> None:
    http, seen = recording_client()
    async with http:
        cloud = RatelCloud(endpoint="https://x", api_key="k", flush_interval=0, client=http)
        cloud.record(event())
        await cloud.aclose()
    assert len(seen) == 1


async def test_large_queue_splits_into_max_batch_requests() -> None:
    http, seen = recording_client()
    async with http:
        cloud = RatelCloud(
            endpoint="https://x", api_key="k", flush_interval=0, batch_size=500, client=http
        )
        for _ in range(1100):
            cloud.record(event())
        await cloud.flush()
    # 1100 events / 500 per batch → 3 requests.
    assert len(seen) == 3
