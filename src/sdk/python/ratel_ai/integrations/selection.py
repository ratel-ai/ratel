"""Transparent tool selection for the provider wrappers (ADR-0015).

When enabled, the drop-in wrappers run Ratel's BM25 ranking over the `tools`
array a caller already passes to the provider and keep only the top-K most
relevant to the current message — saving prompt tokens **without the caller ever
registering a `ToolCatalog`**. Ranking reuses the native `ToolRegistry`, so it is
the same engine the explicit catalog uses.

This changes what the model can call, so it is OFF by default, threshold-gated,
and fails open: any error (or a query that matches nothing) leaves the original
tools untouched. A tool pinned by `tool_choice` is always kept, and tools the
ranker can't read (provider built-ins without a name) are never dropped.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .._native import ToolRegistry
from ..observability.estimator import TokenEstimator, default_estimator
from ..observability.savings import Savings

DEFAULT_TOP_K = 20
DEFAULT_MIN_TOOLS = 25

_TRUE = {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class ToolSelection:
    """Config for transparent in-call tool selection.

    `top_k` is the working set kept per call; `min_tools` is the floor below which
    nothing is pruned (small tool lists aren't worth the behavior change).
    """

    enabled: bool = False
    top_k: int = DEFAULT_TOP_K
    min_tools: int = DEFAULT_MIN_TOOLS

    @classmethod
    def resolve(
        cls,
        value: bool | ToolSelection | None = None,
        *,
        top_k: int | None = None,
        min_tools: int | None = None,
    ) -> ToolSelection:
        """Build from a `bool | ToolSelection | None`. None reads the environment
        (`RATEL_TOOL_SELECTION`, default off)."""
        if isinstance(value, ToolSelection):
            return value
        if value is None:
            enabled = os.environ.get("RATEL_TOOL_SELECTION", "").strip().lower() in _TRUE
        else:
            enabled = bool(value)
        return cls(
            enabled=enabled,
            top_k=top_k
            if top_k is not None
            else _env_int("RATEL_TOOL_SELECTION_TOP_K", DEFAULT_TOP_K),
            min_tools=min_tools
            if min_tools is not None
            else _env_int("RATEL_TOOL_SELECTION_MIN_TOOLS", DEFAULT_MIN_TOOLS),
        )


@dataclass(frozen=True)
class ToolAdapter:
    """Provider-specific reading/writing of the `tools` array and tool calls."""

    get_tools: Callable[[dict[str, Any]], Any]
    with_tools: Callable[[dict[str, Any], list[Any]], dict[str, Any]]
    # (name, description, input_schema) for a rankable tool, or None to keep-always.
    descriptor: Callable[[Any], tuple[str, str, dict[str, Any]] | None]
    forced_names: Callable[[dict[str, Any]], list[str]]
    tool_calls_of: Callable[[Any], list[str] | None]


@dataclass(frozen=True)
class SelectionResult:
    kwargs: dict[str, Any]
    tools_offered: int
    tools_selected: int
    selected_names: list[str]
    savings: Savings


def _tools_tokens(tools: list[Any], estimator: TokenEstimator) -> int:
    total = 0
    for tool in tools:
        try:
            total += estimator.estimate(json.dumps(tool, sort_keys=True, default=str))
        except Exception:
            pass
    return total


def rank_tools(
    kwargs: dict[str, Any],
    adapter: ToolAdapter,
    selection: ToolSelection,
    *,
    query: str,
    estimator: TokenEstimator | None = None,
) -> SelectionResult | None:
    """Prune the request's `tools` to the BM25 top-K for `query`.

    Returns `None` (no change) when selection wouldn't help or isn't safe:
    too few tools, an empty query, nothing to trim, or no ranking match.
    """
    estimator = estimator or default_estimator()
    raw = adapter.get_tools(kwargs)
    if not raw:
        return None
    tools = list(raw)
    if len(tools) <= selection.min_tools:
        return None
    q = (query or "").strip()
    if not q:
        return None

    descriptors: list[tuple[Any, tuple[str, str, dict[str, Any]] | None]] = [
        (tool, adapter.descriptor(tool)) for tool in tools
    ]
    rankable_count = sum(1 for _tool, desc in descriptors if desc is not None)
    if rankable_count <= selection.top_k:
        return None  # nothing to trim among the rankable tools

    registry = ToolRegistry()
    seen: set[str] = set()
    for _tool, desc in descriptors:
        if desc is None:
            continue
        name, description, schema = desc
        if name in seen:
            continue
        seen.add(name)
        try:
            registry.register(
                name, name, description or "", schema if isinstance(schema, dict) else {}, {}
            )
        except Exception:
            pass

    hits = registry.search(q, selection.top_k)
    keep_names = {hit.tool_id for hit in hits}
    if not keep_names:
        return None  # the query matched nothing — don't nuke every tool

    for pinned in adapter.forced_names(kwargs):
        if pinned:
            keep_names.add(pinned)

    kept: list[Any] = []
    for tool, desc in descriptors:
        if desc is None:
            kept.append(tool)  # provider built-in / unreadable — always keep
        elif desc[0] in keep_names:
            kept.append(tool)
    if len(kept) >= len(tools):
        return None  # nothing was trimmed

    full_tokens = _tools_tokens(tools, estimator)
    selected_tokens = _tools_tokens(kept, estimator)
    savings = Savings(
        full_catalog_tokens=full_tokens,
        selected_tokens=selected_tokens,
        tokens_saved=max(0, full_tokens - selected_tokens),
        top_k=selection.top_k,
    )
    selected_names = [
        desc[0] for _tool, desc in descriptors if desc is not None and desc[0] in keep_names
    ]
    return SelectionResult(
        kwargs=adapter.with_tools(kwargs, kept),
        tools_offered=len(tools),
        tools_selected=len(kept),
        selected_names=selected_names,
        savings=savings,
    )


def last_user_text(messages: Any) -> str:
    """Extract the latest user-turn text from a messages list (the ranking query).

    Handles string content and OpenAI/Anthropic content-part lists. Never raises.
    """
    try:
        if not messages:
            return ""
        for message in reversed(list(messages)):
            role = message.get("role") if isinstance(message, dict) else None
            if role != "user":
                continue
            return _text_of(message.get("content"))
        return ""
    except Exception:
        return ""


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict):
                text = part.get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(part, str):
                parts.append(part)
        return " ".join(parts)
    return ""
