"""Usage-rollup assembly for the lean cloud client (ADR-0016).

A *rollup* is one agent interaction's token accounting — exactly the body the
cloud's `POST /api/v1/events` accepts and the dashboard renders. The numbers
themselves (token estimation, savings, cost) come from `ratel-ai-core` via the
native binding; this module only normalizes and shapes them for the wire.
"""

from __future__ import annotations

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
        out[key] = int(raw) if raw else 0
    return out


def build_rollup(
    *,
    tokens_by_category: SourceMap,
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

    The only required field is ``tokens_by_category``; everything else enriches
    it. ``input_tokens`` defaults to the sum of the per-source spend, and
    ``cost_usd`` is estimated from the model + tokens (via the core) unless given.
    """
    tokens = normalize_sources(tokens_by_category) or {key: 0 for key in CONTEXT_SOURCES}
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
