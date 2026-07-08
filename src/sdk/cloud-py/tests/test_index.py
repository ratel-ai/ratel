"""Package entry points: `create_skill_sync` (offline-tolerant handle) and
`sync_skills` (one-shot, raising), with explicit options beating the
`RATEL_URL` / `RATEL_API_KEY` environment."""

from __future__ import annotations

import time
from collections.abc import Iterator
from typing import Any

import pytest
from ratel_ai import SkillCatalog

import ratel_ai_cloud
from ratel_ai_cloud import SkillSync, SyncResult, create_skill_sync, sync_skills
from ratel_ai_cloud.errors import ConfigError, UnavailableError
from ratel_ai_cloud.testing.mock_source import MockSource

API_KEY = "test-key"


@pytest.fixture()
def source() -> Iterator[MockSource]:
    with MockSource(api_key=API_KEY) as src:
        src.set_skills([_wire("a")])
        yield src


def _wire(skill_id: str) -> dict[str, Any]:
    return {
        "id": skill_id,
        "name": f"{skill_id}-name",
        "description": f"{skill_id} description",
        "tags": [],
        "tools": [],
        "metadata": {},
        "body": f"# {skill_id}\n",
    }


def test_public_surface() -> None:
    for name in ("create_skill_sync", "sync_skills", "SkillSync", "SyncResult"):
        assert name in ratel_ai_cloud.__all__
        assert hasattr(ratel_ai_cloud, name)


def test_sync_skills_one_shot(source: MockSource) -> None:
    catalog = SkillCatalog()
    result = sync_skills(catalog, url=source.url, api_key=API_KEY, env={})
    assert result == SyncResult(added=1, updated=0, removed=0, conflicts=[], unchanged=False)
    assert catalog.has("a")


def test_sync_skills_raises_on_failure(source: MockSource) -> None:
    source.inject_failure(503, code="unavailable")
    with pytest.raises(UnavailableError):
        sync_skills(SkillCatalog(), url=source.url, api_key=API_KEY, env={})


def test_no_url_anywhere_raises_config_error() -> None:
    with pytest.raises(ConfigError):
        sync_skills(SkillCatalog(), env={})
    with pytest.raises(ConfigError):
        create_skill_sync(SkillCatalog(), env={})


def test_env_resolution_and_explicit_precedence(source: MockSource) -> None:
    catalog = SkillCatalog()
    env = {"RATEL_URL": source.url, "RATEL_API_KEY": API_KEY}
    assert sync_skills(catalog, env=env).added == 1

    # Explicit options beat the environment.
    bad_env = {"RATEL_URL": "http://127.0.0.1:1", "RATEL_API_KEY": "nope"}
    result = sync_skills(SkillCatalog(), url=source.url, api_key=API_KEY, env=bad_env)
    assert result.added == 1


def test_create_skill_sync_hydrates_and_returns_the_handle(source: MockSource) -> None:
    catalog = SkillCatalog()
    sync = create_skill_sync(catalog, url=source.url, api_key=API_KEY, env={})
    assert isinstance(sync, SkillSync)
    assert catalog.has("a")
    assert sync.owned_count == 1
    assert sync.last_synced_at is not None
    sync.stop()


def test_create_skill_sync_scope_is_passed_through(source: MockSource) -> None:
    catalog = SkillCatalog()
    sync = create_skill_sync(catalog, url=source.url, api_key=API_KEY, scope="alice", env={})
    assert source.requests[-1].scope == "alice"
    sync.stop()


def test_create_skill_sync_is_offline_tolerant(source: MockSource) -> None:
    source.inject_failure(503, code="unavailable")
    catalog = SkillCatalog()
    sync = create_skill_sync(catalog, url=source.url, api_key=API_KEY, env={})
    assert catalog.size() == 0
    assert sync.consecutive_failures == 1
    assert sync.last_synced_at is None
    # The source comes back: a manual refresh hydrates.
    sync.refresh()
    assert catalog.has("a")
    sync.stop()


def test_create_skill_sync_with_interval_keeps_refreshing(source: MockSource) -> None:
    catalog = SkillCatalog()
    sync = create_skill_sync(catalog, url=source.url, api_key=API_KEY, interval_s=0.02, env={})
    try:
        source.set_skills([_wire("a"), _wire("b")])
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and not catalog.has("b"):
            time.sleep(0.01)
        assert catalog.has("b")
    finally:
        sync.stop()


def test_create_skill_sync_does_not_start_a_chain_after_auth_failure(source: MockSource) -> None:
    source.inject_failure(401, code="unauthorized", times=10_000)
    catalog = SkillCatalog()
    sync = create_skill_sync(catalog, url=source.url, api_key=API_KEY, interval_s=0.02, env={})
    assert sync.consecutive_failures == 1
    requests_seen = len(source.requests)
    time.sleep(0.15)
    assert len(source.requests) == requests_seen
    sync.stop()
