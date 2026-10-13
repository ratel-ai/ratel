"""What the decision-model plugins share (ADR-0027).

A native choice ranker (Jev, OpenAI Decisions) wrapped into the ranking
functions a catalog takes, ``retrieve_fn`` and ``reranker_fn``. Each plugin
only builds its native client.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from ._custom_ranking import RankCandidate, RankedId, RankFn
from ._native import RankerError
from .exceptions import RetrieverError


@dataclass(frozen=True)
class RetrieverPlugin:
    """A model's two ranking functions, for ``retrieve_fn`` and ``reranker_fn``."""

    #: Rank the whole catalog: pass as ``retrieve_fn`` with ``method="custom"``.
    retrieve: RankFn
    #: Rerank the first stage's top candidates: pass as ``reranker_fn``.
    rerank: RankFn


class ChoiceRanker(Protocol):
    """A native choice ranker: `JevRanker`, `OpenAIDecisionRanker`."""

    def rank(
        self, query: str, candidates: list[tuple[str, str]], top_k: int, kind: str
    ) -> list[tuple[str, float]]: ...


def choice_ranker_plugin(ranker: ChoiceRanker) -> RetrieverPlugin:
    """``ranker`` as a plugin: one rank function for both stages.

    Its failures raise as `RetrieverError`s.
    """

    async def rank(query: str, candidates: list[RankCandidate], top_k: int) -> Sequence[RankedId]:
        if not candidates or top_k <= 0:
            return []
        pairs = [(c.id, c.text) for c in candidates]
        try:
            ranked = await asyncio.to_thread(ranker.rank, query, pairs, top_k, candidates[0].kind)
        except RankerError as error:
            raise RetrieverError(
                str(error),
                error.code,
                transient=error.transient,
                status=error.status,
                retry_after_secs=error.retry_after_secs,
            ) from error
        return [{"id": id_, "score": score} for id_, score in ranked]

    return RetrieverPlugin(retrieve=rank, rerank=rank)
