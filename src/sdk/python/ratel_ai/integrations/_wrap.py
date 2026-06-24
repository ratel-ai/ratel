"""Shared engine for the provider drop-in wrappers.

Each provider supplies a `ProviderSpec` of small extractors (how to read the
model, usage, output, finish reasons from its request/response). This module
wraps a client's `create` method so every call opens a generation observation,
runs the real call untouched, and closes the observation with provider-reported
usage — including a basic streaming path.

Tracing failures never affect the call: the original method always runs and its
result/exception is passed through unchanged.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass
from typing import Any

from ..observability.client import RatelClient, get_client
from ..observability.models import OBSERVATION_GENERATION
from ..observability.trace import Observation

_UNSET: Any = object()


@dataclass(frozen=True)
class ProviderSpec:
    """Provider-specific extractors used by the generic wrapper."""

    provider: str
    name: str
    model_of_request: Callable[[dict[str, Any]], str | None]
    input_of_request: Callable[[dict[str, Any]], Any]
    request_params: Callable[[dict[str, Any]], dict[str, Any]]
    usage_of: Callable[[Any], dict[str, Any] | None]
    output_of: Callable[[Any], Any]
    response_model_of: Callable[[Any], str | None]
    finish_reasons_of: Callable[[Any], list[str] | None]
    # Request-param keys that carry content (e.g. Anthropic's `system` prompt) —
    # dropped from the captured params when input capture is disabled.
    sensitive_params: frozenset[str] = frozenset()


def _safe_client() -> RatelClient | None:
    try:
        return get_client()
    except Exception:
        return None


def _start(spec: ProviderSpec, kwargs: dict[str, Any]) -> Observation | None:
    client = _safe_client()
    if client is None:
        return None
    try:
        obs = client.start_observation(
            spec.name,
            kind=OBSERVATION_GENERATION,
            input=spec.input_of_request(kwargs),
            model=spec.model_of_request(kwargs),
            provider=spec.provider,
        )
        params = spec.request_params(kwargs)
        if params and not obs.capture_input and spec.sensitive_params:
            # Content-bearing params (e.g. the system prompt) honor the input
            # capture toggle — don't ship them when the user opted out.
            params = {k: v for k, v in params.items() if k not in spec.sensitive_params}
        if params:
            obs.update(request_params=params)
        return obs
    except Exception:
        return None


def _finalize(obs: Observation | None, spec: ProviderSpec, response: Any) -> None:
    if obs is None:
        return
    try:
        obs.update(
            output=spec.output_of(response),
            usage=spec.usage_of(response),
            response_model=spec.response_model_of(response),
            finish_reasons=spec.finish_reasons_of(response),
        )
        obs.end()
    except Exception:
        try:
            obs.end()
        except Exception:
            pass


def _end_error(obs: Observation | None, exc: BaseException) -> None:
    if obs is None:
        return
    try:
        obs.end(error=exc if isinstance(exc, Exception) else None)
    except Exception:
        pass


class _TracedStream:
    """Proxy around a provider's sync stream. Preserves attribute access and the
    `with` protocol while capturing usage from chunks and ending the observation
    when iteration (or the context) completes."""

    def __init__(self, stream: Any, obs: Observation, spec: ProviderSpec) -> None:
        self._stream = stream
        self._obs = obs
        self._spec = spec
        self._usage: dict[str, Any] = {}

    def __iter__(self) -> Iterator[Any]:
        try:
            for chunk in self._stream:
                chunk_usage = self._spec.usage_of(chunk)
                if chunk_usage:
                    self._usage.update(chunk_usage)
                yield chunk
        finally:
            self._finish()

    def _finish(self) -> None:
        if self._usage:
            self._obs.update(usage=self._usage)
        self._obs.end()

    def __enter__(self) -> _TracedStream:
        with contextlib.suppress(Exception):
            self._stream.__enter__()
        return self

    def __exit__(self, *exc: Any) -> Any:
        try:
            return self._stream.__exit__(*exc)
        finally:
            self._finish()

    def __getattr__(self, name: str) -> Any:
        # Delegate everything else (.response, .close(), ...) to the real stream.
        return getattr(self._stream, name)


class _TracedAsyncStream:
    """Async counterpart of `_TracedStream`."""

    def __init__(self, stream: Any, obs: Observation, spec: ProviderSpec) -> None:
        self._stream = stream
        self._obs = obs
        self._spec = spec
        self._usage: dict[str, Any] = {}

    async def __aiter__(self) -> AsyncIterator[Any]:
        try:
            async for chunk in self._stream:
                chunk_usage = self._spec.usage_of(chunk)
                if chunk_usage:
                    self._usage.update(chunk_usage)
                yield chunk
        finally:
            self._finish()

    def _finish(self) -> None:
        if self._usage:
            self._obs.update(usage=self._usage)
        self._obs.end()

    async def __aenter__(self) -> _TracedAsyncStream:
        with contextlib.suppress(Exception):
            await self._stream.__aenter__()
        return self

    async def __aexit__(self, *exc: Any) -> Any:
        try:
            return await self._stream.__aexit__(*exc)
        finally:
            self._finish()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


def make_traced(
    original: Callable[..., Any], spec: ProviderSpec, *, is_async: bool
) -> Callable[..., Any]:
    """Wrap a provider `create` method with generation tracing."""

    if is_async:

        @functools.wraps(original)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            obs = _start(spec, kwargs)
            try:
                result = await original(*args, **kwargs)
            except BaseException as exc:
                _end_error(obs, exc)
                raise
            if kwargs.get("stream") and obs is not None:
                return _TracedAsyncStream(result, obs, spec)
            _finalize(obs, spec, result)
            return result

        return async_wrapper

    @functools.wraps(original)
    def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
        obs = _start(spec, kwargs)
        try:
            result = original(*args, **kwargs)
        except BaseException as exc:
            _end_error(obs, exc)
            raise
        if kwargs.get("stream") and obs is not None:
            return _TracedStream(result, obs, spec)
        _finalize(obs, spec, result)
        return result

    return sync_wrapper


def patch_method(owner: Any, attr: str, spec: ProviderSpec) -> bool:
    """Wrap `owner.attr` in place. Returns False if it couldn't be patched."""
    try:
        original = getattr(owner, attr)
    except Exception:
        return False
    if getattr(original, "__ratel_wrapped__", False):
        return True
    is_async = asyncio.iscoroutinefunction(original)
    wrapped = make_traced(original, spec, is_async=is_async)
    try:
        wrapped.__ratel_wrapped__ = True  # type: ignore[attr-defined]
        setattr(owner, attr, wrapped)
    except Exception:
        return False
    return True
