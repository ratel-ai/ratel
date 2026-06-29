"""Shared fixtures for the observability tests.

Every test gets a clean global client so a leaked singleton can't bleed across
tests.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from ratel_ai.observability import set_global_client


@pytest.fixture(autouse=True)
def _reset_observability() -> Iterator[None]:
    set_global_client(None)
    yield
    set_global_client(None)
