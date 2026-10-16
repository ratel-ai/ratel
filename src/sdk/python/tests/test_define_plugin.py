"""``define_plugin``: declare a ranking plugin from its two rank functions."""

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


def test_both_functions_are_required() -> None:
    # A one-stage ranker is a plain RankFn passed to the catalog, not a plugin.
    with pytest.raises(TypeError, match="rerank must be callable"):
        define_plugin(retrieve=_rank, rerank=cast(Any, None))
    with pytest.raises(TypeError, match="retrieve must be callable"):
        define_plugin(retrieve=cast(Any, None), rerank=_rank)
    with pytest.raises(TypeError):
        cast(Any, define_plugin)(retrieve=_rank)


def test_a_non_callable_is_rejected() -> None:
    with pytest.raises(TypeError, match="retrieve must be callable"):
        define_plugin(retrieve=cast(Any, "bm25"), rerank=_rank)


def test_the_plugin_fields_are_required() -> None:
    with pytest.raises(TypeError):
        cast(Any, RetrieverPlugin)(retrieve=_rank)


async def test_plugs_straight_into_a_catalog() -> None:
    plugin = define_plugin(retrieve=_rank, rerank=_rank)
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
