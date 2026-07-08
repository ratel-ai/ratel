"""`SkillSync`: refresh diffing under the ownership rule, 304 revalidation,
and the jittered timer chain — against the conformant `MockSource`."""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from datetime import datetime
from typing import Any

import pytest
from ratel_ai import Skill, SkillCatalog, SourceConfig

from ratel_ai_cloud.errors import UnavailableError
from ratel_ai_cloud.fetch_catalog import FetchCatalogResult, fetch_catalog
from ratel_ai_cloud.skill_sync import SkillSync, SyncResult, _jittered_interval
from ratel_ai_cloud.testing.mock_source import MockSource

API_KEY = "test-key"


@pytest.fixture()
def source() -> Iterator[MockSource]:
    with MockSource(api_key=API_KEY) as src:
        yield src


def _config(source: MockSource, scope: str | None = None) -> SourceConfig:
    return SourceConfig(url=source.url, api_key=API_KEY, scope=scope)


def _wire(skill_id: str, body: str | None = None, **extra: Any) -> dict[str, Any]:
    return {
        "id": skill_id,
        "name": f"{skill_id}-name",
        "description": f"{skill_id} description",
        "tags": ["t"],
        "tools": [],
        "metadata": {},
        "body": body if body is not None else f"# {skill_id}\n",
        **extra,
    }


