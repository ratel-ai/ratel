"""The package surface: the SDK's plugin contract, the shared adapter, the native ranker."""

from __future__ import annotations

from typing import Any

import pytest
import ratel_ai

import ratel_ai_rankers_plugin as plugin
from ratel_ai_rankers_plugin import RankCandidate, RetrieverError, choice_ranker_plugin
from ratel_ai_rankers_plugin._adapter import native_ranker
from ratel_ai_rankers_plugin._native import ChoiceRanker, RankerError, vendors


def test_the_contract_is_the_sdks_own() -> None:
    assert plugin.RetrieverError is ratel_ai.RetrieverError
    assert plugin.RetrieverPlugin is ratel_ai.RetrieverPlugin
    assert plugin.define_plugin is ratel_ai.define_plugin


class Recording:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list[str]]] = []

    def rank(
        self, query: str, candidates: list[tuple[str, str]], top_k: int, kind: str
    ) -> list[tuple[str, float]]:
        self.calls.append((kind, [id_ for id_, _ in candidates]))
        return [(id_, 1.0 - i / 10) for i, (id_, _) in enumerate(candidates)]


async def test_the_adapter_wraps_any_ranker_object() -> None:
    ranker = Recording()
    wrapped = choice_ranker_plugin(ranker)
    assert wrapped.retrieve is wrapped.rerank
    rerank: Any = wrapped.rerank
    ranked = await rerank(
        "q", [RankCandidate("a", "skill", "A"), RankCandidate("b", "skill", "B")], 2
    )
    assert list(ranked) == [{"id": "a", "score": 1.0}, {"id": "b", "score": 0.9}]
    assert ranker.calls == [("skill", ["a", "b"])]


async def test_the_adapter_asks_nothing_for_no_candidates_or_top_k_zero() -> None:
    ranker = Recording()
    retrieve: Any = choice_ranker_plugin(ranker).retrieve
    assert list(await retrieve("q", [], 5)) == []
    assert list(await retrieve("q", [RankCandidate("a", "tool", "A")], 0)) == []
    assert ranker.calls == []


def test_both_vendors_ship() -> None:
    assert vendors() == ["jev", "openai-decision"]
    assert ChoiceRanker("jev").service == "jev"
    assert ChoiceRanker("openai-decision").service == "openai decisions"


def test_an_unknown_vendor_is_a_config_error() -> None:
    with pytest.raises(RankerError) as caught:
        ChoiceRanker("acme")
    assert (caught.value.code, caught.value.transient) == ("Config", False)
    assert '"acme"' in str(caught.value)


def test_an_unknown_kind_is_a_value_error() -> None:
    with pytest.raises(ValueError, match="widget"):
        ChoiceRanker("jev").rank("q", [("a", "A"), ("b", "B")], 1, "widget")


def test_native_ranker_builds_a_vendors_ranker() -> None:
    assert native_ranker("jev").service == "jev"


def test_native_ranker_raises_an_unknown_vendor_as_the_sdks_retriever_error() -> None:
    with pytest.raises(RetrieverError) as caught:
        native_ranker("acme")
    assert (caught.value.code, caught.value.transient) == ("Config", False)
    assert '"acme"' in str(caught.value)
    assert isinstance(caught.value.__cause__, RankerError)
