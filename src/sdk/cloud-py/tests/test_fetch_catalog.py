"""`fetch_catalog`: one conditional GET of a source's `/v1/catalog`, exercised
against the conformant `MockSource` over real HTTP."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from ratel_ai import SourceConfig

from ratel_ai_cloud.errors import ApiError, AuthError, UnavailableError
from ratel_ai_cloud.fetch_catalog import CatalogChanged, CatalogUnchanged, fetch_catalog
from ratel_ai_cloud.testing.mock_source import MockSource

API_KEY = "test-key"


@pytest.fixture()
def source() -> Iterator[MockSource]:
    with MockSource(api_key=API_KEY) as src:
        yield src


def _config(source: MockSource, scope: str | None = None) -> SourceConfig:
    return SourceConfig(url=source.url, api_key=API_KEY, scope=scope)


def _skill(skill_id: str, body: str = "b\n") -> dict[str, Any]:
    return {
        "id": skill_id,
        "name": f"{skill_id}-name",
        "description": f"{skill_id} description",
        "tags": ["t"],
        "tools": [],
        "metadata": {},
        "body": body,
    }


def test_changed_result_carries_etag_and_catalog(source: MockSource) -> None:
    source.set_skills([_skill("a"), _skill("b")])
    result = fetch_catalog(_config(source))
    assert isinstance(result, CatalogChanged)
    assert result.changed is True
    assert result.etag == f'"{result.catalog.catalog_version}"'
    assert [s["id"] for s in result.catalog.skills] == ["a", "b"]


def test_sends_bearer_and_if_none_match(source: MockSource) -> None:
    source.set_skills([_skill("a")])
    first = fetch_catalog(_config(source))
    assert isinstance(first, CatalogChanged)
    second = fetch_catalog(_config(source), etag=first.etag)
    assert isinstance(second, CatalogUnchanged)
    assert second.changed is False
    initial, revalidation = source.requests
    assert initial.headers["authorization"] == f"Bearer {API_KEY}"
    assert "if-none-match" not in initial.headers
    assert revalidation.headers["authorization"] == f"Bearer {API_KEY}"
    assert revalidation.headers["if-none-match"] == first.etag


def test_scope_passes_through_and_selects_the_overlay(
    source: MockSource, vectors: dict[str, Any]
) -> None:
    source.set_layers(vectors["catalogs"]["scoped"])
    global_result = fetch_catalog(_config(source))
    alice_result = fetch_catalog(_config(source, scope="alice"))
    assert isinstance(global_result, CatalogChanged)
    assert isinstance(alice_result, CatalogChanged)
    assert global_result.etag != alice_result.etag
    assert [s["id"] for s in alice_result.catalog.skills] == ["a-files", "g-email", "g-search"]
    assert [r.scope for r in source.requests] == [None, "alice"]
    # An etag cached for one scope must not be replayed into another.
    cross = fetch_catalog(_config(source, scope="alice"), etag=global_result.etag)
    assert isinstance(cross, CatalogChanged)


def test_tolerates_a_trailing_slash_in_the_base_url(source: MockSource) -> None:
    source.set_skills([_skill("a")])
    config = SourceConfig(url=f"{source.url}/", api_key=API_KEY, scope=None)
    result = fetch_catalog(config)
    assert isinstance(result, CatalogChanged)
    assert source.requests[-1].path == "/v1/catalog"


def test_401_raises_auth_error(source: MockSource) -> None:
    config = SourceConfig(url=source.url, api_key="wrong-key", scope=None)
    with pytest.raises(AuthError) as excinfo:
        fetch_catalog(config)
    assert excinfo.value.status == 401
    assert excinfo.value.code == "unauthorized"


def test_503_raises_unavailable_error(source: MockSource) -> None:
    source.inject_failure(503, code="unavailable")
    with pytest.raises(UnavailableError) as excinfo:
        fetch_catalog(_config(source))
    assert excinfo.value.status == 503


def test_other_statuses_raise_api_error_with_code(source: MockSource) -> None:
    source.inject_failure(400, code="invalid_request")
    with pytest.raises(ApiError) as excinfo:
        fetch_catalog(_config(source))
    assert excinfo.value.status == 400
    assert excinfo.value.code == "invalid_request"


def test_network_failure_raises_unavailable_error_without_status(source: MockSource) -> None:
    config = _config(source)
    source.stop()
    with pytest.raises(UnavailableError) as excinfo:
        fetch_catalog(config)
    assert excinfo.value.status is None
