"""Emission plumbing shared by the client and handles.

Two independent destinations (ADR-0013):
  * the **cloud exporter** — receives the rich `models.py` wire payloads;
  * the **core recorder** — optionally mirrors coarse identity/usage events into
    the local `ratel-ai-core` trace stream (ADR-0009) for `ratel inspect`.

Both are best-effort: a failure here must never propagate into customer code.
"""

from __future__ import annotations

import logging
from typing import Any, Protocol, runtime_checkable

logger = logging.getLogger("ratel_ai.observability")


@runtime_checkable
class Exporter(Protocol):
    """Sink for cloud-bound wire events."""

    def enqueue(self, event: dict[str, Any]) -> None: ...

    def flush(self, timeout: float | None = None) -> None: ...

    def shutdown(self) -> None: ...


class NoopExporter:
    """Drops everything — used in no-op mode (no API key / disabled)."""

    def enqueue(self, event: dict[str, Any]) -> None:  # noqa: D102
        return None

    def flush(self, timeout: float | None = None) -> None:  # noqa: D102
        return None

    def shutdown(self) -> None:  # noqa: D102
        return None


class CaptureExporter:
    """Collects enqueued events in memory. For tests and local inspection —
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


class CoreRecorder:
    """Mirrors coarse trace events into a `ratel-ai-core` registry's sink.

    Wraps anything exposing `record_event(dict)` (the native `ToolRegistry`, or a
    `ToolCatalog`). When no recorder is bound, recording is a no-op — the cloud
    exporter is then the only destination.
    """

    def __init__(self, recorder: Any | None = None) -> None:
        self._recorder = recorder

    @property
    def active(self) -> bool:
        return self._recorder is not None

    def record(self, event: dict[str, Any]) -> None:
        if self._recorder is None:
            return
        try:
            self._recorder.record_event(event)
        except Exception as exc:  # never break the caller over a trace event
            logger.debug("ratel: core trace event dropped: %s", exc)
