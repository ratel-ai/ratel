"""Loader-side conformance: `ratel_ai_cloud.canonical` must reproduce every
committed vector in `protocol/v1/conformance/vectors.json` byte-for-byte."""

from __future__ import annotations

import hashlib
from typing import Any

from ratel_ai_cloud.canonical import (
    SKILL_FIELDS,
    canonical_set,
    canonical_skill,
    etag_of,
    resolve,
)


def _etag_by_name(vectors: dict[str, Any], name: str) -> str:
    vector = next(v for v in vectors["etag"] if v["name"] == name)
    catalog = vectors["catalogs"][vector["catalog"]]
    return etag_of(resolve(catalog, vector.get("scope"))).etag


def test_every_etag_vector(vectors: dict[str, Any]) -> None:
    for vector in vectors["etag"]:
        catalog = vectors["catalogs"][vector["catalog"]]
        resolved = resolve(catalog, vector.get("scope"))
        assert [s["id"] for s in resolved] == vector["expect"]["resolvedIds"], vector["name"]
        assert etag_of(resolved).etag == vector["expect"]["etag"], vector["name"]


def test_every_equal_etags_group(vectors: dict[str, Any]) -> None:
    for group in vectors["equalEtags"]:
        tags = {_etag_by_name(vectors, name) for name in group}
        assert len(tags) == 1, group


def test_every_distinct_etags_group(vectors: dict[str, Any]) -> None:
    for group in vectors["distinctEtags"]:
        tags = {_etag_by_name(vectors, name) for name in group}
        assert len(tags) == len(group), group


def test_etag_is_lowercase_hex_sha256_of_canonical_set(vectors: dict[str, Any]) -> None:
    skills = vectors["catalogs"]["basic"]["global"]
    expected_hex = hashlib.sha256(canonical_set(skills).encode("utf-8")).hexdigest()
    result = etag_of(skills)
    assert result.hex == expected_hex
    assert result.etag == f'"{expected_hex}"'


def test_empty_set_canonicalizes_to_bare_brackets() -> None:
    assert canonical_set([]) == "[]"
    assert etag_of([]).hex == hashlib.sha256(b"[]").hexdigest()


def test_canonical_skill_fixed_key_order_and_projection() -> None:
    skill = {
        "metadata": {"cat": ["a"]},
        "body": "# A\n",
        "tools": ["t1"],
        "id": "a",
        "tags": ["x"],
        "description": "First.",
        "name": "alpha",
        "status": "published",
        "updatedAt": "2026-01-01T00:00:00Z",
    }
    assert canonical_skill(skill) == (
        '{"id":"a","name":"alpha","description":"First.",'
        '"tags":["x"],"tools":["t1"],"metadata":{"cat":["a"]},"body":"# A\\n"}'
    )


def test_metadata_keys_sorted_by_utf8_bytes_arrays_authored_order() -> None:
    skill = {
        "id": "u",
        "name": "n",
        "description": "d",
        "tags": ["食", "x"],
        "tools": [],
        "metadata": {"región": ["MX"], "área": ["café"]},
        "body": "b",
    }
    # "región" (r=0x72) sorts before "área" (0xc3 first byte) bytewise;
    # non-ASCII stays raw UTF-8, never \u-escaped; tags keep authored order.
    assert canonical_skill(skill) == (
        '{"id":"u","name":"n","description":"d","tags":["食","x"],"tools":[],'
        '"metadata":{"región":["MX"],"área":["café"]},"body":"b"}'
    )


def test_scope_overlay_subject_wins_on_name_collision(vectors: dict[str, Any]) -> None:
    catalog = vectors["catalogs"]["scoped"]
    resolved = resolve(catalog, "alice")
    by_id = {s["id"]: s for s in resolved}
    # `g-search` collides on name `search-web`: Alice's copy wins.
    assert by_id["g-search"]["body"] == "alice search\n"
    assert by_id["g-email"]["body"] == "global email\n"


def test_scope_overlay_unknown_or_absent_subject_is_global_only(vectors: dict[str, Any]) -> None:
    catalog = vectors["catalogs"]["scoped"]
    assert resolve(catalog, "carol") == resolve(catalog, None)
    assert [s["id"] for s in resolve(catalog, None)] == ["g-email", "g-search"]


def test_wire_secrets_rule_structural(vectors: dict[str, Any]) -> None:
    wire = vectors["wire"]
    assert list(SKILL_FIELDS) == wire["skillFields"]
    for field in SKILL_FIELDS:
        for forbidden in wire["forbiddenFieldSubstrings"]:
            assert forbidden not in field.lower()
    # The projection drops any field a secret could ride in on.
    leaky = {
        "id": "s",
        "name": "n",
        "description": "d",
        "tags": [],
        "tools": [],
        "metadata": {},
        "body": "b",
        "apiKey": "sk-LEAK",
        "authorization": "Bearer LEAK",
    }
    assert "LEAK" not in canonical_skill(leaky)
