from __future__ import annotations

import json
from typing import Any

import httpx

from ratel_ai_cloud import Event, send_event_batch


def event() -> Event:
    return {
        "provider": "openai",
        "model": "gpt-5.5",
        "ts": "2026-06-30T12:00:00Z",
        "stream": False,
        "messages": [{"role": "user", "content": "hi"}],
    }


async def no_sleep(_seconds: float) -> None:
    return None


def client(handler: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_posts_with_bearer_and_returns_accepted() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(202, json={"accepted": 1})

    async with client(handler) as http:
        result = await send_event_batch(
            [event()],
            endpoint="https://x/api/v1/events",
            api_key="secret",
            client=http,
            sleep=no_sleep,
        )

    assert result.ok and result.accepted == 1 and result.status == 202
    assert seen[0].headers["authorization"] == "Bearer secret"
    assert len(json.loads(seen[0].content)) == 1


async def test_empty_batch_is_a_noop() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(202, json={})

    async with client(handler) as http:
        result = await send_event_batch([], endpoint="https://x", api_key="k", client=http)

    assert result.ok and result.accepted == 0
    assert calls == 0


async def test_retries_transient_5xx_then_succeeds() -> None:
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(503, json={})
        return httpx.Response(202, json={"accepted": 1})

    async with client(handler) as http:
        result = await send_event_batch(
            [event()], endpoint="https://x", api_key="k", client=http, base_delay=0, sleep=no_sleep
        )

    assert result.ok
    assert attempts == 2


async def test_retries_network_errors_then_gives_up() -> None:
    attempts = 0
    errors: list[Exception] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        raise httpx.ConnectError("boom", request=request)

    async with client(handler) as http:
        result = await send_event_batch(
            [event()],
            endpoint="https://x",
            api_key="k",
            client=http,
            max_retries=2,
            base_delay=0,
            sleep=no_sleep,
            on_error=errors.append,
        )

    assert not result.ok
    assert attempts == 3  # initial + 2 retries
    assert len(errors) == 1


async def test_does_not_retry_permanent_4xx() -> None:
    attempts = 0
    errors: list[Exception] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(400, json={"error": "bad"})

    async with client(handler) as http:
        result = await send_event_batch(
            [event()],
            endpoint="https://x",
            api_key="k",
            client=http,
            base_delay=0,
            sleep=no_sleep,
            on_error=errors.append,
        )

    assert not result.ok and result.status == 400
    assert attempts == 1
    assert len(errors) == 1
