"""Runtime handles for traces and observations.

A `Trace` is the root; an `Observation` is a span, generation, or event within
it. Handles are thin: they hold pending data and delegate emission to the
`RatelClient` that created them (kept loosely coupled to avoid an import cycle).
Every public method swallows its own errors — observability must never break the
wrapped work.
"""

from __future__ import annotations

import time
from contextvars import Token
from typing import TYPE_CHECKING, Any

from .context import reset_observation
from .models import OBSERVATION_GENERATION, OBSERVATION_SPAN, STATUS_ERROR, STATUS_OK

if TYPE_CHECKING:
    from .client import RatelClient

# Sentinel distinguishing "argument omitted" from an explicit `None`.
_UNSET: Any = object()

# Cap on the error string shipped to the cloud as status_message.
_MAX_STATUS_MESSAGE = 500


class Observation:
    """A span / generation / event node. Use via the client's context managers
    or `@observe`; call `update()` to attach data and `end()` to close it."""

    def __init__(
        self,
        *,
        client: RatelClient,
        trace_id: str,
        observation_id: str,
        parent_observation_id: str | None,
        name: str,
        kind: str,
        start_ms: int,
        start_perf: float,
        capture_input: bool,
        capture_output: bool,
        input_value: Any,
        token: Token[str | None],
        sampled: bool = True,
    ) -> None:
        self._client = client
        self.trace_id = trace_id
        self.observation_id = observation_id
        self.parent_observation_id = parent_observation_id
        self.name = name
        self.kind = kind
        self.start_ms = start_ms
        self._start_perf = start_perf
        self.capture_input = capture_input
        self.capture_output = capture_output
        self.input_value = input_value
        self._token = token
        # Whether this observation's trace was sampled (decided at open time, so
        # close-time emission doesn't depend on the current contextvar).
        self.sampled = sampled
        self._ended = False

        # Generation-specific, set via update().
        self.output_value: Any = _UNSET
        self.status: str = STATUS_OK
        self.status_message: str | None = None
        self.level: str = "default"
        self.metadata: dict[str, Any] = {}
        self.provider: str | None = None
        self.model: str | None = None
        self.usage: dict[str, Any] | None = None
        self.request_params: dict[str, Any] | None = None
        self.response_model: str | None = None
        self.finish_reasons: list[str] | None = None

    @property
    def is_generation(self) -> bool:
        return self.kind == OBSERVATION_GENERATION

    def update(
        self,
        *,
        output: Any = _UNSET,
        input: Any = _UNSET,
        metadata: dict[str, Any] | None = None,
        level: str | None = None,
        status: str | None = None,
        status_message: str | None = None,
        model: str | None = None,
        provider: str | None = None,
        usage: dict[str, Any] | None = None,
        request_params: dict[str, Any] | None = None,
        response_model: str | None = None,
        finish_reasons: list[str] | None = None,
    ) -> Observation:
        """Attach data to an open observation. Returns self for chaining."""
        try:
            if output is not _UNSET:
                self.output_value = output
            if input is not _UNSET:
                self.input_value = input
            if metadata:
                self.metadata.update(metadata)
            if level is not None:
                self.level = level
            if status is not None:
                self.status = status
            if status_message is not None:
                self.status_message = status_message
            if model is not None:
                self.model = model
            if provider is not None:
                self.provider = provider
            if usage is not None:
                self.usage = usage
            if request_params is not None:
                self.request_params = request_params
            if response_model is not None:
                self.response_model = response_model
            if finish_reasons is not None:
                self.finish_reasons = finish_reasons
        except Exception:
            pass
        return self

    def end(
        self,
        *,
        output: Any = _UNSET,
        status: str | None = None,
        error: BaseException | str | None = None,
    ) -> None:
        """Close the observation: emit its events and pop it off the context."""
        if self._ended:
            return
        self._ended = True
        try:
            if output is not _UNSET:
                self.output_value = output
            if error is not None:
                self.status = STATUS_ERROR
                raw = error if isinstance(error, str) else str(error)
                # Provider exception text can echo back request bodies / partial
                # credentials — bound what we ship to the cloud (ADR-0013).
                self.status_message = raw[:_MAX_STATUS_MESSAGE]
            if status is not None:
                self.status = status
            self._client._finish_observation(self)
        except Exception:
            pass
        finally:
            reset_observation(self._token)

    @property
    def took_ms(self) -> int:
        return int((time.perf_counter() - self._start_perf) * 1000)

    def __enter__(self) -> Observation:
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if exc is not None:
            self.end(error=exc)
        else:
            self.end()


class _NullObservation(Observation):
    """A no-op observation yielded when opening a real one fails, so user code
    using `with client.start_as_current_span(...) as obs: obs.update(...)` keeps
    working as a silent no-op instead of raising. Never breaks the caller."""

    def __init__(self) -> None:
        # Deliberately skips Observation.__init__ — there's nothing to track.
        self.observation_id = ""
        self.trace_id = ""
        self.parent_observation_id = None
        self.name = ""
        self.kind = OBSERVATION_SPAN
        self.sampled = False
        self._ended = True

    def update(self, **kwargs: Any) -> Observation:
        return self

    def end(self, **kwargs: Any) -> None:
        return None


NULL_OBSERVATION: Observation = _NullObservation()


class Trace:
    """Handle to the current trace root. Lets callers set trace-level
    attributes (user_id, session_id, tags, metadata, version)."""

    def __init__(self, client: RatelClient, trace_id: str) -> None:
        self._client = client
        self.trace_id = trace_id

    def update(
        self,
        *,
        name: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        version: str | None = None,
    ) -> Trace:
        self._client.update_current_trace(
            name=name,
            user_id=user_id,
            session_id=session_id,
            tags=tags,
            metadata=metadata,
            version=version,
        )
        return self


__all__ = ["NULL_OBSERVATION", "Observation", "Trace"]
