"""Background, batched, best-effort cloud exporter (ADR-0016).

The hot path only enqueues onto a bounded queue (O(1), drops oldest on overflow).
A daemon thread batches by size or interval and POSTs a JSON array of usage
rollups to `{host}/api/v1/events`. The whole send path is wrapped so the
customer's app is never blocked or broken: on overflow events are dropped, on 4xx
the batch is dropped, on 5xx/network it retries with capped backoff, and every
failure is logged at most once per class.

`httpx` is imported lazily so the tracing core works without it installed.
"""

from __future__ import annotations

import contextlib
import logging
import os
import queue
import random
import threading
import time
from collections.abc import Callable
from typing import Any

from .config import ObservabilityConfig

logger = logging.getLogger("ratel_ai.observability")

_MAX_ATTEMPTS = 3
_BACKOFF_BASE = 0.2  # seconds


def _sdk_version() -> str:
    """Best-effort installed package version for the User-Agent; never raises."""
    try:
        from importlib.metadata import PackageNotFoundError, version

        try:
            return version("ratel-ai")
        except PackageNotFoundError:
            return "0.0.0"
    except Exception:
        return "0.0.0"


class _Control:
    """A control message threaded through the queue (flush / stop)."""

    __slots__ = ("kind", "event")

    def __init__(self, kind: str, event: threading.Event) -> None:
        self.kind = kind
        self.event = event


class BatchProcessor:
    """Threaded exporter. Construct only when the config can export."""

    def __init__(
        self,
        config: ObservabilityConfig,
        sender: Callable[[list[dict[str, Any]]], None] | None = None,
    ) -> None:
        self.config = config
        # `sender` overrides the default httpx transport — used in tests to drive
        # batching deterministically without a network or real httpx client.
        self._sender = sender
        self._queue: queue.Queue[Any] = queue.Queue(maxsize=config.max_queue)
        self._worker: threading.Thread | None = None
        self._lock = threading.Lock()
        self._pid = os.getpid()
        self._http: Any = None
        self._warned: set[str] = set()

    # -- public Exporter API -------------------------------------------------

    def enqueue(self, event: dict[str, Any]) -> None:
        self._ensure_worker()
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            # Drop the oldest to make room — query-log semantics (ADR-0009).
            try:
                self._queue.get_nowait()
                self._queue.task_done()
            except queue.Empty:
                pass
            try:
                self._queue.put_nowait(event)
            except queue.Full:
                self._warn_once("overflow", "ratel: trace queue full, dropping events")

    def flush(self, timeout: float | None = None) -> None:
        worker = self._worker
        if worker is None or not worker.is_alive():
            return
        done = threading.Event()
        self._put_control(_Control("flush", done))
        done.wait(self.config.timeout if timeout is None else timeout)

    def shutdown(self) -> None:
        worker = self._worker
        if worker is None or not worker.is_alive():
            return
        done = threading.Event()
        self._put_control(_Control("stop", done))
        done.wait(self.config.timeout)
        worker.join(timeout=self.config.timeout)
        self._close_http()

    # -- worker --------------------------------------------------------------

    def _ensure_worker(self) -> None:
        # Restart after a fork (child inherits a dead thread) or on first use.
        if self._worker is not None and self._worker.is_alive() and self._pid == os.getpid():
            return
        with self._lock:
            if self._worker is not None and self._worker.is_alive() and self._pid == os.getpid():
                return
            if self._pid != os.getpid():
                # Forked: the inherited queue/thread belong to the parent.
                self._queue = queue.Queue(maxsize=self.config.max_queue)
                self._http = None
                self._warned = set()
                self._pid = os.getpid()
            self._worker = threading.Thread(
                target=self._run, name="ratel-exporter", daemon=True
            )
            self._worker.start()

    def _put_control(self, control: _Control) -> None:
        try:
            self._queue.put_nowait(control)
        except queue.Full:
            try:
                self._queue.get_nowait()
                self._queue.task_done()
            except queue.Empty:
                pass
            with contextlib.suppress(queue.Full):
                self._queue.put_nowait(control)

    def _run(self) -> None:
        batch: list[dict[str, Any]] = []
        while True:
            try:
                item = self._queue.get(timeout=self.config.flush_interval)
            except queue.Empty:
                if batch:
                    self._send(batch)
                    batch = []
                continue
            try:
                if isinstance(item, _Control):
                    if batch:
                        self._send(batch)
                        batch = []
                    item.event.set()
                    if item.kind == "stop":
                        return
                    continue
                batch.append(item)
                if len(batch) >= self.config.flush_at:
                    self._send(batch)
                    batch = []
            finally:
                self._queue.task_done()

    # -- transport -----------------------------------------------------------

    def _send(self, batch: list[dict[str, Any]]) -> None:
        try:
            payload = list(batch)
            if self._sender is not None:
                self._sender(payload)
            else:
                self._post(payload)
        except Exception as exc:  # a bad batch must never kill the worker
            logger.debug("ratel: batch send error: %s", exc)

    def _client(self) -> Any:
        if self._http is not None:
            return self._http
        import httpx  # lazy: optional dependency

        self._http = httpx.Client(timeout=self.config.timeout)
        return self._http

    def _post(self, payload: list[dict[str, Any]]) -> None:
        import httpx

        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
            "User-Agent": f"ratel-ai-python/{_sdk_version()}",
        }
        client = self._client()
        delay = _BACKOFF_BASE
        for attempt in range(_MAX_ATTEMPTS):
            try:
                resp = client.post(self.config.events_url, json=payload, headers=headers)
                status = resp.status_code
                if status < 300:
                    return
                if 400 <= status < 500:
                    # Bad key/payload — retrying won't help. Drop and warn once.
                    self._warn_once(
                        f"http_{status}", f"ratel: ingest rejected ({status}); dropping batch"
                    )
                    return
                # 5xx — fall through to retry.
            except httpx.HTTPError as exc:
                if attempt == _MAX_ATTEMPTS - 1:
                    # Log only the exception type — its str() can echo the request
                    # URL, which may embed a proxy credential.
                    self._warn_once(
                        "network",
                        f"ratel: ingest unreachable ({type(exc).__name__}); dropping batch",
                    )
            if attempt < _MAX_ATTEMPTS - 1:
                time.sleep(delay + random.random() * _BACKOFF_BASE)
                delay *= 2
        self._warn_once("retries", "ratel: ingest failed after retries; dropping batch")

    def _close_http(self) -> None:
        if self._http is not None:
            with contextlib.suppress(Exception):
                self._http.close()
            self._http = None

    def _warn_once(self, key: str, message: str) -> None:
        # Called from both the caller's thread (overflow) and the worker thread
        # (network/retries) — guard the set so it's not a cross-thread data race.
        with self._lock:
            if key in self._warned:
                return
            self._warned.add(key)
        logger.warning(message)
