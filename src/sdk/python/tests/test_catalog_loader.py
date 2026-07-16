"""Tests for the catalog loader seam — mirrors `src/sdk/ts/src/catalog-loader.test.ts`.

The fakes are fully typed and one is bound to `CatalogLoader` so mypy strict
proves both a plain-`def` and an `async def` loader conform to the Protocol.
"""

from __future__ import annotations

import pytest

from ratel_ai import CatalogLoader, Skill, SkillCatalog, attach_loader


class AsyncFakeLoader:
    """Async loader that records lifecycle calls and mirrors a fixed skill set."""

    def __init__(self, skills: list[Skill] | None = None) -> None:
        self.calls: list[str] = []
        self.catalog: SkillCatalog | None = None
        self.throw_on: set[str] = set()
        self._skills: list[Skill] = list(skills or [])

    def set_skills(self, skills: list[Skill]) -> None:
        self._skills = list(skills)

    async def start(self, catalog: SkillCatalog) -> None:
        self.calls.append("start")
        self.catalog = catalog
        self._maybe_throw("start")
        for skill in self._skills:
            catalog.upsert(skill)

    async def stop(self) -> None:
        self.calls.append("stop")
        self._maybe_throw("stop")

    async def refresh(self) -> None:
        self.calls.append("refresh")
        self._maybe_throw("refresh")
        if self.catalog is not None:
            for skill in self._skills:
                self.catalog.upsert(skill)

    def _maybe_throw(self, phase: str) -> None:
        if phase in self.throw_on:
            raise RuntimeError(f"fake loader {phase} failure")


class SyncFakeLoader:
    """Fully synchronous loader — plain `def` methods conform to the Protocol."""

    def __init__(self, skills: list[Skill] | None = None) -> None:
        self.calls: list[str] = []
        self._skills: list[Skill] = list(skills or [])

    def start(self, catalog: SkillCatalog) -> None:
        self.calls.append("start")
        for skill in self._skills:
            catalog.upsert(skill)

    def stop(self) -> None:
        self.calls.append("stop")

    def refresh(self) -> None:
        self.calls.append("refresh")


SLIDES = Skill(
    id="frontend-slides",
    name="frontend-slides",
    description="Build animation-rich HTML presentations from scratch.",
    tags=["frontend"],
    body="# Slides",
)
API_DESIGN = Skill(
    id="api-design",
    name="api-design",
    description="REST API design patterns: resource naming, pagination.",
    tags=["backend"],
    body="# API",
)


async def test_attach_calls_start_with_catalog_and_hydrates_before_resolving() -> None:
    catalog = SkillCatalog()
    changes = []
    catalog.on_change(lambda: changes.append(1))
    # Statically bound to the Protocol: mypy strict proves an async loader conforms.
    loader: CatalogLoader = AsyncFakeLoader([SLIDES, API_DESIGN])

    handle = await attach_loader(catalog, loader)

    assert isinstance(loader, AsyncFakeLoader)  # narrow for attribute access below
    assert loader.calls == ["start"]
    assert loader.catalog is catalog
    assert catalog.size() == 2
    assert len(changes) == 2
    assert callable(handle.detach) and callable(handle.refresh)


async def test_absorbs_a_fully_synchronous_loader() -> None:
    catalog = SkillCatalog()
    # A plain-`def` loader also conforms structurally.
    loader: CatalogLoader = SyncFakeLoader([SLIDES])

    await attach_loader(catalog, loader)

    assert catalog.has("frontend-slides")


async def test_detach_stops_once_and_is_idempotent() -> None:
    catalog = SkillCatalog()
    loader = AsyncFakeLoader([SLIDES])
    handle = await attach_loader(catalog, loader)

    await handle.detach()
    await handle.detach()

    assert loader.calls == ["start", "stop"]
    # Detach keeps the hydrated skills in the catalog.
    assert catalog.has("frontend-slides")


async def test_handle_refresh_passes_through() -> None:
    catalog = SkillCatalog()
    loader = AsyncFakeLoader([SLIDES])
    handle = await attach_loader(catalog, loader)

    loader.set_skills([SLIDES, API_DESIGN])
    await handle.refresh()

    assert loader.calls == ["start", "refresh"]
    assert catalog.size() == 2


async def test_handle_refresh_propagates_errors() -> None:
    catalog = SkillCatalog()
    loader = AsyncFakeLoader([SLIDES])
    handle = await attach_loader(catalog, loader)

    loader.throw_on.add("refresh")
    with pytest.raises(RuntimeError, match="fake loader refresh failure"):
        await handle.refresh()


async def test_double_attach_of_same_instance_rejects() -> None:
    catalog = SkillCatalog()
    loader = AsyncFakeLoader([SLIDES])
    await attach_loader(catalog, loader)

    with pytest.raises(RuntimeError, match="already attached"):
        await attach_loader(catalog, loader)
    assert loader.calls == ["start"]


async def test_detach_then_reattach_starts_again() -> None:
    catalog = SkillCatalog()
    loader = AsyncFakeLoader([SLIDES])
    handle = await attach_loader(catalog, loader)
    await handle.detach()

    re_handle = await attach_loader(catalog, loader)

    assert loader.calls == ["start", "stop", "start"]
    await re_handle.detach()


async def test_start_failure_keeps_partial_hydration_and_re_allows_attach() -> None:
    catalog = SkillCatalog()

    class PartialLoader:
        def __init__(self) -> None:
            self.calls: list[str] = []

        async def start(self, cat: SkillCatalog) -> None:
            self.calls.append("start")
            cat.upsert(SLIDES)
            raise RuntimeError("start blew up after one upsert")

        async def stop(self) -> None:
            self.calls.append("stop")

        async def refresh(self) -> None:
            self.calls.append("refresh")

    loader: CatalogLoader = PartialLoader()

    with pytest.raises(RuntimeError, match="start blew up"):
        await attach_loader(catalog, loader)
    # The committed upsert stays — the SDK has no snapshot to roll back.
    assert catalog.has("frontend-slides")

    # ...and the loader is re-attachable (guard cleared on failure).
    assert isinstance(loader, PartialLoader)
    loader.calls.clear()
    with pytest.raises(RuntimeError, match="start blew up"):
        await attach_loader(catalog, loader)
    assert loader.calls == ["start"]


async def test_stop_failure_propagates_but_still_detaches() -> None:
    catalog = SkillCatalog()
    loader = AsyncFakeLoader([SLIDES])
    handle = await attach_loader(catalog, loader)

    loader.throw_on.add("stop")
    with pytest.raises(RuntimeError, match="fake loader stop failure"):
        await handle.detach()

    # Marked detached despite the throw: a second detach neither re-stops nor raises.
    loader.throw_on.discard("stop")
    await handle.detach()
    assert loader.calls == ["start", "stop"]

    # Detached-out means the instance can be attached fresh.
    re_handle = await attach_loader(catalog, loader)
    assert loader.calls == ["start", "stop", "start"]
    await re_handle.detach()
