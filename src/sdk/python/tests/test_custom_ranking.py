"""Caller-supplied ranking functions (ADR-0027): ``retrieve_fn`` with
``method="custom"`` and ``reranker_fn`` over a built-in first stage."""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

import pytest

from ratel_ai import (
    ExecutableTool,
    RankCandidate,
    RankedId,
    RetrieverError,
    Skill,
    SkillCatalog,
    ToolCatalog,
    TraceSinkConfig,
)


def _tool(tool_id: str, description: str) -> ExecutableTool:
    return ExecutableTool(
        id=tool_id, name=tool_id, description=description, execute=lambda _a: "ok"
    )


TOOLS = [
    _tool("read_file", "read a file from disk"),
    _tool("delete_file", "delete a file from disk"),
    _tool("list_files", "list the files in a directory"),
    _tool("send_email", "send an email message"),
]


class Scripted:
    """A ranking function scoring ids from a table; records every call."""

    def __init__(self, scores: dict[str, float]) -> None:
        self.scores = scores
        self.calls: list[tuple[str, list[RankCandidate], int]] = []

    async def __call__(
        self, query: str, candidates: list[RankCandidate], top_k: int
    ) -> Sequence[RankedId]:
        self.calls.append((query, candidates, top_k))
        return [{"id": c.id, "score": self.scores[c.id]} for c in candidates if c.id in self.scores]


def _searches(catalog: ToolCatalog) -> list[dict[str, Any]]:
    return [e for e in catalog.drain_trace_events() if e["type"] == "search"]


def _stage_names(event: dict[str, Any]) -> list[str]:
    return [stage["name"] for stage in event["stages"]]


async def _bm25_order(query: str, top_k: int) -> list[str]:
    plain = ToolCatalog()
    await plain.register(TOOLS)
    return [h.tool_id for h in plain.search(query, top_k)]


async def test_retrieve_fn_ranks_the_whole_catalog_and_returns_only_its_ids() -> None:
    fn = Scripted({"send_email": 0.9, "list_files": 0.4})
    catalog = ToolCatalog(
        method="custom", retrieve_fn=fn, trace=TraceSinkConfig(kind="memory", session_id="c")
    )
    await catalog.register(TOOLS)

    hits = await catalog.search_async("tell my boss", 3)

    assert [h.tool_id for h in hits] == ["send_email", "list_files"]
    assert hits[0].score == pytest.approx(0.9)
    _query, candidates, top_k = fn.calls[0]
    assert top_k == 3
    assert [c.id for c in candidates] == [t.id for t in TOOLS]
    assert {c.kind for c in candidates} == {"tool"}
    assert "read a file from disk" in candidates[0].text
    [event] = _searches(catalog)
    assert _stage_names(event) == ["custom"]


async def test_a_sync_retrieve_fn_works_too() -> None:
    def fn(_q: str, candidates: list[RankCandidate], _k: int) -> list[RankedId]:
        return [{"id": "send_email", "score": 1.0}]

    catalog = ToolCatalog(method="custom", retrieve_fn=fn)
    await catalog.register(TOOLS)
    assert [h.tool_id for h in await catalog.search_async("q", 2)] == ["send_email"]


async def test_unknown_and_duplicate_ids_are_dropped_and_scores_clamped() -> None:
    def fn(_q: str, _c: list[RankCandidate], _k: int) -> list[RankedId]:
        return [
            {"id": "ghost", "score": 1.0},
            {"id": "read_file", "score": 7.0},
            {"id": "read_file", "score": 0.1},
            {"id": "send_email", "score": math.nan},
        ]

    catalog = ToolCatalog(method="custom", retrieve_fn=fn)
    await catalog.register(TOOLS)
    hits = await catalog.search_async("q", 5)
    assert [(h.tool_id, h.score) for h in hits] == [("read_file", 1.0), ("send_email", 0.0)]


async def test_retrieve_fn_errors_propagate_and_bad_shapes_are_rejected() -> None:
    async def failing(_q: str, _c: list[RankCandidate], _k: int) -> list[RankedId]:
        raise RetrieverError("down", "Timeout", transient=True)

    catalog = ToolCatalog(method="custom", retrieve_fn=failing)
    await catalog.register(TOOLS)
    with pytest.raises(RetrieverError) as caught:
        await catalog.search_async("q", 3)
    assert caught.value.code == "Timeout"

    def wrong(_q: str, _c: list[RankCandidate], _k: int) -> Any:
        return {"id": "read_file"}

    bad = ToolCatalog(method="custom", retrieve_fn=wrong)
    await bad.register(TOOLS)
    with pytest.raises(TypeError, match="retrieve_fn must return"):
        await bad.search_async("q", 3)


async def test_no_call_for_an_empty_catalog_or_top_k_zero() -> None:
    fn = Scripted({"read_file": 1.0})
    assert await ToolCatalog(method="custom", retrieve_fn=fn).search_async("q", 3) == []
    full = ToolCatalog(method="custom", retrieve_fn=fn)
    await full.register(TOOLS)
    assert await full.search_async("q", 0) == []
    assert fn.calls == []


async def test_custom_is_async_only_and_a_per_call_method_bypasses_it() -> None:
    fn = Scripted({"send_email": 1.0})
    catalog = ToolCatalog(method="custom", retrieve_fn=fn)
    await catalog.register(TOOLS)
    with pytest.raises(RuntimeError, match="search_async"):
        catalog.search("q", 3)
    hits = await catalog.search_async("read a file", 2, method="bm25")
    assert hits[0].tool_id == "read_file"
    assert fn.calls == []


