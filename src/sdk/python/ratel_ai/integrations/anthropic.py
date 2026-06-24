"""Anthropic drop-in tracing.

    from ratel_ai.anthropic import Anthropic

    client = Anthropic()                    # same surface as `from anthropic import Anthropic`
    client.messages.create(...)             # auto-traced: model, prompt, output, usage

`anthropic` is *not* a dependency of `ratel-ai`; it is imported lazily and a
clear hint is raised if absent. `wrap_anthropic(existing_client)` traces a
client you already constructed.
"""

from __future__ import annotations

import logging
from typing import Any

from ._wrap import ProviderSpec, patch_method

logger = logging.getLogger("ratel_ai.observability")

_REQUEST_PARAM_KEYS = (
    "temperature",
    "top_p",
    "top_k",
    "max_tokens",
    "stop_sequences",
    "system",
    "tool_choice",
)


def _request_params(kwargs: dict[str, Any]) -> dict[str, Any]:
    return {k: kwargs[k] for k in _REQUEST_PARAM_KEYS if k in kwargs}


def _usage(response: Any) -> dict[str, Any] | None:
    usage = getattr(response, "usage", None)
    if usage is None:
        return None
    out: dict[str, Any] = {}
    inp = getattr(usage, "input_tokens", None)
    out_tokens = getattr(usage, "output_tokens", None)
    if inp is not None:
        out["input_tokens"] = inp
    if out_tokens is not None:
        out["output_tokens"] = out_tokens
    if inp is not None and out_tokens is not None:
        out["total_tokens"] = inp + out_tokens
    return out or None


def _finish_reasons(response: Any) -> list[str] | None:
    stop = getattr(response, "stop_reason", None)
    return [stop] if stop else None


ANTHROPIC_SPEC = ProviderSpec(
    provider="anthropic",
    name="anthropic.messages",
    model_of_request=lambda kw: kw.get("model"),
    input_of_request=lambda kw: kw.get("messages"),
    request_params=_request_params,
    usage_of=_usage,
    output_of=lambda resp: getattr(resp, "content", resp),
    response_model_of=lambda resp: getattr(resp, "model", None),
    finish_reasons_of=_finish_reasons,
    # The system prompt is content — suppress it when input capture is off.
    sensitive_params=frozenset({"system"}),
)


def wrap_anthropic(client: Any) -> Any:
    """Trace `client.messages.create` in place; returns the client."""
    try:
        messages = client.messages
        if not patch_method(messages, "create", ANTHROPIC_SPEC):
            logger.debug("ratel: could not patch anthropic client; tracing disabled for it")
    except Exception as exc:
        logger.debug("ratel: wrap_anthropic failed (%s); returning client untouched", exc)
    return client


def _load() -> Any:
    try:
        import anthropic
    except ImportError as exc:  # pragma: no cover - exercised via a stubbed import in tests
        raise ImportError(
            "ratel_ai.anthropic requires the 'anthropic' package. Install it with: "
            "pip install anthropic"
        ) from exc
    return anthropic


def Anthropic(*args: Any, **kwargs: Any) -> Any:
    """Construct a traced Anthropic client (drop-in for `anthropic.Anthropic`)."""
    return wrap_anthropic(_load().Anthropic(*args, **kwargs))


def AsyncAnthropic(*args: Any, **kwargs: Any) -> Any:
    """Construct a traced AsyncAnthropic client (drop-in for `anthropic.AsyncAnthropic`)."""
    return wrap_anthropic(_load().AsyncAnthropic(*args, **kwargs))
