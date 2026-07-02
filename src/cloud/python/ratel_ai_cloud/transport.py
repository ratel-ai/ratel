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


def _safe_on_error(on_error: Callable[[Exception], None] | None, err: Exception) -> None:
    """Invoke a host error callback without letting it break us: the transport is
    contractually best-effort and must never raise into the host — not even when the
    observer itself throws (which, on the permanent-4xx path, would otherwise be caught
    by the retry loop and turn a permanent drop into repeated retries)."""
    if on_error is None:
        return
    try:
        on_error(err)
    except Exception:
        # A broken observer must not propagate — telemetry is best-effort.
        pass


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

    retries = max(0, max_retries)
    owns_client = client is None
    # When we own the client the timeout is set at construction; when the caller injects
    # one we respect its configuration rather than overriding per request.
    http = client or httpx.AsyncClient(timeout=timeout)
    nap = sleep or asyncio.sleep
    headers = {"content-type": "application/json", "authorization": f"Bearer {api_key}"}

    try:
        for attempt in range(retries + 1):
            try:
                response = await http.post(endpoint, json=events, headers=headers)
            except httpx.HTTPError as err:
                if attempt == retries:
                    _safe_on_error(on_error, err)
                    return SendResult(ok=False, accepted=0)
                await nap(_backoff(base_delay, attempt))
                continue

            if response.status_code < 300:
                accepted = _accepted(response, len(events))
                return SendResult(ok=True, accepted=accepted, status=response.status_code)

            if not _is_retryable(response.status_code) or attempt == retries:
                _safe_on_error(
                    on_error,
                    RuntimeError(f"ratel-cloud: ingest rejected with {response.status_code}"),
                )
                return SendResult(ok=False, accepted=0, status=response.status_code)

            await nap(_backoff(base_delay, attempt))

        return SendResult(ok=False, accepted=0)
    finally:
        if owns_client:
            await http.aclose()
