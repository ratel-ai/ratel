"""`RatelClient` — the entry point for observability.

Owns the config, the cloud exporter, and the optional core-stream recorder, and
is the single place observations are opened and finished. A process-wide
singleton (`get_client()`) backs the `@observe` decorator and the provider
wrappers; explicit construction is for advanced/multi-tenant use.

Hard rule (ADR-0012): nothing here may raise into customer code. Every emission
path is wrapped; on any internal failure the wrapped work proceeds untouched.
"""

from __future__ import annotations

import atexit
import contextlib
import logging
import random
import threading
import time
from collections.abc import Iterator
from typing import Any

from . import context as ctx
from ._emit import CoreRecorder, Exporter, NoopExporter
from .config import ObservabilityConfig
from .context import TraceContext
from .models import (
    OBSERVATION_EVENT,
    OBSERVATION_GENERATION,
    OBSERVATION_SPAN,
    ObservationCreate,
    TraceCreate,
    build_batch,
    capture_field,
    gen_ai_block,
    usage_block,
)
from .trace import NULL_OBSERVATION, Observation, Trace

logger = logging.getLogger("ratel_ai.observability")

_UNSET: Any = object()


class RatelClient:
    """Captures traces/observations and ships them to Ratel's cloud."""

    def __init__(
        self,
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
        exporter: Exporter | None = None,
        core_recorder: Any | None = None,
    ) -> None:
        self.config = ObservabilityConfig.resolve(
            api_key=api_key,
            host=host,
            enabled=enabled,
            capture_input=capture_input,
            capture_output=capture_output,
            flush_at=flush_at,
            flush_interval=flush_interval,
            max_queue=max_queue,
            timeout=timeout,
            sample_rate=sample_rate,
            release=release,
            debug=debug,
        )
        if self.config.debug:
            logging.getLogger("ratel_ai.observability").setLevel(logging.DEBUG)
        if self.config.can_export and self.config.host.startswith("http://"):
            logger.warning(
                "ratel: RATEL_HOST uses a non-TLS scheme (http://) — the API key "
                "and trace payloads will be sent unencrypted"
            )
        self._exporter: Exporter = exporter if exporter is not None else self._build_exporter()
        self._core = (
            core_recorder
            if isinstance(core_recorder, CoreRecorder)
            else CoreRecorder(core_recorder)
        )
        self._register_atexit()

    # -- construction helpers ------------------------------------------------

    def _build_exporter(self) -> Exporter:
        if not self.config.can_export:
            return NoopExporter()
        try:
            from .exporter import BatchProcessor

            return BatchProcessor(self.config)
        except Exception as exc:  # missing httpx, etc. — degrade, never crash
            logger.warning("ratel: exporter unavailable (%s); running in no-op mode", exc)
            return NoopExporter()

    def _register_atexit(self) -> None:
        with contextlib.suppress(Exception):
            atexit.register(self.flush)

    def bind_core_recorder(self, recorder: Any) -> None:
        """Point coarse core-stream events at a `ratel-ai-core` registry/catalog
        (anything with `record_event(dict)`). Used by `ToolCatalog(observe=...)`."""
        self._core = CoreRecorder(recorder)

    # -- trace lifecycle -----------------------------------------------------

    def _new_trace(self, name: str | None = None) -> TraceContext:
        sampled = self.config.sample_rate >= 1.0 or random.random() < self.config.sample_rate
        trace = TraceContext(trace_id=ctx.new_trace_id(), name=name, sampled=sampled)
        ctx.set_current_trace(trace)
        self._emit_trace(trace)
        return trace

    def _ensure_trace(self) -> TraceContext:
        existing = ctx.current_trace()
        if existing is not None:
            return existing
        return self._new_trace()

    def trace(self, name: str | None = None, **attrs: Any) -> Trace:
        """Start a fresh root trace in the current context and return a handle."""
        trace = self._new_trace(name=name)
        if attrs:
            self.update_current_trace(**attrs)
        return Trace(self, trace.trace_id)

    def update_current_trace(
        self,
        *,
        name: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        version: str | None = None,
    ) -> None:
        """Upsert trace-level attributes on the current (or a new) trace."""
        try:
            trace = self._ensure_trace()
            if name is not None:
                trace.name = name
            if user_id is not None:
                trace.user_id = user_id
            if session_id is not None:
                trace.session_id = session_id
            if version is not None:
                trace.version = version
            if tags:
                trace.tags = list(dict.fromkeys([*trace.tags, *tags]))
            if metadata:
                trace.metadata.update(metadata)
            self._emit_trace(trace)
        except Exception:
            pass

    def _emit_trace(self, trace: TraceContext) -> None:
        if not trace.sampled:
            return
        event = TraceCreate(
            id=ctx.new_event_id(),
            trace_id=trace.trace_id,
            timestamp=ctx.now_ms(),
            name=trace.name,
            session_id=trace.session_id,
            user_id=trace.user_id,
            tags=list(trace.tags),
            version=trace.version,
            metadata=dict(trace.metadata),
            release=self.config.release,
        )
        self._enqueue(event.to_wire())
        # user_id is intentionally NOT mirrored into the core stream — it's PII and
        # the core's on-disk JSONL must stay PII-free (ADR-0012). It rides the
        # cloud TraceCreate above only.
        self._core.record(
            {
                "type": "trace_root",
                "trace_id": trace.trace_id,
                "name": trace.name or "",
                "tags": list(trace.tags),
                "version": trace.version,
            }
        )

    # -- observation lifecycle ----------------------------------------------

    def start_observation(
        self,
        name: str,
        *,
        kind: str = OBSERVATION_SPAN,
        input: Any = _UNSET,
        capture_input: bool | None = None,
        capture_output: bool | None = None,
        metadata: dict[str, Any] | None = None,
        model: str | None = None,
        provider: str | None = None,
    ) -> Observation:
        """Open an observation as the current node. Caller must `end()` it."""
        trace = self._ensure_trace()
        parent = ctx.current_observation_id()
        observation_id = ctx.new_observation_id()
        token = ctx.push_observation(observation_id)
        obs = Observation(
            client=self,
            trace_id=trace.trace_id,
            observation_id=observation_id,
            parent_observation_id=parent,
            name=name,
            kind=kind,
            start_ms=ctx.now_ms(),
            start_perf=time.perf_counter(),
            capture_input=self.config.capture_input if capture_input is None else capture_input,
            capture_output=self.config.capture_output if capture_output is None else capture_output,
            input_value=input,
            token=token,
            sampled=trace.sampled,
        )
        if metadata:
            obs.metadata.update(metadata)
        if model is not None:
            obs.model = model
        if provider is not None:
            obs.provider = provider
        if trace.sampled:
            self._core.record(
                {
                    "type": "observation_start",
                    "trace_id": trace.trace_id,
                    "observation_id": observation_id,
                    "parent_observation_id": parent,
                    "name": name,
                    "kind": kind,
                }
            )
        return obs

    def _finish_observation(self, obs: Observation) -> None:
        # Use the sampling decision captured at open time, not the current
        # contextvar — the observation may close in a different context.
        if not obs.sampled:
            return
        end_ms = ctx.now_ms()
        took = obs.took_ms

        input_field = (
            capture_field(obs.input_value, obs.capture_input)
            if obs.input_value is not _UNSET
            else None
        )
        output_field = (
            capture_field(obs.output_value, obs.capture_output)
            if obs.output_value is not _UNSET
            else None
        )
        gen_ai = None
        if obs.is_generation and (obs.model or obs.usage or obs.provider):
            gen_ai = gen_ai_block(
                system=obs.provider or "unknown",
                request_model=obs.model or "unknown",
                response_model=obs.response_model,
                request_params=obs.request_params,
                finish_reasons=obs.finish_reasons,
                usage=obs.usage,
            )

        event = ObservationCreate(
            id=ctx.new_event_id(),
            trace_id=obs.trace_id,
            observation_id=obs.observation_id,
            parent_observation_id=obs.parent_observation_id,
            observation_type=obs.kind,
            timestamp=end_ms,
            name=obs.name,
            start_time=obs.start_ms,
            end_time=end_ms,
            status=obs.status,
            status_message=obs.status_message,
            level=obs.level,
            input=input_field,
            output=output_field,
            metadata=dict(obs.metadata),
            gen_ai=gen_ai,
        )
        self._enqueue(event.to_wire())

        self._core.record(
            {
                "type": "observation_end",
                "trace_id": obs.trace_id,
                "observation_id": obs.observation_id,
                "took_ms": took,
                "status": obs.status,
                "error": obs.status_message,
            }
        )
        if obs.is_generation:
            normalized = usage_block(obs.usage) or {}
            self._core.record(
                {
                    "type": "generation",
                    "trace_id": obs.trace_id,
                    "observation_id": obs.observation_id,
                    "parent_observation_id": obs.parent_observation_id,
                    "provider": obs.provider or "unknown",
                    "model": obs.model or "unknown",
                    "input_tokens": normalized.get("input_tokens"),
                    "output_tokens": normalized.get("output_tokens"),
                    "total_tokens": normalized.get("total_tokens"),
                }
            )

    # -- context-manager sugar ----------------------------------------------

    @contextlib.contextmanager
    def start_as_current_span(
        self,
        name: str,
        *,
        input: Any = _UNSET,
        metadata: dict[str, Any] | None = None,
        capture_input: bool | None = None,
        capture_output: bool | None = None,
    ) -> Iterator[Observation]:
        try:
            obs = self.start_observation(
                name,
                kind=OBSERVATION_SPAN,
                input=input,
                metadata=metadata,
                capture_input=capture_input,
                capture_output=capture_output,
            )
        except Exception:  # opening a span must never break the caller's `with`
            obs = NULL_OBSERVATION
        try:
            yield obs
        except Exception as exc:
            obs.end(error=exc)
            raise
        else:
            obs.end()

    @contextlib.contextmanager
    def start_as_current_generation(
        self,
        name: str,
        *,
        model: str | None = None,
        provider: str | None = None,
        input: Any = _UNSET,
        metadata: dict[str, Any] | None = None,
        capture_input: bool | None = None,
        capture_output: bool | None = None,
    ) -> Iterator[Observation]:
        try:
            obs = self.start_observation(
                name,
                kind=OBSERVATION_GENERATION,
                input=input,
                metadata=metadata,
                model=model,
                provider=provider,
                capture_input=capture_input,
                capture_output=capture_output,
            )
        except Exception:  # opening a generation must never break the caller's `with`
            obs = NULL_OBSERVATION
        try:
            yield obs
        except Exception as exc:
            obs.end(error=exc)
            raise
        else:
            obs.end()

    def event(
        self, name: str, *, metadata: dict[str, Any] | None = None, input: Any = _UNSET
    ) -> None:
        """Record a point-in-time event observation (opens and closes at once)."""
        try:
            obs = self.start_observation(
                name, kind=OBSERVATION_EVENT, input=input, metadata=metadata
            )
            obs.end()
        except Exception:
            pass

    # -- lifecycle -----------------------------------------------------------

    def _enqueue(self, event: dict[str, Any]) -> None:
        try:
            self._exporter.enqueue(event)
        except Exception as exc:
            logger.debug("ratel: cloud event dropped: %s", exc)

    def flush(self, timeout: float | None = None) -> None:
        with contextlib.suppress(Exception):
            self._exporter.flush(timeout)

    def shutdown(self) -> None:
        with contextlib.suppress(Exception):
            self._exporter.shutdown()


_singleton_lock = threading.Lock()
_singleton: RatelClient | None = None


def get_client() -> RatelClient:
    """Return the process-wide client, creating it from the environment once."""
    global _singleton
    if _singleton is None:
        with _singleton_lock:
            if _singleton is None:
                _singleton = RatelClient()
    return _singleton


def configure(**kwargs: Any) -> RatelClient:
    """Replace the process-wide client with one built from `kwargs`.

    The previous client is shut down so its background exporter thread and HTTP
    connection don't leak (e.g. when rotating the API key or host mid-process).
    """
    global _singleton
    with _singleton_lock:
        old = _singleton
        _singleton = RatelClient(**kwargs)
    if old is not None:
        old.shutdown()
    return _singleton


def set_global_client(client: RatelClient | None) -> None:
    """Install (or clear) the process-wide client. Primarily for tests."""
    global _singleton
    with _singleton_lock:
        _singleton = client


def build_envelope(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Public re-export of the batch envelope builder (for the exporter/tests)."""
    return build_batch(events)
