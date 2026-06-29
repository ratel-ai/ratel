"""Exporter sinks for the cloud client.

An `Exporter` is where usage rollups go on their way to the cloud: the real
`BatchProcessor` (background, batched), a `NoopExporter` (no key / disabled), or a
`CaptureExporter` (in-memory, for tests). Every implementation is best-effort: a
failure here must never propagate into customer code.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class Exporter(Protocol):
    """Sink for cloud-bound rollups."""

    def enqueue(self, event: dict[str, Any]) -> None: ...

    def flush(self, timeout: float | None = None) -> None: ...

    def shutdown(self) -> None: ...


class NoopExporter:
    """Drops everything — used in no-op mode (no API key / disabled)."""

    def enqueue(self, event: dict[str, Any]) -> None:
        return None

    def flush(self, timeout: float | None = None) -> None:
        return None

    def shutdown(self) -> None:
        return None


class CaptureExporter:
    """Collects enqueued rollups in memory. For tests and local inspection —
    fully synchronous, no threads, no network."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.flushed = 0

    def enqueue(self, event: dict[str, Any]) -> None:
        self.events.append(event)

    def flush(self, timeout: float | None = None) -> None:
        self.flushed += 1

    def shutdown(self) -> None:
        return None
