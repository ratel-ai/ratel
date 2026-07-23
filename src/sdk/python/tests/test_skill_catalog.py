"""Tests for SkillCatalog — mirrors `src/sdk/ts/src/skill-catalog.test.ts`."""

import asyncio
import threading

import pytest

from ratel_ai import Skill, SkillCatalog, SkillRegistry


async def _catalog(*skills: Skill) -> SkillCatalog:
    c = SkillCatalog()
    for s in skills:
        await c.register(s)
    return c


async def test_skill_removed_methods_are_gone() -> None:
    # register_many / build_embeddings / rebuild_embeddings were folded into
    # the variadic, self-embedding `register` (RAT-379/async-register).
    for obj in (SkillCatalog(), SkillRegistry()):
        assert not hasattr(obj, "register_many")
        assert not hasattr(obj, "build_embeddings")
        assert not hasattr(obj, "rebuild_embeddings")


async def test_ranks_by_relevance_and_round_trips_metadata() -> None:
    catalog = await _catalog(
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


async def test_invoke_returns_body_and_records_event() -> None:
    catalog = SkillCatalog()
    await catalog.register(Skill(id="s", name="s", description="d", body="# Body\n\nsteps"))
    assert "steps" in catalog.invoke("s")


def test_invoke_unknown_id_raises() -> None:
    catalog = SkillCatalog()
    with pytest.raises(ValueError, match="unknown skillId"):
        catalog.invoke("nope")


async def test_minimal_skill_without_tags_or_body() -> None:
    # A minimal skill (no tags/body) is valid in both SDKs; body defaults to "".
    catalog = SkillCatalog()
    await catalog.register(
        Skill(id="min", name="min", description="a minimal skill, no tags or body")
    )
    assert catalog.has("min")
    assert catalog.invoke("min") == ""
    assert catalog.search("minimal", 5)[0].skill_id == "min"


async def test_upsert_returns_false_for_new_and_true_for_replace() -> None:
    catalog = SkillCatalog()
    skill = Skill(id="s", name="s", description="REST API design")
    assert await catalog.upsert(skill) is False
    assert await catalog.upsert(Skill(id="s", name="s", description="d", body="# Updated")) is True
    assert catalog.size() == 1
    assert catalog.get("s").body == "# Updated"


async def test_remove_drops_the_skill_and_returns_presence() -> None:
    catalog = await _catalog(
        Skill(id="slides", name="slides", description="Animation-rich HTML presentations."),
        Skill(id="api", name="api", description="REST API design."),
    )
    assert catalog.remove("slides") is True
    assert not catalog.has("slides")
    assert catalog.size() == 1
    hits = catalog.search("animation-rich HTML presentations", 5)
    assert all(h.skill_id != "slides" for h in hits)
    assert catalog.remove("slides") is False


async def test_remove_emits_skill_churn_remove_event() -> None:
    from ratel_ai import TraceSinkConfig

    catalog = SkillCatalog(trace=TraceSinkConfig(kind="memory", session_id="t"))
    await catalog.register(Skill(id="s", name="s", description="d"))
    catalog.drain_trace_events()

    catalog.remove("s")

    events = catalog.drain_trace_events()
    churn = [e for e in events if e["type"] == "skill_churn"]
    assert len(churn) == 1
    assert churn[0]["kind"] == "remove"
    assert churn[0]["skill_id"] == "s"


async def test_on_change_fires_on_register_upsert_remove_and_unsubscribes() -> None:
    catalog = SkillCatalog()
    calls = []
    unsubscribe = catalog.on_change(lambda: calls.append(1))

    await catalog.register(Skill(id="s", name="s", description="d"))
    assert len(calls) == 1
    await catalog.upsert(Skill(id="s", name="s", description="d", body="# Updated"))
    assert len(calls) == 2
    catalog.remove("s")
    assert len(calls) == 3

    unsubscribe()
    await catalog.register(Skill(id="t", name="t", description="d"))
    assert len(calls) == 3


def test_on_change_does_not_fire_for_unknown_remove() -> None:
    catalog = SkillCatalog()
    calls = []
    catalog.on_change(lambda: calls.append(1))
    assert catalog.remove("missing") is False
    assert calls == []


async def test_on_change_same_listener_twice_fires_once() -> None:
    catalog = SkillCatalog()
    calls = []

    def listener() -> None:
        calls.append(1)

    catalog.on_change(listener)
    catalog.on_change(listener)
    await catalog.register(Skill(id="s", name="s", description="d"))
    assert len(calls) == 1


async def test_notifies_even_when_embedding_fails_mid_register() -> None:
    # On a semantic catalog metadata is indexed before the embedding pass; if
    # the embedder then fails, the error propagates when awaited but the
    # staleness hook must still fire — the host has a committed mutation.
    class _FailingBuild:
        def __init__(self, inner: object) -> None:
            self._inner = inner

        def __getattr__(self, name: str) -> object:
            return getattr(self._inner, name)

        def _build_tracked(self, has_items: bool) -> object:
            async def _boom() -> None:
                raise RuntimeError("stub embed failure")

            return _boom()

    catalog = SkillCatalog(method="semantic")
    catalog._registry = _FailingBuild(catalog._registry)  # type: ignore[assignment]
    calls = []
    catalog.on_change(lambda: calls.append(1))

    with pytest.raises(RuntimeError, match="stub embed failure"):
        await catalog.register(Skill(id="s", name="s", description="d"))
    assert catalog.has("s")
    assert len(calls) == 1


async def test_listener_unsubscribing_itself_mid_notify_is_isolated() -> None:
    catalog = SkillCatalog()
    sibling_calls = []
    unsubscribes = []

    def self_removing() -> None:
        unsubscribes[0]()

    unsubscribes.append(catalog.on_change(self_removing))
    catalog.on_change(lambda: sibling_calls.append(1))

    await catalog.register(Skill(id="s", name="s", description="d"))
    assert len(sibling_calls) == 1
    await catalog.register(Skill(id="t", name="t", description="d"))
    assert len(sibling_calls) == 2


async def test_listener_subscribed_mid_notify_fires_on_next_mutation() -> None:
    catalog = SkillCatalog()
    late_calls = []
    subscribed = []

    def subscriber() -> None:
        if not subscribed:
            subscribed.append(True)
            catalog.on_change(lambda: late_calls.append(1))

    catalog.on_change(subscriber)
    await catalog.register(Skill(id="s", name="s", description="d"))
    assert late_calls == []
    await catalog.register(Skill(id="t", name="t", description="d"))
    assert len(late_calls) == 1


async def test_listeners_observe_settled_post_mutation_state() -> None:
    catalog = SkillCatalog()
    seen = []
    catalog.on_change(lambda: seen.append((catalog.size(), catalog.has("s"))))

    await catalog.register(Skill(id="s", name="s", description="d"))
    catalog.remove("s")
    assert seen == [(1, True), (0, False)]


async def test_throwing_listener_breaks_neither_mutation_nor_siblings() -> None:
    catalog = SkillCatalog()
    calls = []

    def bad() -> None:
        raise RuntimeError("bad subscriber")

    catalog.on_change(bad)
    catalog.on_change(lambda: calls.append(1))

    await catalog.register(Skill(id="s", name="s", description="d"))
    assert len(calls) == 1
    assert catalog.has("s")


async def test_re_register_replaces_in_place() -> None:
    # Re-registering an id replaces it in the native corpus, not appends a
    # duplicate: the id ranks once and the latest metadata wins (RAT-378).
    catalog = SkillCatalog()
    await catalog.register(Skill(id="s", name="s", description="REST API design", tags=["api"]))
    await catalog.register(
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


async def test_semantic_skill_registration_embeds_and_search_finds_hit(
    delayed_embedding_endpoint: str,
) -> None:
    # Registration on a semantic/hybrid catalog now embeds eagerly (inside
    # `register`), so "metadata only" no longer holds — prove the end-to-end
    # effect instead: search_async finds the hit right after registration.
    catalog = SkillCatalog(
        method="semantic",
        embedding={"url": delayed_embedding_endpoint, "model": "test-model"},
    )

    await catalog.register(Skill(id="s", name="s", description="Skill"))

    assert catalog.has("s")
    hits = await catalog.search_async("skill", 5)
    assert hits[0].skill_id == "s"


async def test_unawaited_skill_register_commits_bm25_metadata_synchronously() -> None:
    # Metadata is indexed the instant register() is called; a forgotten `await`
    # never drops the corpus. BM25 search finds the skill without awaiting.
    catalog = SkillCatalog()
    pending = catalog.register(Skill(id="deploy", name="deploy", description="Deploy an app"))
    assert catalog.has("deploy")
    assert catalog.search("deploy an app", 5)[0].skill_id == "deploy"
    await pending  # drain the no-op awaitable


async def test_unawaited_semantic_skill_register_raises_on_dense_search(
    delayed_embedding_endpoint: str,
) -> None:
    # A forgotten `await` on a semantic skill catalog is caught at the next dense
    # search with an await-specific message; awaiting the build recovers.
    catalog = SkillCatalog(
        method="semantic",
        embedding={"url": delayed_embedding_endpoint, "model": "test-model"},
    )
    pending = catalog.register(Skill(id="s", name="s", description="Skill"))

    assert catalog.has("s")
    with pytest.raises(RuntimeError, match="was not awaited"):
        await catalog.search_async("skill", 5)

    await pending
    hits = await catalog.search_async("skill", 5)
    assert hits[0].skill_id == "s"


async def test_skill_catalog_register_accepts_an_iterable() -> None:
    catalog = SkillCatalog()
    await catalog.register(
        [
            Skill(id="auth", name="auth", description="Set up login"),
            Skill(id="deploy", name="deploy", description="Deploy an app"),
        ]
    )

    assert catalog.size() == 2


async def test_skill_register_iterable_validation_failure_commits_nothing() -> None:
    catalog = SkillCatalog()
    invalid = Skill(
        id="invalid",
        name="invalid",
        description="Invalid metadata",
        metadata={"bad": [object()]},  # type: ignore[list-item]
    )

    with pytest.raises((TypeError, ValueError)):
        await catalog.register(
            [Skill(id="auth", name="auth", description="Set up authentication"), invalid]
        )

    assert catalog.size() == 0
    assert catalog.search("authentication", 5) == []


def test_synchronous_dense_skill_search_points_to_search_async() -> None:
    # search() rejects a resolved semantic/hybrid method before ever touching
    # the registry, so this needs no registration (and no working model).
    catalog = SkillCatalog(method="semantic", embedding={"local": "/missing/ratel-model"})

    with pytest.raises(RuntimeError, match=r"await .*search_async"):
        catalog.search("skill", 5)


async def test_skill_catalog_register_empty_batch_on_semantic_is_a_noop() -> None:
    # Empty corpus short-circuits before any embedder load, even for the eager
    # per-register build a semantic/hybrid catalog now runs.
    catalog = SkillCatalog(method="semantic", embedding={"local": "/missing/ratel-model"})
    await catalog.register([])  # no skills → no model load, must not raise
    assert catalog.size() == 0


async def test_nonempty_skill_async_search_and_busy_registration(
    controlled_embedding_endpoint: tuple[str, threading.Event, threading.Event],
) -> None:
    endpoint, request_started, send_response = controlled_embedding_endpoint
    catalog = SkillCatalog(
        method="semantic", embedding={"url": endpoint, "model": "test-model"}
    )
    register = asyncio.create_task(
        catalog.register(Skill(id="auth", name="auth", description="Set up authentication"))
    )
    for _ in range(200):
        if request_started.is_set():
            break
        await asyncio.sleep(0.01)
    assert request_started.is_set()
    try:
        with pytest.raises(RuntimeError, match=r"^registry busy; await the active operation$"):
            await catalog.register(Skill(id="deploy", name="deploy", description="Deploy an app"))
    finally:
        send_response.set()
    await register

    hits = await catalog.search_async("authentication", 5)
    assert hits[0].skill_id == "auth"
