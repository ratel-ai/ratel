"""``define_plugin``: declare a ranking plugin from one or both rank functions."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, cast

import pytest

from ratel_ai import (
    ExecutableTool,
    RankCandidate,
    RankedId,
    RetrieverPlugin,
    ToolCatalog,
    define_plugin,
)


def _rank(_query: str, candidates: list[RankCandidate], _top_k: int) -> Sequence[RankedId]:
    return [{"id": c.id, "score": 1.0 / (i + 1)} for i, c in enumerate(candidates)]


def test_both_functions_make_a_retriever_plugin() -> None:
    plugin = define_plugin(retrieve=_rank, rerank=_rank)
    assert isinstance(plugin, RetrieverPlugin)
    assert plugin.retrieve is _rank
    assert plugin.rerank is _rank


def test_one_function_is_enough() -> None:
    assert define_plugin(rerank=_rank).retrieve is None
    assert define_plugin(retrieve=_rank).rerank is None


def test_neither_function_is_rejected() -> None:
    with pytest.raises(TypeError, match="retrieve, rerank, or both"):
        define_plugin()


def test_a_non_callable_is_rejected() -> None:
    with pytest.raises(TypeError, match="retrieve must be callable"):
        define_plugin(retrieve=cast(Any, "bm25"))


async def test_plugs_straight_into_a_catalog() -> None:
    plugin = define_plugin(retrieve=_rank)
    catalog = ToolCatalog(method="custom", retrieve_fn=plugin.retrieve)
    await catalog.register(
        [
            ExecutableTool(
                id="read_file", name="read_file", description="read a file", execute=lambda _a: "ok"
            )
        ]
    )
    hits = await catalog.search_async("read", 1)
    assert [h.tool_id for h in hits] == ["read_file"]
