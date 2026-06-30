from __future__ import annotations

import json
from pathlib import Path

import pytest

from ratel_ai_cloud import validate

# The same fixtures the Rust spec and TS client run against — the cross-language
# contract (ADR-0013).
FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"


def _load(kind: str) -> list[tuple[str, dict]]:
    paths = sorted((FIXTURES / kind).glob("*.json"))
    assert paths, f"no fixtures in {FIXTURES / kind}"
    return [(p.name, json.loads(p.read_text())) for p in paths]


@pytest.mark.parametrize(("name", "event"), _load("valid"))
def test_valid_fixtures_pass(name: str, event: dict) -> None:
    result = validate(event)
    assert result.ok, f"{name}: {[ (i.path, i.message) for i in result.issues ]}"


@pytest.mark.parametrize(("name", "event"), _load("invalid"))
def test_invalid_fixtures_fail(name: str, event: dict) -> None:
    assert not validate(event).ok, name
