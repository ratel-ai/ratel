"""Observability & analytics for Ratel — Langfuse-style tracing that ships to
Ratel's cloud (ADR-0013).

Quick start:

    from ratel_ai import observe, get_client

    @observe()
    def handle(task: str) -> str:
        ...

    get_client().update_current_trace(user_id="u1", session_id="s1")
    get_client().flush()

Drop-in provider wrappers live at `ratel_ai.openai` / `ratel_ai.anthropic`.
Configuration is read from the environment (`RATEL_API_KEY`, `RATEL_HOST`, …);
absent a key, the client runs in no-op mode and never raises.
"""

from __future__ import annotations

from ._emit import CaptureExporter, Exporter, NoopExporter
from .client import (
    RatelClient,
    configure,
    get_client,
    set_global_client,
)
from .config import ObservabilityConfig
from .decorator import observe
from .trace import Observation, Trace

__all__ = [
    "CaptureExporter",
    "Exporter",
    "NoopExporter",
    "Observation",
    "ObservabilityConfig",
    "RatelClient",
    "Trace",
    "configure",
    "get_client",
    "observe",
    "set_global_client",
]
