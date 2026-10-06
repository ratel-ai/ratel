"""The Jev plugin (ADR-0027).

Jev (TypeSafe AI) wrapped into the ranking functions a catalog takes,
``retrieve_fn`` and ``reranker_fn``. Search knows only those functions; Jev's
request format lives in the native Jev client, so a change to Jev's interface
never reaches the catalogs.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass

from ._custom_ranking import RankCandidate, RankedId, RankFn
from ._native import JevError, JevRanker
from .exceptions import RetrieverError


@dataclass(frozen=True)
class RetrieverPlugin:
    """A model's two ranking functions, for ``retrieve_fn`` and ``reranker_fn``."""

    #: Rank the whole catalog: pass as ``retrieve_fn`` with ``method="custom"``.
    retrieve: RankFn
    #: Rerank the first stage's top candidates: pass as ``reranker_fn``.
    rerank: RankFn


def ratel_jev_plugin(
    url: str | None = None,
    api_key_env: str | None = None,
    model: str | None = None,
) -> RetrieverPlugin:
    """Jev as a ranker or reranker (ADR-0027).

    The query and each candidate's searchable text are sent to Jev; every
    failure raises a `RetrieverError` whose ``transient`` flag decides whether a
    reranker falls back to the first stage's order. **Experimental** — may
    change without a major version bump.

    Args:
        url: Jev base URL (a proxy, tests); ``/v1/systemone`` is appended.
            Default ``https://api.typesafe.ai``.
        api_key_env: environment variable holding the Jev key, read at call
            time. Default ``TYPESAFE_API_KEY``.
        model: Jev model. Default ``"jev-latest"``.

    Example::

        jev = ratel_jev_plugin()
        ToolCatalog(method="custom", retrieve_fn=jev.retrieve)   # Jev ranks every tool
        ToolCatalog(method="bm25", reranker_fn=jev.rerank)       # Jev reranks BM25's top 50
    """
    ranker = JevRanker(url, api_key_env, model)

    async def rank(query: str, candidates: list[RankCandidate], top_k: int) -> Sequence[RankedId]:
        if not candidates or top_k <= 0:
            return []
        pairs = [(c.id, c.text) for c in candidates]
        try:
            ranked = await asyncio.to_thread(ranker.rank, query, pairs, top_k, candidates[0].kind)
        except JevError as error:
            raise RetrieverError(
                str(error),
                error.code,
                transient=error.transient,
                status=error.status,
                retry_after_secs=error.retry_after_secs,
            ) from error
        return [{"id": id_, "score": score} for id_, score in ranked]

    return RetrieverPlugin(retrieve=rank, rerank=rank)
