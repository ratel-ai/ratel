"""Non-blocking, best-effort client for Ratel Cloud telemetry."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable, Coroutine
from typing import Any

import httpx

from .events import Event
from .transport import MAX_BATCH, send_batch
from .validate import validate


class RatelCloud:
    """``record`` validates and enqueues without awaiting the network; batches
    flush on a timer, on reaching ``batch_size``, or explicitly via ``flush``.

    Use as an async context manager to run the periodic flush task::

        async with RatelCloud(endpoint=..., api_key=...) as cloud:
            cloud.record(event)

    The caller may pass its own ``httpx.AsyncClient`` (owned by the caller); if
    omitted, each batch uses a transient client. Nothing here raises into the host.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        batch_size: int = 100,
        flush_interval: float = 5.0,
        validate_events: bool = True,
        max_retries: int = 3,
        timeout: float = 10.0,
        client: httpx.AsyncClient | None = None,
        on_error: Callable[[Exception], None] | None = None,
    ) -> None:
        self._endpoint = endpoint
        self._api_key = api_key
        self._batch_size = min(batch_size, MAX_BATCH)
        self._flush_interval = flush_interval
        self._validate_events = validate_events
        self._max_retries = max_retries
        self._timeout = timeout
        self._client = client
        self._on_error = on_error

        self._queue: list[Event] = []
        self._lock = asyncio.Lock()
        self._tasks: set[asyncio.Task[None]] = set()
        self._timer: asyncio.Task[None] | None = None

    def record(self, event: Event) -> None:
        """Validate (unless disabled) and enqueue an event. Never blocks or raises."""
        if self._validate_events:
            result = validate(event)
            if not result.ok:
                if self._on_error is not None:
                    detail = "; ".join(f"{i.path} {i.message}" for i in result.issues)
                    self._on_error(RuntimeError(f"ratel-cloud: dropped invalid event: {detail}"))
                return
        self._queue.append(event)
        if len(self._queue) >= self._batch_size:
            self._schedule(self.flush())

    def _schedule(self, coro: Coroutine[Any, Any, None]) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No running loop — rely on an explicit `await flush()` later.
            coro.close()
            return
        task = loop.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def flush(self) -> None:
        """Drain the queue, sending in ``batch_size``-bounded requests."""
        async with self._lock:
            while self._queue:
                batch = self._queue[: self._batch_size]
                del self._queue[: self._batch_size]
                result = await send_batch(
                    batch,
                    endpoint=self._endpoint,
                    api_key=self._api_key,
                    client=self._client,
                    max_retries=self._max_retries,
                    timeout=self._timeout,
                    on_error=self._on_error,
                )
                # Best-effort: a rejected batch is dropped, not requeued.
                if not result.ok:
                    break

    async def start(self) -> None:
        """Start the periodic flush task (no-op if disabled or already running)."""
        if self._flush_interval > 0 and self._timer is None:
            self._timer = asyncio.create_task(self._run_timer())

    async def _run_timer(self) -> None:
        with contextlib.suppress(asyncio.CancelledError):
            while True:
                await asyncio.sleep(self._flush_interval)
                await self.flush()

    async def aclose(self) -> None:
        """Stop the timer, await pending flushes, and drain whatever remains."""
        if self._timer is not None:
            self._timer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._timer
            self._timer = None
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        await self.flush()

    async def __aenter__(self) -> RatelCloud:
        await self.start()
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()
