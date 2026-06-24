"""Shared fixtures for the observability tests.

Every test gets a fresh trace context and a clean global client so leaked
contextvars or singletons can't bleed across tests.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from ratel_ai.observability import CaptureExporter, RatelClient, set_global_client
from ratel_ai.observability import context as ctx


@pytest.fixture(autouse=True)
def _reset_observability() -> Iterator[None]:
    ctx.clear()
    set_global_client(None)
    yield
    ctx.clear()
    set_global_client(None)


@pytest.fixture
def capture() -> CaptureExporter:
    """Install a global client wired to an in-memory capturing exporter."""
    exporter = CaptureExporter()
    client = RatelClient(api_key="rk-test", enabled=True, exporter=exporter)
    set_global_client(client)
    return exporter
