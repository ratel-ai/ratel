"""Usage-rollup assembly for the lean cloud client (ADR-0013).

A *rollup* is one agent interaction's token accounting — exactly the body the
cloud's `POST /api/v1/events` accepts and the dashboard renders. The numbers
themselves (token estimation, savings, cost) come from `ratel-ai-core` via the
native binding; this module only normalizes and shapes them for the wire.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from .. import _native

# The context sources the dashboard breaks spend/savings down by. Order matters
# only for readability; the cloud keys on the names.
CONTEXT_SOURCES = ("skills", "tools", "history", "memory", "user_input")

SourceMap = Mapping[str, Any]


def normalize_sources(value: SourceMap | None) -> dict[str, int] | None:
    """Coerce a (possibly partial) per-source mapping to all five keys as ints,
    missing keys zero-filled. ``None`` passes through so the caller can omit the
    field entirely (e.g. no savings recorded for this interaction)."""
    if value is None:
        return None
    out = {key: 0 for key in CONTEXT_SOURCES}
    for key in CONTEXT_SOURCES:
        raw = value.get(key, 0)
        # Clamp to non-negative — the cloud rejects negative counts, and this keeps
        # parity with the TS client's `raw > 0 ? trunc : 0`.
        out[key] = int(raw) if raw and raw > 0 else 0
    return out


def count_segment(seg: Any) -> int:
    """Token-count one raw context segment via the core estimator: a string
    directly, a list/tuple element-wise, any other object by its compact JSON
    (mirrors the TS client's `estimateTokens(JSON.stringify(seg))`)."""
    if seg is None:
        return 0
    if isinstance(seg, str):
        return int(_native.estimate_tokens(seg))
    if isinstance(seg, (list, tuple)):
        return sum(count_segment(item) for item in seg)
    return int(_native.estimate_tokens(json.dumps(seg, separators=(",", ":"), default=str)))


def tokens_from_context(context: SourceMap) -> dict[str, int]:
    """Derive per-source token counts from raw context segments — pass what you
    already have (the system/skills text, the tools list, the prior messages, the
    retrieved memory, the user's turn) and let the core estimator count each."""
    return {key: count_segment(context.get(key)) for key in CONTEXT_SOURCES}


def build_rollup(
    *,
    tokens_by_category: SourceMap | None = None,
    context: SourceMap | None = None,
    saved_by_category: SourceMap | None = None,
    saveable_by_category: SourceMap | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    model: str | None = None,
    latency_ms: int | None = None,
    cost_usd: float | None = None,
    occurred_at: datetime | str | None = None,
) -> dict[str, Any]:
    """Assemble one interaction's rollup event.

    Provide the per-source spend one of two ways: ``tokens_by_category`` when you
    already have exact counts (provider usage, tiktoken), or ``context`` — raw
    segments the SDK token-counts for you (no manual tokenization). When both are
    given, ``tokens_by_category`` wins. ``input_tokens`` defaults to the sum of
    the per-source spend, and ``cost_usd`` is estimated from the model + tokens
    (via the core) unless given.
    """
    per_source = tokens_by_category
    if per_source is None and context is not None:
        per_source = tokens_from_context(context)
    tokens = normalize_sources(per_source) or {key: 0 for key in CONTEXT_SOURCES}
    total = sum(tokens.values())
    event: dict[str, Any] = {"tokens_by_category": tokens}

    saved = normalize_sources(saved_by_category)
    if saved is not None:
        event["saved_by_category"] = saved
    saveable = normalize_sources(saveable_by_category)
    if saveable is not None:
        event["saveable_by_category"] = saveable

    event["input_tokens"] = int(input_tokens) if input_tokens is not None else total
    if output_tokens is not None:
        event["output_tokens"] = int(output_tokens)
    if model:
        event["model"] = model
    if latency_ms is not None:
        event["latency_ms"] = int(latency_ms)

    if cost_usd is not None:
        event["cost_usd"] = float(cost_usd)
    elif model:
        # Cost maths live in the core — estimate from model + tokens.
        out_tokens = int(event.get("output_tokens", 0))
        event["cost_usd"] = round(
            _native.estimate_cost_usd(model, event["input_tokens"], out_tokens), 6
        )

    if occurred_at is not None:
        event["occurred_at"] = (
            occurred_at.isoformat() if isinstance(occurred_at, datetime) else str(occurred_at)
        )
    return event
