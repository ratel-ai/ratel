"""Tests for SkillCatalog — mirrors `src/sdk/ts/src/skill-catalog.test.ts`."""

import pytest

from ratel_ai import Skill, SkillCatalog


def _catalog(*skills: Skill) -> SkillCatalog:
    c = SkillCatalog()
    for s in skills:
        c.register(s)
    return c


def test_ranks_by_relevance_and_round_trips_metadata() -> None:
    catalog = _catalog(
        Skill(
            id="supabase-auth",
            name="supabase-auth",
            description="Supabase auth: sessions, RLS, SSR client.",
            tags=["login", "sign in"],
            metadata={"stacks": ["supabase"]},
        ),
        Skill(id="vercel-deploy", name="vercel-deploy", description="Deploy to Vercel."),
    )
    hits = catalog.search("set up login", 5, "agent")
    assert hits[0].skill_id == "supabase-auth"
    assert catalog.has("supabase-auth")
    assert catalog.get("supabase-auth").metadata == {"stacks": ["supabase"]}
    assert catalog.size() == 2


def test_invoke_returns_body_and_records_event() -> None:
    catalog = SkillCatalog()
    catalog.register(Skill(id="s", name="s", description="d", body="# Body\n\nsteps"))
    assert "steps" in catalog.invoke("s")


def test_invoke_unknown_id_raises() -> None:
    catalog = SkillCatalog()
    with pytest.raises(ValueError, match="unknown skillId"):
        catalog.invoke("nope")


def test_minimal_skill_without_tags_or_body() -> None:
    # A minimal skill (no tags/body) is valid in both SDKs; body defaults to "".
    catalog = SkillCatalog()
    catalog.register(Skill(id="min", name="min", description="a minimal skill, no tags or body"))
    assert catalog.has("min")
    assert catalog.invoke("min") == ""
    assert catalog.search("minimal", 5)[0].skill_id == "min"


def test_upsert_returns_false_for_new_and_true_for_replace() -> None:
    catalog = SkillCatalog()
    skill = Skill(id="s", name="s", description="REST API design")
    assert catalog.upsert(skill) is False
    assert catalog.upsert(Skill(id="s", name="s", description="d", body="# Updated")) is True
    assert catalog.size() == 1
    assert catalog.get("s").body == "# Updated"


def test_remove_drops_the_skill_and_returns_presence() -> None:
    catalog = _catalog(
        Skill(id="slides", name="slides", description="Animation-rich HTML presentations."),
        Skill(id="api", name="api", description="REST API design."),
    )
    assert catalog.remove("slides") is True
    assert not catalog.has("slides")
    assert catalog.size() == 1
    hits = catalog.search("animation-rich HTML presentations", 5)
    assert all(h.skill_id != "slides" for h in hits)
    assert catalog.remove("slides") is False


def test_remove_emits_skill_churn_remove_event() -> None:
    from ratel_ai import TraceSinkConfig

    catalog = SkillCatalog(trace=TraceSinkConfig(kind="memory", session_id="t"))
    catalog.register(Skill(id="s", name="s", description="d"))
    catalog.drain_trace_events()

    catalog.remove("s")

    events = catalog.drain_trace_events()
    churn = [e for e in events if e["type"] == "skill_churn"]
    assert len(churn) == 1
    assert churn[0]["kind"] == "remove"
    assert churn[0]["skill_id"] == "s"


def test_on_change_fires_on_register_upsert_remove_and_unsubscribes() -> None:
    catalog = SkillCatalog()
    calls = []
    unsubscribe = catalog.on_change(lambda: calls.append(1))

    catalog.register(Skill(id="s", name="s", description="d"))
    assert len(calls) == 1
    catalog.upsert(Skill(id="s", name="s", description="d", body="# Updated"))
    assert len(calls) == 2
    catalog.remove("s")
    assert len(calls) == 3

    unsubscribe()
    catalog.register(Skill(id="t", name="t", description="d"))
    assert len(calls) == 3


def test_on_change_does_not_fire_for_unknown_remove() -> None:
    catalog = SkillCatalog()
    calls = []
    catalog.on_change(lambda: calls.append(1))
    assert catalog.remove("missing") is False
    assert calls == []


def test_on_change_same_listener_twice_fires_once() -> None:
    catalog = SkillCatalog()
    calls = []

    def listener() -> None:
        calls.append(1)

    catalog.on_change(listener)
    catalog.on_change(listener)
    catalog.register(Skill(id="s", name="s", description="d"))
    assert len(calls) == 1


def test_throwing_listener_breaks_neither_mutation_nor_siblings() -> None:
    catalog = SkillCatalog()
    calls = []

    def bad() -> None:
        raise RuntimeError("bad subscriber")

    catalog.on_change(bad)
    catalog.on_change(lambda: calls.append(1))

    catalog.register(Skill(id="s", name="s", description="d"))
    assert len(calls) == 1
    assert catalog.has("s")


def test_re_register_replaces_in_place() -> None:
    # Re-registering an id replaces it in the native corpus, not appends a
    # duplicate: the id ranks once and the latest metadata wins (RAT-378).
    catalog = SkillCatalog()
    catalog.register(Skill(id="s", name="s", description="REST API design", tags=["api"]))
    catalog.register(
        Skill(
            id="s",
            name="s",
            description="Build animation-rich HTML presentations from scratch.",
            tags=["frontend"],
            body="# Slides\n\nUpdated body.",
        )
    )
    assert catalog.size() == 1
    hits = catalog.search("animation-rich HTML presentations", 10)
    assert [h.skill_id for h in hits].count("s") == 1
    assert catalog.get("s").body == "# Slides\n\nUpdated body."
