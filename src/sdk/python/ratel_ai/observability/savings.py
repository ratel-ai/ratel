"""Ratel tool-selection savings — full catalog vs selected top-K context tokens.

When an agent uses Ratel's tool selection, the context it would have carried is
the whole registered catalog; what it actually carries is the top-K hits. The
difference is the token saving we report (a `tokens_saved` core event plus a
rich cloud event). Estimation is pluggable via `TokenEstimator`.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from .estimator import TokenEstimator


def tool_text(tool: Any) -> str:
    """The textual footprint a tool contributes to an agent's context."""
    parts: list[str] = []
    for attr in ("name", "description"):
        value = getattr(tool, attr, None)
        if value:
            parts.append(str(value))
    for attr in ("input_schema", "output_schema"):
        schema = getattr(tool, attr, None)
        if schema:
            try:
                parts.append(json.dumps(schema, separators=(",", ":"), sort_keys=True))
            except Exception:
                pass
    return " ".join(parts)


def tool_tokens(tool: Any, estimator: TokenEstimator) -> int:
    return estimator.estimate(tool_text(tool))


def catalog_tokens(tools: Iterable[Any], estimator: TokenEstimator) -> int:
    return sum(tool_tokens(tool, estimator) for tool in tools)


@dataclass(frozen=True)
class Savings:
    full_catalog_tokens: int
    selected_tokens: int
    tokens_saved: int
    top_k: int

    def as_metadata(self) -> dict[str, int]:
        return {
            "full_catalog_tokens": self.full_catalog_tokens,
            "selected_tokens": self.selected_tokens,
            "tokens_saved": self.tokens_saved,
            "top_k": self.top_k,
        }


def compute_savings(
    selected: Iterable[Any],
    full_catalog_tokens: int,
    top_k: int,
    estimator: TokenEstimator,
) -> Savings:
    """Savings from a single search: `full_catalog_tokens` (precomputed/cached)
    minus the estimated tokens of the `selected` tools."""
    selected_tokens = catalog_tokens(selected, estimator)
    return Savings(
        full_catalog_tokens=full_catalog_tokens,
        selected_tokens=selected_tokens,
        tokens_saved=max(0, full_catalog_tokens - selected_tokens),
        top_k=top_k,
    )
