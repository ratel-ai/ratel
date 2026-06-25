"""Configuration for the observability layer — resolved from explicit kwargs
then environment, with safe defaults (see ADR-0013).

The guiding rule: absent an API key and explicit config, the client runs in
no-op mode — it captures nothing and never raises.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, replace
from typing import TypeVar

_T = TypeVar("_T")


def _coalesce(explicit: _T | None, fallback: _T) -> _T:
    """Explicit value wins; otherwise fall back (to env-derived or default)."""
    return explicit if explicit is not None else fallback

DEFAULT_HOST = "https://cloud.ratel.sh"
DEFAULT_FLUSH_AT = 50
DEFAULT_FLUSH_INTERVAL = 1.0
DEFAULT_MAX_QUEUE = 10_000
DEFAULT_TIMEOUT = 5.0
DEFAULT_SAMPLE_RATE = 1.0

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


def _env_bool(name: str, default: bool | None) -> bool | None:
    raw = os.environ.get(name)
    if raw is None:
        return default
    lowered = raw.strip().lower()
    if lowered in _TRUE:
        return True
    if lowered in _FALSE:
        return False
    return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass(frozen=True, repr=False)
class ObservabilityConfig:
    """Immutable, fully-resolved configuration for a `RatelClient`."""

    api_key: str | None = None
    host: str = DEFAULT_HOST
    enabled: bool = False
    capture_input: bool = True
    capture_output: bool = True
    flush_at: int = DEFAULT_FLUSH_AT
    flush_interval: float = DEFAULT_FLUSH_INTERVAL
    max_queue: int = DEFAULT_MAX_QUEUE
    timeout: float = DEFAULT_TIMEOUT
    sample_rate: float = DEFAULT_SAMPLE_RATE
    release: str | None = None
    debug: bool = False

    @classmethod
    def resolve(
        cls,
        *,
        api_key: str | None = None,
        host: str | None = None,
        enabled: bool | None = None,
        capture_input: bool | None = None,
        capture_output: bool | None = None,
        flush_at: int | None = None,
        flush_interval: float | None = None,
        max_queue: int | None = None,
        timeout: float | None = None,
        sample_rate: float | None = None,
        release: str | None = None,
        debug: bool | None = None,
    ) -> ObservabilityConfig:
        """Build a config from explicit kwargs first, then environment, then
        defaults. `enabled` defaults to True iff an API key is present."""
        resolved_key = api_key if api_key is not None else os.environ.get("RATEL_API_KEY")
        resolved_host = host or os.environ.get("RATEL_HOST") or DEFAULT_HOST

        if enabled is None:
            enabled = _env_bool("RATEL_TRACING_ENABLED", None)
        if enabled is None:
            enabled = resolved_key is not None and resolved_key != ""

        cap_in = _coalesce(capture_input, _env_bool("RATEL_CAPTURE_INPUT", True))
        cap_out = _coalesce(capture_output, _env_bool("RATEL_CAPTURE_OUTPUT", True))
        return cls(
            api_key=resolved_key or None,
            host=resolved_host.rstrip("/"),
            enabled=bool(enabled),
            capture_input=bool(cap_in),
            capture_output=bool(cap_out),
            flush_at=_coalesce(flush_at, _env_int("RATEL_FLUSH_AT", DEFAULT_FLUSH_AT)),
            flush_interval=_coalesce(
                flush_interval, _env_float("RATEL_FLUSH_INTERVAL", DEFAULT_FLUSH_INTERVAL)
            ),
            max_queue=_coalesce(max_queue, _env_int("RATEL_MAX_QUEUE", DEFAULT_MAX_QUEUE)),
            timeout=_coalesce(timeout, _env_float("RATEL_TIMEOUT", DEFAULT_TIMEOUT)),
            sample_rate=_coalesce(
                sample_rate, _env_float("RATEL_SAMPLE_RATE", DEFAULT_SAMPLE_RATE)
            ),
            release=_coalesce(release, os.environ.get("RATEL_RELEASE")),
            debug=_coalesce(debug, bool(_env_bool("RATEL_DEBUG", False))),
        )

    @property
    def can_export(self) -> bool:
        """True when the client should ship to the cloud: enabled with a key."""
        return self.enabled and bool(self.api_key)

    @property
    def events_url(self) -> str:
        """The lean analytics rollup endpoint the dashboard reads (ADR-0013)."""
        return f"{self.host}/api/v1/events"

    def __repr__(self) -> str:
        # Never echo the API key — a config (or its client) reached by a logger or
        # a traceback frame must not leak the credential.
        masked = "***" if self.api_key else None
        return (
            f"ObservabilityConfig(api_key={masked!r}, host={self.host!r}, "
            f"enabled={self.enabled})"
        )

    def with_overrides(self, **changes: object) -> ObservabilityConfig:
        return replace(self, **changes)  # type: ignore[arg-type]