async def test_reranker_fn_reranks_stage_one_only_and_fills_top_k() -> None:
    query = "read a file from disk"
    stage_one = await _bm25_order(query, 50)
    last = stage_one[-1]
    fn = Scripted({last: 0.9, "not_a_tool": 1.0})
    catalog = ToolCatalog(reranker_fn=fn, trace=TraceSinkConfig(kind="memory", session_id="r"))
    await catalog.register(TOOLS)

    hits = await catalog.search_async(query, 3)

    assert [c.id for c in fn.calls[0][1]] == stage_one
    assert hits[0].tool_id == last
    assert [h.tool_id for h in hits[1:]] == [i for i in stage_one if i != last][:2]
    [event] = _searches(catalog)
    assert _stage_names(event) == ["bm25", "rerank"]


async def test_reranker_depth_caps_the_candidates_raised_to_top_k() -> None:
    fn = Scripted({})
    catalog = ToolCatalog(reranker_fn=fn, reranker_depth=1)
    await catalog.register(TOOLS)
    await catalog.search_async("file", 2)
    assert len(fn.calls[0][1]) == 2


async def test_a_transient_retriever_error_falls_back_to_stage_one() -> None:
    async def overloaded(_q: str, _c: list[RankCandidate], _k: int) -> list[RankedId]:
        raise RetrieverError("busy", "Overloaded", transient=True)

    catalog = ToolCatalog(
        reranker_fn=overloaded, trace=TraceSinkConfig(kind="memory", session_id="f")
    )
    await catalog.register(TOOLS)
    hits = await catalog.search_async("delete a file", 3)
    assert [h.tool_id for h in hits] == await _bm25_order("delete a file", 3)
    [event] = _searches(catalog)
    assert _stage_names(event) == ["bm25", "rerank_fallback:Overloaded"]


@pytest.mark.parametrize(
    "error",
    [RetrieverError("bad key", "Unauthorized", status=401), ValueError("boom")],
)
async def test_anything_else_a_reranker_raises_fails_the_search(error: Exception) -> None:
    async def failing(_q: str, _c: list[RankCandidate], _k: int) -> list[RankedId]:
        raise error

    catalog = ToolCatalog(reranker_fn=failing)
    await catalog.register(TOOLS)
    with pytest.raises(type(error)) as caught:
        await catalog.search_async("file", 3)
    assert caught.value is error


async def test_reranker_false_turns_the_reranker_fn_off_and_sync_search_refuses() -> None:
    fn = Scripted({"send_email": 1.0})
    catalog = ToolCatalog(reranker_fn=fn)
    await catalog.register(TOOLS)
    hits = await catalog.search_async("read a file", 3, reranker=False)
    assert [h.tool_id for h in hits] == await _bm25_order("read a file", 3)
    assert fn.calls == []
    with pytest.raises(RuntimeError, match="search_async"):
        catalog.search("q", 3)


async def test_turn_ids_reach_custom_and_reranked_searches() -> None:
    fn = Scripted({"send_email": 1.0})
    custom = ToolCatalog(
        method="custom", retrieve_fn=fn, trace=TraceSinkConfig(kind="memory", session_id="t")
    )
    await custom.register(TOOLS)
    await custom.search_async("q", 2, turn_id="turn-a")
    async with custom.turn("turn-b"):
        await custom.search_async("q", 2)
    assert [e.get("turn_id") for e in _searches(custom)] == ["turn-a", "turn-b"]

    reranked = ToolCatalog(reranker_fn=fn, trace=TraceSinkConfig(kind="memory", session_id="t"))
    await reranked.register(TOOLS)
    await reranked.search_async("file", 2, turn_id="turn-c")
    assert [e.get("turn_id") for e in _searches(reranked)] == ["turn-c"]


async def test_skills_are_offered_as_kind_skill() -> None:
    fn = Scripted({"api_design": 0.8})
    skills = SkillCatalog(method="custom", retrieve_fn=fn)
    await skills.register(
        [
            Skill(
                id="api_design", name="api_design", description="design rest endpoints", body="b"
            ),
            Skill(id="deploy", name="deploy", description="deploy a service", body="b"),
        ]
    )
    hits = await skills.search_async("design an api", 2)
    assert [h.skill_id for h in hits] == ["api_design"]
    assert {c.kind for c in fn.calls[0][1]} == {"skill"}


_FN = Scripted({})


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"method": "custom"}, "needs a retrieve_fn"),
        ({"retrieve_fn": _FN}, 'retrieve_fn needs method "custom"'),
        ({"reranker_fn": _FN, "reranker": {"method": "semantic"}}, "either reranker or"),
        ({"method": "custom", "retrieve_fn": _FN, "reranker_fn": _FN}, "reranker_fn needs"),
        ({"reranker_depth": 5}, "reranker_depth needs a reranker_fn"),
        ({"reranker_fn": _FN, "reranker_depth": 0}, "reranker_depth must be a positive"),
        ({"reranker_fn": "jev"}, "reranker_fn must be callable"),
        ({"reranker": {"method": "custom"}}, "for your own model use reranker_fn"),
    ],
)
def test_contradicting_options_are_rejected(kwargs: dict[str, Any], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        ToolCatalog(**kwargs)
    with pytest.raises(ValueError, match=message):
        SkillCatalog(**kwargs)


async def test_a_per_call_custom_method_needs_a_retrieve_fn() -> None:
    catalog = ToolCatalog()
    await catalog.register(TOOLS)
    with pytest.raises(ValueError, match="constructed with a retrieve_fn"):
        await catalog.search_async("q", 3, method="custom")
