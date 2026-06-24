"""OpenAI drop-in tracing.

    from ratel_ai.openai import OpenAI

    client = OpenAI()                       # same surface as `from openai import OpenAI`
    client.chat.completions.create(...)     # auto-traced: model, prompt, output, usage

`openai` is *not* a dependency of `ratel-ai`; it is imported lazily and a clear
hint is raised if absent. `wrap_openai(existing_client)` traces a client you
already constructed.
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
    "max_tokens",
    "max_completion_tokens",
    "n",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "tool_choice",
    "response_format",
)


def _request_params(kwargs: dict[str, Any]) -> dict[str, Any]:
    return {k: kwargs[k] for k in _REQUEST_PARAM_KEYS if k in kwargs}


def _usage(response: Any) -> dict[str, Any] | None:
    usage = getattr(response, "usage", None)
    if usage is None:
        return None
    out: dict[str, Any] = {}
    prompt = getattr(usage, "prompt_tokens", None)
    completion = getattr(usage, "completion_tokens", None)
    total = getattr(usage, "total_tokens", None)
    if prompt is not None:
        out["input_tokens"] = prompt
    if completion is not None:
        out["output_tokens"] = completion
    if total is not None:
        out["total_tokens"] = total
    return out or None


def _output(response: Any) -> Any:
    choices = getattr(response, "choices", None)
    if choices:
        message = getattr(choices[0], "message", None)
        if message is not None:
            return message
    return response


def _finish_reasons(response: Any) -> list[str] | None:
    choices = getattr(response, "choices", None)
    if not choices:
        return None
    reasons = [r for r in (getattr(c, "finish_reason", None) for c in choices) if r]
    return reasons or None


# --- Tool selection adapter (ADR-0015): OpenAI chat-completions tool shape. ---


def _tool_descriptor(tool: Any) -> tuple[str, str, dict[str, Any]] | None:
    if not isinstance(tool, dict):
        return None
    function = tool.get("function")
    if not isinstance(function, dict):
        return None  # non-function tool (built-in) — keep always
    name = function.get("name")
    if not isinstance(name, str) or not name:
        return None
    params = function.get("parameters")
    return (name, function.get("description") or "", params if isinstance(params, dict) else {})


def _forced_names(kwargs: dict[str, Any]) -> list[str]:
    choice = kwargs.get("tool_choice")
    if isinstance(choice, dict):
        function = choice.get("function")
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            return [function["name"]]
    return []


def _tool_calls(response: Any) -> list[str] | None:
    try:
        choices = getattr(response, "choices", None)
        if not choices:
            return None
        message = getattr(choices[0], "message", None)
        calls = getattr(message, "tool_calls", None)
        if not calls:
            return None
        names = [
            name
            for name in (getattr(getattr(c, "function", None), "name", None) for c in calls)
            if name
        ]
        return names or None
    except Exception:
        return None


OPENAI_TOOLS = ToolAdapter(
    get_tools=lambda kw: kw.get("tools"),
    with_tools=lambda kw, tools: {**kw, "tools": tools},
    descriptor=_tool_descriptor,
    forced_names=_forced_names,
    tool_calls_of=_tool_calls,
)


OPENAI_SPEC = ProviderSpec(
    provider="openai",
    name="openai.chat.completions",
    model_of_request=lambda kw: kw.get("model"),
    input_of_request=lambda kw: kw.get("messages"),
    request_params=_request_params,
    usage_of=_usage,
    output_of=_output,
    response_model_of=lambda resp: getattr(resp, "model", None),
    finish_reasons_of=_finish_reasons,
    tool_adapter=OPENAI_TOOLS,
)


def wrap_openai(client: Any, *, select_tools: bool | ToolSelection | None = None) -> Any:
    """Trace `client.chat.completions.create` in place; returns the client.

    Pass `select_tools=True` (or a `ToolSelection`) to also transparently
    BM25-prune the `tools` array to the top-K per call (ADR-0015)."""
    selection = ToolSelection.resolve(select_tools)
    try:
        completions = client.chat.completions
        if not patch_method(completions, "create", OPENAI_SPEC, selection):
            logger.debug("ratel: could not patch openai client; tracing disabled for it")
    except Exception as exc:
        logger.debug("ratel: wrap_openai failed (%s); returning client untouched", exc)
    return client


def _load() -> Any:
    try:
        import openai
    except ImportError as exc:  # pragma: no cover - exercised via a stubbed import in tests
        raise ImportError(
            "ratel_ai.openai requires the 'openai' package. Install it with: pip install openai"
        ) from exc
    return openai


def OpenAI(*args: Any, select_tools: bool | ToolSelection | None = None, **kwargs: Any) -> Any:
    """Construct a traced OpenAI client (drop-in for `openai.OpenAI`)."""
    return wrap_openai(_load().OpenAI(*args, **kwargs), select_tools=select_tools)


def AsyncOpenAI(
    *args: Any, select_tools: bool | ToolSelection | None = None, **kwargs: Any
) -> Any:
    """Construct a traced AsyncOpenAI client (drop-in for `openai.AsyncOpenAI`)."""
    return wrap_openai(_load().AsyncOpenAI(*args, **kwargs), select_tools=select_tools)
