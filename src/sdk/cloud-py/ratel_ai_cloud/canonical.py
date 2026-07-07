"""Frozen v1 canonicalization — the Python mirror of the reference
implementation in `protocol/v1/conformance/verify.mjs`.

The ETag content projection is frozen at v1 (see `protocol/v1/README.md`):
exactly the seven wire fields in a fixed key order, `metadata` keys sorted by
UTF-8 byte order, arrays in authored order, raw UTF-8, compact JSON, set sorted
by `id`. Runtime uses this for nothing but tests and the mock source — a loader
trusts the server's ETag; recomputation is a test-only integrity check.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from typing import Any, NamedTuple

__all__ = ["SKILL_FIELDS", "Etag", "canonical_set", "canonical_skill", "etag_of", "resolve"]

# The frozen v1 content projection: exactly these fields, in this order.
SKILL_FIELDS = ("id", "name", "description", "tags", "tools", "metadata", "body")


class Etag(NamedTuple):
    hex: str
    etag: str  # the strong entity-tag: `"<hex>"`


def _json(value: Any) -> str:
    # Compact separators + ensure_ascii=False match JSON.stringify: minimal
    # escaping, raw UTF-8, no insignificant whitespace.
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _utf8(key: str) -> bytes:
    return key.encode("utf-8")


def canonical_skill(skill: Mapping[str, Any]) -> str:
    """Canonical JSON for one skill, projected to exactly the seven wire fields."""
    metadata: Mapping[str, Any] = skill.get("metadata") or {}
    meta_keys = sorted(metadata, key=_utf8)
    meta = "{" + ",".join(_json(k) + ":" + _json(metadata[k]) for k in meta_keys) + "}"
    return (
        "{"
        + '"id":' + _json(skill["id"]) + ","
        + '"name":' + _json(skill["name"]) + ","
        + '"description":' + _json(skill["description"]) + ","
        + '"tags":' + _json(skill["tags"]) + ","
        + '"tools":' + _json(skill["tools"]) + ","
        + '"metadata":' + meta + ","
        + '"body":' + _json(skill["body"])
        + "}"
    )


def _sort_by_id(skills: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return sorted(skills, key=lambda s: _utf8(s["id"]))


def canonical_set(skills: Sequence[Mapping[str, Any]]) -> str:
    """Canonical bytes for a resolved set: sorted by id, compact JSON array."""
    return "[" + ",".join(canonical_skill(s) for s in _sort_by_id(skills)) + "]"


def etag_of(skills: Sequence[Mapping[str, Any]]) -> Etag:
    hex_digest = hashlib.sha256(canonical_set(skills).encode("utf-8")).hexdigest()
    return Etag(hex=hex_digest, etag=f'"{hex_digest}"')


def resolve(catalog: Mapping[str, Any], scope: str | None) -> list[Mapping[str, Any]]:
    """Resolve the published set for a scope: absent scope => the global layer;
    a subject => its layer overlaid on global, subject winning on `name`
    collision; an unknown subject => the global layer (empty overlay)."""
    global_layer: Sequence[Mapping[str, Any]] = catalog.get("global") or []
    if scope is None:
        return _sort_by_id(global_layer)
    subject_layer: Sequence[Mapping[str, Any]] = (catalog.get("subjects") or {}).get(scope) or []
    by_name: dict[str, Mapping[str, Any]] = {}
    for skill in global_layer:
        by_name[skill["name"]] = skill
    for skill in subject_layer:
        by_name[skill["name"]] = skill
    return _sort_by_id(list(by_name.values()))
