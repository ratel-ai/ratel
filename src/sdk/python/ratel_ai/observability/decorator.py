"""The `@observe` decorator — wrap any sync or async function into a trace node.

Captures the call's inputs, output, timing, and exceptions, and nests under
whatever observation is currently active (so a call tree becomes a trace tree).
Observability failures never affect the wrapped function: if anything here
breaks, the function still runs and returns normally.
"""

from __future__ import annotations

import functools
import inspect
from typing import Any, Callable

from .client import RatelClient, get_client
from .models import OBSERVATION_SPAN
from .trace import Observation

_UNSET: Any = object()


def _safe_get_client() -> RatelClient | None:
    try:
        return get_client()
    except Exception:
        return None


def _fn_name(fn: Callable[..., Any]) -> str:
    qualname = getattr(fn, "__qualname__", None) or getattr(fn, "__name__", None)
    return qualname if isinstance(qualname, str) else "observed"


def _bind_input(fn: Callable[..., Any], args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
    """Best-effort mapping of call args to parameter names; never raises."""
    try:
        bound = inspect.signature(fn).bind_partial(*args, **kwargs)
        bound.apply_defaults()
        data = dict(bound.arguments)
        data.pop("self", None)
        data.pop("cls", None)
        return data
    except Exception:
        return {"args": list(args), "kwargs": dict(kwargs)}


def _safe_start(
    client: RatelClient | None,
    name: str,
    kind: str,
    input_value: Any,
    capture_input: bool | None,
    capture_output: bool | None,
) -> Observation | None:
    if client is None:
        return None
    try:
        return client.start_observation(
            name,
            kind=kind,
            input=input_value,
            capture_input=capture_input,
            capture_output=capture_output,
        )
    except Exception:
        return None


def _safe_end(
    obs: Observation | None, *, output: Any = _UNSET, error: BaseException | None = None
) -> None:
    if obs is None:
        return
    try:
        obs.end(output=output, error=error)
    except Exception:
        pass


def observe(
    func: Callable[..., Any] | None = None,
    *,
    name: str | None = None,
    as_type: str = OBSERVATION_SPAN,
    capture_input: bool | None = None,
    capture_output: bool | None = None,
) -> Any:
    """Decorate a function so each call becomes an observation.

    Usable bare (`@observe`) or parameterized (`@observe(name=..., as_type=...)`).
    `as_type` is one of "span" | "generation" | "event".
    """

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        obs_name: str = name or _fn_name(fn)

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                client = _safe_get_client()
                obs = _safe_start(
                    client,
                    obs_name,
                    as_type,
                    _bind_input(fn, args, kwargs),
                    capture_input,
                    capture_output,
                )
                try:
                    result = await fn(*args, **kwargs)
                except BaseException as exc:
                    _safe_end(obs, error=exc if isinstance(exc, Exception) else None)
                    raise
                _safe_end(obs, output=result)
                return result

            return async_wrapper

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            client = _safe_get_client()
            obs = _safe_start(
                client,
                obs_name,
                as_type,
                _bind_input(fn, args, kwargs),
                capture_input,
                capture_output,
            )
            try:
                result = fn(*args, **kwargs)
            except BaseException as exc:
                _safe_end(obs, error=exc if isinstance(exc, Exception) else None)
                raise
            _safe_end(obs, output=result)
            return result

        return sync_wrapper

    if func is not None and callable(func):
        return decorate(func)
    return decorate
