"""Tests for the grounding freshness planner — mirrors `src/sdk/ts/src/grounding.test.ts`."""

import re

from ratel_ai.experimental import (
    FactCandidate,
    GroundingItem,
    GroundingResult,
    InjectionDecision,
    InjectionPolicy,
    LedgerEntry,
    fact_hash,
    grounding_marker,
    plan_injection,
    read_grounding_ledger,
)


def cand(fact_id: str, body_hash: str) -> FactCandidate:
    return FactCandidate(fact_id, body_hash)


def entry(fact_id: str, body_hash: str, distance: int) -> LedgerEntry:
    return LedgerEntry(fact_id, body_hash, distance)


# --- plan_injection -------------------------------------------------------


def test_injects_absent_fact_as_never_with_no_history() -> None:
    (decision,) = plan_injection([cand("a", "h1")], [])
    assert decision == InjectionDecision("a", True, "never")


def test_distinguishes_evicted_from_never_via_ever_injected() -> None:
    out = plan_injection(
        [cand("seen", "h1"), cand("unseen", "h2")],
        [],
        ever_injected={"seen"},
    )
    assert out == [
        InjectionDecision("seen", True, "evicted"),
        InjectionDecision("unseen", True, "never"),
    ]


def test_skips_present_unchanged_fact_as_fresh() -> None:
    (decision,) = plan_injection([cand("a", "h1")], [entry("a", "h1", 3)])
    assert decision == InjectionDecision("a", False, "fresh")


def test_reinjects_changed_body_as_mutated() -> None:
    (decision,) = plan_injection([cand("a", "h2")], [entry("a", "h1", 1)])
    assert decision == InjectionDecision("a", True, "mutated")


def test_does_not_reinject_on_distance_alone_by_default() -> None:
    (decision,) = plan_injection([cand("a", "h1")], [entry("a", "h1", 9999)])
    assert decision.inject is False
    assert decision.reason == "fresh"


def test_reinjects_as_stale_once_past_explicit_window() -> None:
    within = plan_injection(
        [cand("a", "h1")], [entry("a", "h1", 10)], policy=InjectionPolicy(freshness_window=10)
    )
    assert within[0].inject is False  # distance == window is still fresh

    beyond = plan_injection(
        [cand("a", "h1")], [entry("a", "h1", 11)], policy=InjectionPolicy(freshness_window=10)
    )
    assert beyond[0] == InjectionDecision("a", True, "stale")


def test_mutation_wins_over_staleness() -> None:
    (decision,) = plan_injection(
        [cand("a", "h2")], [entry("a", "h1", 100)], policy=InjectionPolicy(freshness_window=10)
    )
    assert decision.reason == "mutated"


def test_judges_id_by_freshest_marker() -> None:
    # An old buried copy (h1@50) and a newer copy (h2@1): the newer copy is
    # current, so an h2 candidate is fresh, not mutated.
    (decision,) = plan_injection(
        [cand("a", "h2")], [entry("a", "h1", 50), entry("a", "h2", 1)]
    )
    assert decision == InjectionDecision("a", False, "fresh")


def test_is_order_preserving_and_deterministic() -> None:
    candidates = [cand("a", "h1"), cand("b", "h2"), cand("c", "h3")]
    ledger = [entry("b", "h2", 2)]
    first = plan_injection(candidates, ledger)
    second = plan_injection(candidates, ledger)
    assert [d.id for d in first] == ["a", "b", "c"]
    assert first == second


def test_returns_empty_plan_for_no_candidates() -> None:
    assert plan_injection([], [entry("a", "h1", 0)]) == []


# --- fact_hash ------------------------------------------------------------


def test_fact_hash_is_stable_for_same_body() -> None:
    assert fact_hash("12 Baker Street") == fact_hash("12 Baker Street")


def test_fact_hash_changes_when_body_changes() -> None:
    assert fact_hash("Mon–Fri 9–6") != fact_hash("Mon–Sat 9–8")


def test_fact_hash_is_fixed_width_lowercase_hex() -> None:
    assert re.fullmatch(r"[0-9a-f]{16}", fact_hash("anything"))


# --- grounding marker codec ----------------------------------------------


def test_marker_round_trips_distance_zero_at_end() -> None:
    h = fact_hash("12 Baker Street, London")
    texts = ["earlier turn", f"Shop address. {grounding_marker('shop-address', h)}"]
    assert read_grounding_ledger(texts) == [LedgerEntry("shop-address", h, 0)]


def test_marker_distance_is_messages_from_end() -> None:
    texts = [grounding_marker("a", "aaaaaaaaaaaa"), "middle", "latest"]
    (e,) = read_grounding_ledger(texts)
    assert e == LedgerEntry("a", "aaaaaaaaaaaa", 2)


def test_marker_keeps_freshest_when_injected_twice() -> None:
    texts = [
        f"old {grounding_marker('a', '111111111111')}",
        "gap",
        f"new {grounding_marker('a', '222222222222')}",
    ]
    assert read_grounding_ledger(texts) == [LedgerEntry("a", "222222222222", 0)]


def test_marker_reads_multiple_markers_in_one_message() -> None:
    line = f"{grounding_marker('a', 'aaaaaaaaaaaa')} and {grounding_marker('b', 'bbbbbbbbbbbb')}"
    ledger = read_grounding_ledger([line])
    assert sorted(e.id for e in ledger) == ["a", "b"]
    assert all(e.distance == 0 for e in ledger)


def test_marker_empty_ledger_when_no_markers() -> None:
    assert read_grounding_ledger(["hello", "world"]) == []


def test_marker_ignores_near_miss_text() -> None:
    assert read_grounding_ledger(["ratel:fact id=a v=zzz (not bracketed)"]) == []


# --- plan_injection over a real transcript (end-to-end) -------------------

_BODY = "Open Mon–Sat, 9am–7pm."
_H = fact_hash(_BODY)
_INJECTED = f"Hours. {grounding_marker('hours', _H)}"


def test_e2e_skips_fact_already_present_and_fresh() -> None:
    ledger = read_grounding_ledger(["user asks something", _INJECTED])
    (decision,) = plan_injection([cand("hours", _H)], ledger)
    assert decision.inject is False


def test_e2e_reinjects_after_body_edit() -> None:
    ledger = read_grounding_ledger(["user asks something", _INJECTED])
    new_hash = fact_hash("Open Mon–Sun, 8am–8pm.")
    (decision,) = plan_injection([cand("hours", new_hash)], ledger)
    assert decision == InjectionDecision("hours", True, "mutated")


def test_e2e_reinjects_after_compaction_drops_marker() -> None:
    ledger = read_grounding_ledger(["summary of the conversation so far"])
    (decision,) = plan_injection([cand("hours", _H)], ledger, ever_injected={"hours"})
    assert decision == InjectionDecision("hours", True, "evicted")


# --- dataclass wiring -----------------------------------------------------


def test_grounding_item_and_result_carry_marker_and_reason() -> None:
    # The structured items a grounding pass would return: body + marker + reason.
    body = "12 Baker Street, London."
    marker = grounding_marker("shop-address", fact_hash(body))
    item = GroundingItem(
        id="shop-address",
        body=body,
        marker=marker,
        text=f"{body}\n{marker}",
        reason="never",
        pin="always",
    )
    result = GroundingResult(inject=[item], skipped=["cancellation"])
    assert result.inject[0].marker.startswith("⟦ratel:fact id=shop-address")
    assert result.skipped == ["cancellation"]
