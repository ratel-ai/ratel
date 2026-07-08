"""`MockSource` must behave like a conformant catalog source over real HTTP:
every committed etag vector, all 7 If-None-Match outcomes, the frozen auth and
error bodies, and the structural secrets rule."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Iterator
from typing import Any

import pytest

from ratel_ai_cloud.canonical import SKILL_FIELDS
from ratel_ai_cloud.testing.mock_source import MockSource

API_KEY = "test-key"


@pytest.fixture()
def source() -> Iterator[MockSource]:
    with MockSource(api_key=API_KEY) as src:
        yield src


def _get(
    url: str,
    api_key: str | None = API_KEY,
    etag: str | None = None,
) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(url)
    if api_key is not None:
        request.add_header("Authorization", f"Bearer {api_key}")
    if etag is not None:
        request.add_header("If-None-Match", etag)
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers.items()), err.read()


def _catalog_url(source: MockSource, scope: str | None) -> str:
    url = f"{source.url}/v1/catalog"
    if scope is not None:
        url += f"?scope={scope}"
    return url


def test_reproduces_every_etag_vector(source: MockSource, vectors: dict[str, Any]) -> None:
    for vector in vectors["etag"]:
        source.set_layers(vectors["catalogs"][vector["catalog"]])
        status, headers, body = _get(_catalog_url(source, vector.get("scope")))
        assert status == 200, vector["name"]
        assert headers["ETag"] == vector["expect"]["etag"], vector["name"]
        assert headers["Cache-Control"] == "no-cache"
        payload = json.loads(body)
        # Quoted strong tag in the header; bare hex in the body.
        assert f'"{payload["catalogVersion"]}"' == vector["expect"]["etag"]
        assert [s["id"] for s in payload["skills"]] == vector["expect"]["resolvedIds"]


def _current_etag(source: MockSource, scope: str | None = None) -> str:
    _, headers, _ = _get(_catalog_url(source, scope))
    return headers["ETag"]


def test_reproduces_every_inm_outcome(source: MockSource, vectors: dict[str, Any]) -> None:
    etag_vectors = {v["name"]: v for v in vectors["etag"]}
    for vector in vectors["inm"]:
        current_vec = etag_vectors[vector["current"]]
        source.set_layers(vectors["catalogs"][current_vec["catalog"]])
        current_scope = current_vec.get("scope")
        current = _current_etag(source, current_scope)
        kind = vector["ifNoneMatch"]["kind"]
        if kind == "self":
            header: str | None = current
        elif kind == "weakSelf":
            header = f"W/{current}"
        elif kind == "star":
            header = "*"
        elif kind == "listWithSelf":
            header = f'"deadbeef", {current}'
        elif kind == "listMiss":
            header = '"deadbeef", "c0ffeec0ffeec0ffee"'
        elif kind == "absent":
            header = None
        elif kind == "other":
            other_vec = etag_vectors[vector["of"]]
            header = _current_etag(source, other_vec.get("scope"))
        else:  # pragma: no cover - vectors.json is frozen
            raise AssertionError(f"unknown If-None-Match kind: {kind}")
        status, _, body = _get(_catalog_url(source, current_scope), etag=header)
        assert status == vector["expect"], vector["name"]
        if status == 304:
            assert body == b""


def test_served_skills_carry_exactly_the_wire_fields(
    source: MockSource, vectors: dict[str, Any]
) -> None:
    wire = vectors["wire"]
    noisy = {
        "id": "s",
        "name": "n",
        "description": "d",
        "tags": [],
        "tools": [],
        "metadata": {},
        "body": "b",
        "status": "published",
        "apiKey": "sk-LEAK",
        "authorization": "Bearer LEAK",
    }
    source.set_skills([noisy])
    _, _, body = _get(_catalog_url(source, None))
    for skill in json.loads(body)["skills"]:
        assert list(skill.keys()) == wire["skillFields"] == list(SKILL_FIELDS)
        for field in skill:
            for forbidden in wire["forbiddenFieldSubstrings"]:
                assert forbidden not in field.lower()
    assert b"LEAK" not in body


def test_missing_or_bad_bearer_yields_frozen_401_body(source: MockSource) -> None:
    for key in (None, "wrong-key"):
        status, _, body = _get(_catalog_url(source, None), api_key=key)
        assert status == 401
        payload = json.loads(body)
        assert set(payload.keys()) == {"error"}
        assert payload["error"]["code"] == "unauthorized"
        assert isinstance(payload["error"]["message"], str)


def test_healthz_is_unauthenticated(source: MockSource) -> None:
    status, _, _ = _get(f"{source.url}/healthz", api_key=None)
    assert status == 200


def test_unknown_v1_path_yields_frozen_404_body(source: MockSource) -> None:
    status, _, body = _get(f"{source.url}/v1/nope")
    assert status == 404
    assert json.loads(body)["error"]["code"] == "not_found"


def test_records_requests(source: MockSource) -> None:
    _get(_catalog_url(source, "alice"), etag='"abc"')
    _get(f"{source.url}/healthz", api_key=None)
    catalog_req, healthz_req = source.requests
    assert catalog_req.method == "GET"
    assert catalog_req.path == "/v1/catalog"
    assert catalog_req.scope == "alice"
    assert catalog_req.headers["authorization"] == f"Bearer {API_KEY}"
    assert catalog_req.headers["if-none-match"] == '"abc"'
    assert healthz_req.path == "/healthz"
    assert healthz_req.scope is None


def test_set_skills_replaces_the_global_layer(source: MockSource) -> None:
    source.set_skills([_skill("a")])
    first = _current_etag(source)
    source.set_skills([_skill("a"), _skill("b")])
    second = _current_etag(source)
    assert first != second
    _, _, body = _get(_catalog_url(source, None))
    assert [s["id"] for s in json.loads(body)["skills"]] == ["a", "b"]


def test_failure_injection_then_recovery(source: MockSource) -> None:
    source.set_skills([_skill("a")])
    source.inject_failure(503, code="unavailable", times=2)
    for _ in range(2):
        status, _, body = _get(_catalog_url(source, None))
        assert status == 503
        assert json.loads(body)["error"]["code"] == "unavailable"
    status, _, _ = _get(_catalog_url(source, None))
    assert status == 200


def _skill(skill_id: str) -> dict[str, Any]:
    return {
        "id": skill_id,
        "name": f"{skill_id}-name",
        "description": f"{skill_id} description",
        "tags": [],
        "tools": [],
        "metadata": {},
        "body": f"# {skill_id}\n",
    }