def _wait_until(predicate: Any, timeout_s: float = 5.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition not reached in time")


def test_refresh_hydrates_and_projects_to_the_seven_fields(source: MockSource) -> None:
    source.set_skills([_wire("a"), _wire("b")])
    catalog = SkillCatalog()
    sync = SkillSync(catalog, _config(source))

    result = sync.refresh()
    assert result == SyncResult(added=2, updated=0, removed=0, conflicts=[], unchanged=False)
    assert catalog.size() == 2
    skill = catalog.get("a")
    assert isinstance(skill, Skill)
    assert skill.name == "a-name"
    assert skill.body == "# a\n"
    assert sync.owned_count == 2
    assert isinstance(sync.last_synced_at, datetime)
    assert sync.consecutive_failures == 0


def test_refresh_is_serialized_by_a_lock(source: MockSource) -> None:
    active = 0
    max_active = 0

    def slow_fetch(config: SourceConfig, etag: str | None) -> FetchCatalogResult:
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        time.sleep(0.05)
        result = fetch_catalog(config, etag)
        active -= 1
        return result

    source.set_skills([_wire("a")])
    catalog = SkillCatalog()
    sync = SkillSync(catalog, _config(source), fetch_impl=slow_fetch)
    threads = [threading.Thread(target=sync.refresh) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert max_active == 1
    assert catalog.size() == 1


def test_identical_resync_emits_zero_churn(source: MockSource) -> None:
    source.set_skills([_wire("a"), _wire("b")])
    catalog = SkillCatalog()
    # Drop the cached etag so the resync takes the 200 path (not a 304): the
    # idempotence gate must hold even on a full re-download of identical data.
    sync = SkillSync(
        catalog, _config(source), fetch_impl=lambda config, etag: fetch_catalog(config, None)
    )
    sync.refresh()

    churn: list[None] = []
    catalog.on_change(lambda: churn.append(None))
    result = sync.refresh()
    assert churn == []
    assert result == SyncResult(added=0, updated=0, removed=0, conflicts=[], unchanged=False)


def test_upserts_only_the_skill_whose_projection_changed(source: MockSource) -> None:
    source.set_skills([_wire("a"), _wire("b")])
    catalog = SkillCatalog()
    sync = SkillSync(catalog, _config(source))
    sync.refresh()

    source.set_skills([_wire("a", body="changed\n"), _wire("b")])
    result = sync.refresh()
    assert result == SyncResult(added=0, updated=1, removed=0, conflicts=[], unchanged=False)
    skill = catalog.get("a")
    assert skill is not None and skill.body == "changed\n"


def test_wire_noise_fields_do_not_defeat_the_idempotence_gate(source: MockSource) -> None:
    source.set_skills([_wire("a")])
    catalog = SkillCatalog()
    sync = SkillSync(
        catalog, _config(source), fetch_impl=lambda config, etag: fetch_catalog(config, None)
    )
    sync.refresh()

    # The mock's projection strips unknown fields; even if a source leaked
    # noise, the 7-field equality gate keeps the resync churn-free.
    source.set_skills([_wire("a", createdAt="2026-01-01T00:00:00Z")])
    result = sync.refresh()
    assert result == SyncResult(added=0, updated=0, removed=0, conflicts=[], unchanged=False)


def test_removes_and_disowns_an_owned_id_that_left_the_wire(source: MockSource) -> None:
    source.set_skills([_wire("a"), _wire("b")])
    catalog = SkillCatalog()
    sync = SkillSync(catalog, _config(source))
    sync.refresh()

    source.set_skills([_wire("b")])
    result = sync.refresh()
    assert result == SyncResult(added=0, updated=0, removed=1, conflicts=[], unchanged=False)
    assert not catalog.has("a")
    assert sync.owned_count == 1


def test_never_touches_a_host_skill_with_a_colliding_id(source: MockSource) -> None:
    catalog = SkillCatalog()
    catalog.register(Skill(id="a", name="host-owned", description="host", body="host body"))
    source.set_skills([_wire("a"), _wire("b")])
    sync = SkillSync(catalog, _config(source))

    result = sync.refresh()
    assert result == SyncResult(added=1, updated=0, removed=0, conflicts=["a"], unchanged=False)
    skill = catalog.get("a")
    assert skill is not None and skill.name == "host-owned"
    assert sync.owned_count == 1

    # The conflicting id is never adopted, upserted, or disowned into a removal.
    source.set_skills([_wire("a", body="still not yours\n"), _wire("b")])
    again = sync.refresh()
    assert again.conflicts == ["a"]
    assert again.updated == 0 and again.removed == 0
    skill = catalog.get("a")
    assert skill is not None and skill.name == "host-owned"


def test_304_is_a_revalidated_noop_that_refreshes_last_synced_at(source: MockSource) -> None:
    source.set_skills([_wire("a")])
    catalog = SkillCatalog()
    sync = SkillSync(catalog, _config(source))
    sync.refresh()
    first_synced_at = sync.last_synced_at
    assert first_synced_at is not None

    churn: list[None] = []
    catalog.on_change(lambda: churn.append(None))
    time.sleep(0.01)
    result = sync.refresh()
    assert result == SyncResult(added=0, updated=0, removed=0, conflicts=[], unchanged=True)
    assert churn == []
    assert catalog.size() == 1
    assert sync.last_synced_at is not None and sync.last_synced_at > first_synced_at
    # The revalidation carried the cached etag for this (url, scope).
    assert source.requests[-1].headers["if-none-match"].strip('"') != ""


def test_transient_failure_keeps_the_replica_and_counts(source: MockSource) -> None:
    source.set_skills([_wire("a")])
    catalog = SkillCatalog()
    sync = SkillSync(catalog, _config(source))
    sync.refresh()

    source.inject_failure(503, code="unavailable", times=2)
    for expected_failures in (1, 2):
        with pytest.raises(UnavailableError):
            sync.refresh()
        assert sync.consecutive_failures == expected_failures
        assert catalog.size() == 1  # the last-pulled replica stays live

    sync.refresh()
    assert sync.consecutive_failures == 0


def test_jittered_interval_stays_within_ten_percent() -> None:
    samples = [_jittered_interval(10.0) for _ in range(200)]
    assert all(9.0 <= s <= 11.0 for s in samples)
    assert len(set(samples)) > 1


def test_start_keeps_refreshing_on_a_timer(source: MockSource) -> None:
    source.set_skills([_wire("a")])
    catalog = SkillCatalog()
    sync = SkillSync(catalog, _config(source))
    sync.start(0.02)
    try:
        _wait_until(lambda: catalog.has("a"))
        assert sync._timer is not None and sync._timer.daemon  # timers never pin the process
        source.set_skills([_wire("a"), _wire("b")])
        _wait_until(lambda: catalog.has("b"))
        source.set_skills([_wire("b")])
        _wait_until(lambda: not catalog.has("a"))
    finally:
        sync.stop()


def test_transient_errors_keep_the_chain_alive(source: MockSource) -> None:
    source.set_skills([_wire("a")])
    catalog = SkillCatalog()
    sync = SkillSync(catalog, _config(source))
    source.inject_failure(503, code="unavailable", times=3)
    sync.start(0.02)
    try:
        _wait_until(lambda: sync.consecutive_failures > 0)
        _wait_until(lambda: catalog.has("a"))  # chain survived and recovered
        assert sync.consecutive_failures == 0
    finally:
        sync.stop()


def test_auth_error_stops_the_chain_permanently(source: MockSource) -> None:
    catalog = SkillCatalog()
    sync = SkillSync(catalog, _config(source))
    source.inject_failure(401, code="unauthorized", times=10_000)
    sync.start(0.02)
    _wait_until(lambda: sync.consecutive_failures > 0)
    _wait_until(lambda: sync._timer is None)
    requests_after_stop = len(source.requests)
    time.sleep(0.1)
    assert len(source.requests) == requests_after_stop
    # A permanently stopped chain cannot be restarted.
    sync.start(0.02)
    time.sleep(0.1)
    assert len(source.requests) == requests_after_stop


def test_stop_is_idempotent_and_race_safe(source: MockSource) -> None:
    source.set_skills([_wire("a")])
    catalog = SkillCatalog()
    sync = SkillSync(catalog, _config(source))
    sync.start(0.01)
    _wait_until(lambda: catalog.has("a"))
    threads = [threading.Thread(target=sync.stop) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    sync.stop()
    time.sleep(0.05)
    requests_after_stop = len(source.requests)
    time.sleep(0.1)
    assert len(source.requests) == requests_after_stop
