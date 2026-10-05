"""Caller-supplied ranking functions (ADR-0027).

Rust cannot call back into Python mid-search, so a search with a
``retrieve_fn`` or ``reranker_fn`` runs in phases: the native registry hands out
candidates (the whole catalog, or stage 1's top hits), the function ranks them
here, and the registry completes the search, validating the ranking and
recording one event.
"""

from __future__ import annotations

import inspect
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypedDict, Union

from .exceptions import RetrieverError
from .telemetry import RuntimeEventProjection

RankCandidateKind = Literal["tool", "skill"]
"""What kind of catalog item a ranking function is asked about."""


@dataclass(frozen=True)
class RankCandidate:
    """A catalog item offered to a `RankFn`."""

    #: The tool or skill id; return it to rank the item.
    id: str
    #: ``"tool"`` or ``"skill"``. One call offers one kind.
    kind: RankCandidateKind
    #: The text the built-in methods rank: name plus description (or its
    #: searchable override).
    text: str


class RankedId(TypedDict):
    """One id a `RankFn` scored."""

    #: One of the offered candidates' ids; anything else is dropped.
    id: str
    #: Higher is better; clamped to ``[0, 1]``, a non-finite score reads as 0.
    score: float


RankFn = Callable[
    [str, list[RankCandidate], int],
    Union[Sequence[RankedId], Awaitable[Sequence[RankedId]]],
]
"""A caller-supplied ranking function (ADR-0027): ``(query, candidates, top_k)``
to ``{"id", "score"}`` pairs in any order, returned directly or awaited.

As ``retrieve_fn`` (``method="custom"``) it ranks the whole catalog and the
search returns only the ids it returned, best first, at most ``top_k``. As
``reranker_fn`` it ranks the first stage's top candidates; ids outside them are
dropped, candidates it left out follow at 0, and ties keep the first stage's
order. A raise fails the search, except a `RetrieverError` with
``transient=True`` from a reranker, which keeps the first stage's order. A
failed search records no ``search`` trace event; the error reaches the caller
and the ``ratel.search`` span.
**Experimental.**
"""


class _StageOne(Protocol):
    @property
    def candidates(self) -> list[tuple[str, str]]: ...


class _NativeRanking(Protocol):
    """The phase API both native registries expose."""

    def rank_candidates(self) -> list[tuple[str, str]]: ...

    def _complete_custom_search(
        self,
        query: str,
        top_k: int,
        origin: str,
        ranked: list[tuple[str, float]],
        took_ms: int,
        context: Any = None,
    ) -> list[Any]: ...

    def _complete_rerank(
        self,
        query: str,
        origin: str,
        stage_one: Any,
        ranked: list[tuple[str, float]] | None,
        fallback_code: str | None,
        took_ms: int,
        context: Any = None,
    ) -> list[Any]: ...


def _with_kind(candidates: list[tuple[str, str]], kind: RankCandidateKind) -> list[RankCandidate]:
    return [RankCandidate(id=id_, kind=kind, text=text) for id_, text in candidates]


def _check_ranked(value: Any, name: str) -> list[tuple[str, float]]:
    """Reject a ranking the core cannot read, naming the function that returned it."""
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise TypeError(f"{name} must return a list of {{'id', 'score'}}, got {type(value)!r}")
    pairs: list[tuple[str, float]] = []
    for item in value:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("id"), str)
            or isinstance(item.get("score"), bool)
            or not isinstance(item.get("score"), (int, float))
        ):
            raise TypeError(f"{name} must return a list of {{'id': str, 'score': float}}")
        pairs.append((item["id"], float(item["score"])))
    return pairs


async def _call(fn: RankFn, query: str, candidates: list[RankCandidate], top_k: int) -> Any:
    result = fn(query, candidates, top_k)
    return await result if inspect.isawaitable(result) else result


def _elapsed_ms(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


async def custom_search(
    native: _NativeRanking,
    kind: RankCandidateKind,
    fn: RankFn,
    query: str,
    top_k: int,
    origin: str,
    context: RuntimeEventProjection | None,
) -> list[Any]:
    """Rank the whole catalog with ``fn`` and complete the search.

    ``native`` is the native tool or skill registry; its hits come back as is.
    """
    candidates = _with_kind(native.rank_candidates(), kind) if top_k > 0 else []
    if not candidates:
        return native._complete_custom_search(query, top_k, origin, [], 0, context)
    started = time.perf_counter()
    ranked = _check_ranked(await _call(fn, query, candidates, top_k), "retrieve_fn")
    return native._complete_custom_search(
        query, top_k, origin, ranked, _elapsed_ms(started), context
    )


async def custom_rerank(
    native: _NativeRanking,
    stage_one: Callable[[], Awaitable[_StageOne]],
    kind: RankCandidateKind,
    fn: RankFn,
    query: str,
    top_k: int,
    origin: str,
    context: RuntimeEventProjection | None,
) -> list[Any]:
    """Run stage 1 natively, rerank its candidates with ``fn``, and complete the search.

    ``stage_one`` runs the native first stage; ``native`` completes it.
    """
    stage = await stage_one()
    candidates = _with_kind(stage.candidates, kind)
    if not candidates:
        return native._complete_rerank(query, origin, stage, [], None, 0, context)
    started = time.perf_counter()
    try:
        ranked = _check_ranked(await _call(fn, query, candidates, top_k), "reranker_fn")
    except RetrieverError as error:
        # A transient failure keeps stage 1's order; the trace says why.
        if not error.transient:
            raise
        return native._complete_rerank(
            query, origin, stage, None, error.code, _elapsed_ms(started), context
        )
    return native._complete_rerank(
        query, origin, stage, ranked, None, _elapsed_ms(started), context
    )
