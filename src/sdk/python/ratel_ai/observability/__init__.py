"""Lean cloud analytics for Ratel — usage rollups shipped to Ratel's cloud (ADR-0013).

One `track()` call per agent interaction reports its token spend (broken down by
context source), what Ratel selection saved, and what it *could* save. The
payload is the exact shape `POST /api/v1/events` accepts and the dashboard reads.

Quick start:

    from ratel_ai import get_client

    get_client().track(
        tokens_by_category={"skills": 120, "tools": 2000, "history": 3400,
                            "memory": 260, "user_input": 340},
        saved_by_category={"tools": 7200},
        model="claude-sonnet-4-6",
        output_tokens=180,
    )
    get_client().flush()  # also auto-flushed at exit

Absent a key (`RATEL_API_KEY`), the client is a no-op and never raises.
"""

from __future__ import annotations

from ._emit import CaptureExporter, Exporter, NoopExporter
from .client import RatelClient, configure, get_client, set_global_client
from .config import ObservabilityConfig
from .rollup import CONTEXT_SOURCES, build_rollup, normalize_sources

__all__ = [
    "CONTEXT_SOURCES",
    "CaptureExporter",
    "Exporter",
    "NoopExporter",
    "ObservabilityConfig",
    "RatelClient",
    "build_rollup",
    "configure",
    "get_client",
    "normalize_sources",
    "set_global_client",
]
