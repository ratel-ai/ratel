"""Tests for SkillCatalog — mirrors `src/sdk/ts/src/skill-catalog.test.ts`."""

import pytest

from ratel_ai import Skill, SkillCatalog, TraceSinkConfig

_API_DESIGN = Skill(
    id="api-design",
    name="api-design",
    description="REST API design patterns: resource naming, status codes, pagination.",
    tags=["backend", "api"],
    body="# API Design\n\nUse nouns for resources.",
)


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


def test_upsert_replaces_an_existing_skill_and_reindexes_it() -> None:
    catalog = _catalog(_API_DESIGN)

    replaced = catalog.upsert(
        Skill(
            id="api-design",
            name="api-design",
            description="GraphQL schema modeling and federation.",
            tags=["graphql"],
            body="# GraphQL",
        )
    )

    assert replaced is True
    assert catalog.search("REST pagination", 5) == []
    assert catalog.search("GraphQL federation", 5)[0].skill_id == "api-design"
    assert "GraphQL" in catalog.get("api-design").description
    assert catalog.invoke("api-design") == "# GraphQL"


def test_upsert_of_a_new_id_registers_it_and_reports_no_replacement() -> None:
    catalog = SkillCatalog()
    assert catalog.upsert(_API_DESIGN) is False
    assert catalog.has("api-design")


def test_remove_drops_the_skill_from_search_and_membership() -> None:
    catalog = _catalog(_API_DESIGN)

    assert catalog.remove("api-design") is True
    assert catalog.remove("api-design") is False
    assert not catalog.has("api-design")
    assert catalog.search("REST API", 5) == []


def test_on_change_fires_on_register_upsert_remove_until_unsubscribed() -> None:
    catalog = SkillCatalog()
    fired = 0

    def listener() -> None:
        nonlocal fired
        fired += 1

    unsubscribe = catalog.on_change(listener)

    catalog.register(_API_DESIGN)
    catalog.upsert(Skill(id="slides", name="slides", description="Build HTML presentations."))
    catalog.remove("api-design")
    assert fired == 3

    unsubscribe()
    catalog.remove("slides")
    assert fired == 3


def test_stamps_the_surfacing_skill_searchs_id_onto_the_invoke_that_follows() -> None:
    catalog = SkillCatalog(trace=TraceSinkConfig(kind="memory", session_id="t"))
    catalog.register(_API_DESIGN)
    catalog.drain_trace_events()

    outcome = catalog.search_traced("REST API design", 5, "agent")
    catalog.invoke("api-design")

    events = catalog.drain_trace_events()
    invoke = next(e for e in events if e["type"] == "skill_invoke")
    assert invoke["search_id"] == outcome.search_id
