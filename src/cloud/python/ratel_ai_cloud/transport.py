"""Best-effort HTTP transport: batches of events POSTed with retry/backoff."""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx

from .events import Event

#: Upper bound the ingest endpoint accepts in one request.
MAX_BATCH = 500


@dataclass
class SendResult:
    ok: bool
    accepted: int
    status: int | None = None


def _is_retryable(status: int) -> bool:
    return status == 429 or status >= 500


def _backoff(base_delay: float, attempt: int) -> float:
    # Full jitter in the top half of the window keeps a floor while spreading load.
    return float(base_delay * (2**attempt) * (0.5 + random.random() * 0.5))


def _accepted(response: httpx.Response, fallback: int) -> int:
    try:
        data = response.json()
    except ValueError:
        return fallback
    value = data.get("accepted") if isinstance(data, dict) else None
    return value if isinstance(value, int) else fallback


async def send_event_batch(
    events: list[Event],
    *,
    endpoint: str,
    api_key: str,
    client: httpx.AsyncClient | None = None,
    max_retries: int = 3,
    timeout: float = 10.0,
    base_delay: float = 0.2,
    on_error: Callable[[Exception], None] | None = None,
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> SendResult:
    """POST a batch of events. Best-effort: retries transient failures with
    exponential backoff + jitter, drops on permanent 4xx, and never raises."""
    if not events:
        return SendResult(ok=True, accepted=0)

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout)
    nap = sleep or asyncio.sleep
    headers = {"content-type": "application/json", "authorization": f"Bearer {api_key}"}

    try:
        for attempt in range(max_retries + 1):
            try:
                response = await http.post(endpoint, json=events, headers=headers, timeout=timeout)
            except httpx.HTTPError as err:
                if attempt == max_retries:
                    if on_error is not None:
                        on_error(err)
                    return SendResult(ok=False, accepted=0)
                await nap(_backoff(base_delay, attempt))
                continue

            if response.status_code < 300:
                accepted = _accepted(response, len(events))
                return SendResult(ok=True, accepted=accepted, status=response.status_code)

            if not _is_retryable(response.status_code) or attempt == max_retries:
                if on_error is not None:
                    on_error(
                        RuntimeError(f"ratel-cloud: ingest rejected with {response.status_code}")
                    )
                return SendResult(ok=False, accepted=0, status=response.status_code)

            await nap(_backoff(base_delay, attempt))

        return SendResult(ok=False, accepted=0)
    finally:
        if owns_client:
            await http.aclose()
