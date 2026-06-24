"""Cloud exporter: batching, flush, overflow, retries, fail-open (ADR-0013)."""

from __future__ import annotations

import threading
import time
from typing import Any

import httpx
import pytest

from ratel_ai.observability.config import ObservabilityConfig
from ratel_ai.observability.exporter import BatchProcessor


class _Recorder:
    """Thread-safe capture of payloads handed to the sender."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.payloads: list[dict[str, Any]] = []

    def __call__(self, payload: dict[str, Any]) -> None:
        with self._lock:
            self.payloads.append(payload)

    def total_events(self) -> int:
        with self._lock:
            return sum(len(p["batch"]) for p in self.payloads)


def _cfg(**kw: Any) -> ObservabilityConfig:
    base: dict[str, Any] = {
        "api_key": "rk-test",
        "flush_at": 50,
        "flush_interval": 0.05,
        "timeout": 1.0,
        "max_queue": 10_000,
    }
    base.update(kw)
    return ObservabilityConfig.resolve(**base)


def _wait_for(predicate: Any, timeout: float = 2.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def _event(i: int) -> dict[str, Any]:
    return {"id": f"evt_{i}", "type": "observation-create"}


def test_flush_drains_pending_events() -> None:
    rec = _Recorder()
    proc = BatchProcessor(_cfg(flush_at=1000), sender=rec)
    for i in range(5):
        proc.enqueue(_event(i))
    proc.flush(timeout=2.0)
    assert rec.total_events() == 5
    proc.shutdown()


def test_batches_by_size() -> None:
    rec = _Recorder()
    proc = BatchProcessor(_cfg(flush_at=3, flush_interval=10.0), sender=rec)
    for i in range(3):
        proc.enqueue(_event(i))
    assert _wait_for(lambda: rec.total_events() == 3)
    # One full-size batch, not three singletons.
    assert len(rec.payloads) == 1
    assert len(rec.payloads[0]["batch"]) == 3
    proc.shutdown()


def test_batches_by_interval() -> None:
    rec = _Recorder()
    proc = BatchProcessor(_cfg(flush_at=1000, flush_interval=0.05), sender=rec)
    proc.enqueue(_event(1))
    assert _wait_for(lambda: rec.total_events() == 1)
    proc.shutdown()


def test_overflow_drops_without_raising() -> None:
    release = threading.Event()

    def blocking_sender(payload: dict[str, Any]) -> None:
        release.wait(2.0)

    proc = BatchProcessor(_cfg(flush_at=1, max_queue=2), sender=blocking_sender)
    proc.enqueue(_event(0))  # worker picks this up and blocks in the sender
    time.sleep(0.05)
    # Queue capacity is 2; flooding it must never raise.
    for i in range(1, 100):
        proc.enqueue(_event(i))
    release.set()
    proc.shutdown()


def test_send_failure_never_raises() -> None:
    def boom(payload: dict[str, Any]) -> None:
        raise RuntimeError("sender exploded")

    proc = BatchProcessor(_cfg(flush_at=1), sender=boom)
    proc.enqueue(_event(0))
    proc.flush(timeout=1.0)  # must not raise
    proc.shutdown()


def test_envelope_shape_is_versioned() -> None:
    rec = _Recorder()
    proc = BatchProcessor(_cfg(flush_at=1), sender=rec)
    proc.enqueue(_event(0))
    assert _wait_for(lambda: len(rec.payloads) == 1)
    payload = rec.payloads[0]
    assert payload["schema_version"] == 1
    assert payload["sdk"]["name"] == "ratel-ai-python"
    proc.shutdown()


# -- HTTP transport (_post), driven synchronously via pytest-httpx ----------


def test_post_retries_on_5xx_then_succeeds(httpx_mock: Any) -> None:
    httpx_mock.add_response(status_code=500)
    httpx_mock.add_response(status_code=200)
    proc = BatchProcessor(_cfg())
    proc._post({"schema_version": 1, "sdk": {"version": "0.0.0"}, "batch": []})
    assert len(httpx_mock.get_requests()) == 2


def test_post_drops_on_4xx_without_retry(httpx_mock: Any) -> None:
    httpx_mock.add_response(status_code=401)
    proc = BatchProcessor(_cfg())
    proc._post({"schema_version": 1, "sdk": {"version": "0.0.0"}, "batch": []})
    assert len(httpx_mock.get_requests()) == 1  # no retry on client error


def test_post_sends_bearer_auth(httpx_mock: Any) -> None:
    httpx_mock.add_response(status_code=200)
    proc = BatchProcessor(_cfg(api_key="rk-secret"))
    proc._post({"schema_version": 1, "sdk": {"version": "0.0.0"}, "batch": []})
    request = httpx_mock.get_requests()[0]
    assert request.headers["Authorization"] == "Bearer rk-secret"


def test_post_never_raises_when_network_down(httpx_mock: Any) -> None:
    for _ in range(3):
        httpx_mock.add_exception(httpx.ConnectError("connection refused"))
    proc = BatchProcessor(_cfg())
    # Must swallow the network error entirely.
    proc._post({"schema_version": 1, "sdk": {"version": "0.0.0"}, "batch": []})


@pytest.mark.parametrize("status", [200, 204])
def test_post_treats_2xx_as_success(httpx_mock: Any, status: int) -> None:
    httpx_mock.add_response(status_code=status)
    proc = BatchProcessor(_cfg())
    proc._post({"schema_version": 1, "sdk": {"version": "0.0.0"}, "batch": []})
    assert len(httpx_mock.get_requests()) == 1
