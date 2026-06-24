"""Token estimators for the savings metric (ADR-0012).

Savings is a *ratio/delta* signal (full catalog vs selected top-K), so a cheap
`len // 4` heuristic is the dependency-free default — its bias largely cancels.
A `tiktoken`-backed estimator (optional `observability-tiktoken` extra) is
available when precise counts matter.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

_CHARS_PER_TOKEN = 4


@runtime_checkable
class TokenEstimator(Protocol):
    """Anything that can turn text into an approximate token count."""

    def estimate(self, text: str) -> int: ...


class HeuristicEstimator:
    """Dependency-free `len // 4` estimate — good enough for a relative signal."""

    def estimate(self, text: str) -> int:
        if not text:
            return 0
        return max(1, len(text) // _CHARS_PER_TOKEN)


class TiktokenEstimator:
    """Precise estimate via `tiktoken`. Raises a clear hint if it isn't installed."""

    def __init__(self, encoding: str = "cl100k_base") -> None:
        try:
            import tiktoken
        except ImportError as exc:  # pragma: no cover - exercised via stubbed import
            raise ImportError(
                "TiktokenEstimator requires the 'tiktoken' package. Install it with: "
                "pip install 'ratel-ai[observability-tiktoken]'"
            ) from exc
        self._encoding = tiktoken.get_encoding(encoding)

    def estimate(self, text: str) -> int:
        if not text:
            return 0
        return len(self._encoding.encode(text))


def default_estimator() -> TokenEstimator:
    """The estimator used unless a caller supplies their own."""
    return HeuristicEstimator()
