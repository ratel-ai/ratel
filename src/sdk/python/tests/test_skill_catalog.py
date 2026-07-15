"""Tests for SkillCatalog — mirrors `src/sdk/ts/src/skill-catalog.test.ts`."""

import asyncio
import threading

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


def test_semantic_skill_registration_is_metadata_only() -> None:
    catalog = SkillCatalog(method="semantic", embedding={"local": "/missing/ratel-model"})

    catalog.register(Skill(id="s", name="s", description="Skill"))

    assert catalog.has("s")


def test_skill_catalog_register_many() -> None:
    catalog = SkillCatalog()
    catalog.register_many(
        [
            Skill(id="auth", name="auth", description="Set up login"),
            Skill(id="deploy", name="deploy", description="Deploy an app"),
        ]
    )

    assert catalog.size() == 2


def test_skill_register_many_validation_failure_commits_nothing() -> None:
    catalog = SkillCatalog()
    invalid = Skill(
        id="invalid",
        name="invalid",
        description="Invalid metadata",
        metadata={"bad": [object()]},  # type: ignore[list-item]
    )

    with pytest.raises((TypeError, ValueError)):
        catalog.register_many(
            [Skill(id="auth", name="auth", description="Set up authentication"), invalid]
        )

    assert catalog.size() == 0
    assert catalog.search("authentication", 5) == []


def test_synchronous_dense_skill_search_points_to_search_async() -> None:
    catalog = SkillCatalog(method="semantic", embedding={"local": "/missing/ratel-model"})
    catalog.register(Skill(id="s", name="s", description="Skill"))

    with pytest.raises(RuntimeError, match=r"await .*search_async"):
        catalog.search("skill", 5)


async def test_skill_catalog_async_embedding_lifecycle() -> None:
    catalog = SkillCatalog(method="semantic")

    await catalog.build_embeddings()
    await catalog.rebuild_embeddings()

    assert await catalog.search_async("anything", 5) == []


async def test_nonempty_skill_async_search_and_busy_registration(
    controlled_embedding_endpoint: tuple[str, threading.Event, threading.Event],
) -> None:
    endpoint, request_started, send_response = controlled_embedding_endpoint
    catalog = SkillCatalog(
        method="semantic", embedding={"url": endpoint, "model": "test-model"}
    )
    catalog.register(Skill(id="auth", name="auth", description="Set up authentication"))
    build = asyncio.create_task(catalog.build_embeddings())
    for _ in range(200):
        if request_started.is_set():
            break
        await asyncio.sleep(0.01)
    assert request_started.is_set()
    try:
        with pytest.raises(RuntimeError, match=r"^registry busy; await the active operation$"):
            catalog.register(Skill(id="deploy", name="deploy", description="Deploy an app"))
    finally:
        send_response.set()
    await build

    hits = await catalog.search_async("authentication", 5)
    assert hits[0].skill_id == "auth"
