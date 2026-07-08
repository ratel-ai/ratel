"""Shared fixtures: the frozen protocol/v1 conformance vectors, loaded from the
repo checkout (this package's tests are the loader-side conformance run)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
VECTORS_PATH = REPO_ROOT / "protocol" / "v1" / "conformance" / "vectors.json"


@pytest.fixture(scope="session")
def vectors() -> dict[str, Any]:
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))  # type: ignore[no-any-return]
