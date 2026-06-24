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
from .selection import ToolAdapter, ToolSelection

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


# --- Tool selection adapter (ADR-0015): Anthropic messages tool shape. ---


def _tool_descriptor(tool: Any) -> tuple[str, str, dict[str, Any]] | None:
    if not isinstance(tool, dict):
        return None
    name = tool.get("name")
    if not isinstance(name, str) or not name:
        return None
    schema = tool.get("input_schema")
    return (name, tool.get("description") or "", schema if isinstance(schema, dict) else {})


def _forced_names(kwargs: dict[str, Any]) -> list[str]:
    choice = kwargs.get("tool_choice")
    if (
        isinstance(choice, dict)
        and choice.get("type") == "tool"
        and isinstance(choice.get("name"), str)
    ):
        return [choice["name"]]
    return []


def _tool_calls(response: Any) -> list[str] | None:
    try:
        content = getattr(response, "content", None)
        if not content:
            return None
        names: list[str] = []
        for block in content:
            block_type = getattr(block, "type", None)
            if block_type is None and isinstance(block, dict):
                block_type = block.get("type")
            if block_type == "tool_use":
                name = getattr(block, "name", None)
                if name is None and isinstance(block, dict):
                    name = block.get("name")
                if name:
                    names.append(name)
        return names or None
    except Exception:
        return None


ANTHROPIC_TOOLS = ToolAdapter(
    get_tools=lambda kw: kw.get("tools"),
    with_tools=lambda kw, tools: {**kw, "tools": tools},
    descriptor=_tool_descriptor,
    forced_names=_forced_names,
    tool_calls_of=_tool_calls,
)


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
    tool_adapter=ANTHROPIC_TOOLS,
)


def wrap_anthropic(client: Any, *, select_tools: bool | ToolSelection | None = None) -> Any:
    """Trace `client.messages.create` in place; returns the client.

    Pass `select_tools=True` (or a `ToolSelection`) to also transparently
    BM25-prune the `tools` array to the top-K per call (ADR-0015)."""
    selection = ToolSelection.resolve(select_tools)
    try:
        messages = client.messages
        if not patch_method(messages, "create", ANTHROPIC_SPEC, selection):
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


def Anthropic(*args: Any, select_tools: bool | ToolSelection | None = None, **kwargs: Any) -> Any:
    """Construct a traced Anthropic client (drop-in for `anthropic.Anthropic`)."""
    return wrap_anthropic(_load().Anthropic(*args, **kwargs), select_tools=select_tools)


def AsyncAnthropic(
    *args: Any, select_tools: bool | ToolSelection | None = None, **kwargs: Any
) -> Any:
    """Construct a traced AsyncAnthropic client (drop-in for `anthropic.AsyncAnthropic`)."""
    return wrap_anthropic(_load().AsyncAnthropic(*args, **kwargs), select_tools=select_tools)
