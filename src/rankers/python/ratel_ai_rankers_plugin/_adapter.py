"""The shared adapter (ADR-0027, ADR-0028).

A native choice ranker wrapped into the ranking functions a catalog takes,
``retrieve_fn`` and ``reranker_fn``. Each vendor plugin only builds its native
ranker.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import Protocol

from ratel_ai import RankCandidate, RankedId, RetrieverError, RetrieverPlugin

from ._native import ChoiceRanker as _NativeChoiceRanker
from ._native import RankerError


class ChoiceRanker(Protocol):
    """A ranker the adapter can wrap: the native `ChoiceRanker`, or your own object."""

    def rank(
        self, query: str, candidates: list[tuple[str, str]], top_k: int, kind: str
    ) -> list[tuple[str, float]]:
        """Rank ``(id, text)`` candidates of one ``kind``: ``(id, score)`` best first."""
        ...


def _retriever_error(error: RankerError) -> RetrieverError:
    """A native failure as the SDK's `RetrieverError`, keeping its typed fields."""
    return RetrieverError(
        str(error),
        error.code,
        transient=error.transient,
        status=error.status,
        retry_after_secs=error.retry_after_secs,
    )


def native_ranker(
    vendor: str,
    url: str | None = None,
    api_key_env: str | None = None,
    model: str | None = None,
) -> _NativeChoiceRanker:
    """The native ranker for ``vendor``; an unknown vendor raises `RetrieverError`."""
    try:
        return _NativeChoiceRanker(vendor, url, api_key_env, model)
    except RankerError as error:
        raise _retriever_error(error) from error


def choice_ranker_plugin(ranker: ChoiceRanker) -> RetrieverPlugin:
    """``ranker`` as a plugin: one rank function for both stages, run on a worker thread.

    Native failures raise as the SDK's `RetrieverError`, so a catalog's
    transient-fallback check sees them. **Experimental** — may change without a
    major version bump.
    """

    async def rank(query: str, candidates: list[RankCandidate], top_k: int) -> Sequence[RankedId]:
        if not candidates or top_k <= 0:
            return []
        pairs = [(c.id, c.text) for c in candidates]
        try:
            ranked = await asyncio.to_thread(ranker.rank, query, pairs, top_k, candidates[0].kind)
        except RankerError as error:
            raise _retriever_error(error) from error
        return [{"id": id_, "score": score} for id_, score in ranked]

    return RetrieverPlugin(retrieve=rank, rerank=rank)
