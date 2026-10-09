"""The OpenAI Decisions plugin (ADR-0027).

OpenAI's Decisions API wrapped into the ranking functions a catalog takes,
``retrieve_fn`` and ``reranker_fn``. Search knows only those functions; the
Decisions request format lives in the native client, so a change to OpenAI's
beta API never reaches the catalogs.
"""

from __future__ import annotations

import asyncio
import os
import warnings
from collections.abc import Sequence

from ._custom_ranking import RankCandidate, RankedId
from ._native import OpenAIDecisionRanker, RankerError
from .exceptions import RetrieverError
from .fact_catalog import ExperimentalWarning
from .jev import RetrieverPlugin

_DEFAULT_MODEL = "gpt-6-luna"

# One-time gate for the beta warning the first plugin emits. Module-level so a
# test can reset it (the warning is once per process).
_warned = False


def _warn_beta_once(model: str | None) -> None:
    """Warn once per process that the plugin is beta.

    Skipped when ``RATEL_EXPERIMENTAL_SILENCE`` is set.
    """
    global _warned
    if _warned or os.environ.get("RATEL_EXPERIMENTAL_SILENCE"):
        return
    _warned = True
    if model is None or model == _DEFAULT_MODEL:
        model_line = f"only {_DEFAULT_MODEL} is supported."
    else:
        model_line = f"only {_DEFAULT_MODEL} is supported; this plugin asks {model}."
    warnings.warn(
        "ratel: the OpenAI Decisions plugin is beta. OpenAI's Decisions API is in public beta "
        f"and may change; {model_line} It ranks tools and skills only (no facts, text only). "
        "Ratel caps each question at 150 choices / 80,000 characters (OpenAI documents no "
        "limits). The query and each candidate's text are sent to OpenAI. "
        "Set RATEL_EXPERIMENTAL_SILENCE=1 to silence this warning.",
        ExperimentalWarning,
        stacklevel=3,
    )


def ratel_openai_decision_plugin(
    url: str | None = None,
    api_key_env: str | None = None,
    model: str | None = None,
) -> RetrieverPlugin:
    """OpenAI's Decisions API as a ranker or reranker (ADR-0027), for tools and skills.

    The query and each candidate's searchable text are sent to OpenAI; every
    failure raises a `RetrieverError` whose ``transient`` flag decides whether a
    reranker falls back to the first stage's order. A refusal by the model is
    ``code="Refused"``, transient. The Decisions API is in public beta: the first
    plugin made emits a one-time `ExperimentalWarning` (silence it with
    ``RATEL_EXPERIMENTAL_SILENCE=1``). **Experimental** — may change without a
    major version bump.

    Args:
        url: base URL (a proxy, tests); ``/v1/decisions`` is appended.
            Default ``https://api.openai.com``.
        api_key_env: environment variable holding the OpenAI key, read at call
            time. Default ``OPENAI_API_KEY``.
        model: Decisions model. Default ``"gpt-6-luna"``, the only one the beta
            supports.

    Example::

        decision = ratel_openai_decision_plugin()
        ToolCatalog(method="custom", retrieve_fn=decision.retrieve)  # Decisions ranks every tool
        ToolCatalog(method="bm25", reranker_fn=decision.rerank, reranker_depth=20)
    """
    _warn_beta_once(model)
    ranker = OpenAIDecisionRanker(url, api_key_env, model)

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
