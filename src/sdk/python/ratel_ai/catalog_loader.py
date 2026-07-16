"""Catalog loader lifecycle contract — the Python mirror of `src/sdk/ts/src/catalog-loader.ts`.

`CatalogLoader` is the formal seam over the mutable-catalog surface
(`SkillCatalog.upsert` / `remove` / `on_change`, ADR-0003): a loader is any
separate package that mirrors a source (a directory of SKILL.md files, the
managed cloud, a DB, git) into a catalog, *owning its own sync loop* and driving
the catalog itself. The contract is lifecycle-only; there is no SDK-owned
snapshot diffing.

It is a `typing.Protocol` — the SDK's own published contract for third-party
implementers under mypy strict. Each method is annotated `Awaitable[None] | None`,
so a plain `def` and an `async def` both conform structurally. `attach_loader`
absorbs the sync-or-async return with `inspect.isawaitable`, the same pattern as
`ToolCatalog.invoke`.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Callable, Protocol
from weakref import WeakSet

from .skill_catalog import SkillCatalog

__all__ = ["CatalogLoader", "CatalogLoaderHandle", "attach_loader"]


class CatalogLoader(Protocol):
    """The lifecycle a catalog loader implements (see the module docstring)."""

    def start(self, catalog: SkillCatalog) -> Awaitable[None] | None:
        """Hydrate the catalog with one pass, then begin owning the loop.

        Resolves when the initial hydration is done — `attach_loader` awaits it,
        so its caller gets a hydrated-or-failed catalog.

        Args:
            catalog: the catalog to mirror the source into.
        """
        ...

    def stop(self) -> Awaitable[None] | None:
        """End the loop and release what `start` acquired.

        The loader must be restartable afterwards (detach-then-reattach is
        supported). Hydrated skills stay in the catalog by design (ADR-0003
        offline semantics).
        """
        ...

    def refresh(self) -> Awaitable[None] | None:
        """Run one sync pass now — the same pass `start` runs first.

        A watch-only loader may no-op it. Required (not optional) so the contract
        stays a single structural type with no `refresh?.()` conditionals.
        """
        ...


@dataclass
class CatalogLoaderHandle:
    """What `attach_loader` returns: the loop's off switch and a manual sync trigger.

    Attributes:
        detach: stop the loader and detach it (calls `stop` once). Idempotent —
            safe from a shutdown path; a second call is a no-op, and the loader
            is re-attachable afterwards.
        refresh: trigger one `refresh` pass now; a pass-through.
    """

    detach: Callable[[], Awaitable[None]]
    refresh: Callable[[], Awaitable[None]]


# A loader instance is single-attach: attaching it a second time while already
# running is a caller bug (two loops writing one catalog). The catalog stays
# loader-blind — this bookkeeping lives here, keyed weakly so a
# forgotten-but-detached loader is still collectable.
_attached: WeakSet[CatalogLoader] = WeakSet()


async def _maybe_await(value: Awaitable[None] | None) -> None:
    """Await an async loader method's return; a sync `None` passes straight through."""
    if inspect.isawaitable(value):
        await value


async def attach_loader(catalog: SkillCatalog, loader: CatalogLoader) -> CatalogLoaderHandle:
    """Attach a `CatalogLoader` to a `SkillCatalog` and start it.

    Calls the loader's `start(catalog)` and resolves once it has hydrated (or
    raises if it fails). A free function, mirroring `register_mcp_server` — the
    catalog never learns about loaders.

    Attaching the *same loader instance* twice while it is running raises loudly;
    `detach` then a fresh `attach_loader` is the supported way to re-run one. A
    `start` failure leaves any already-committed upserts in place (each was
    committed and notified on its own; there is no diff to roll back) and
    re-allows attaching. No telemetry in v1 (deferred to the Cloud loader,
    ADR-0003).

    Args:
        catalog: catalog the loader hydrates and keeps in sync.
        loader: the loader to start and own.

    Returns:
        A `CatalogLoaderHandle` to `detach` (stop the loop) or `refresh` (one
        pass now).

    Raises:
        RuntimeError: if `loader` is already attached.
    """
    if loader in _attached:
        raise RuntimeError("loader already attached; detach it before attaching again")
    _attached.add(loader)
    try:
        await _maybe_await(loader.start(catalog))
    except BaseException:
        # Hydration failed: re-allow attaching. Partial upserts stay — each was
        # committed and notified on its own; the SDK has no snapshot to unwind.
        _attached.discard(loader)
        raise

    detached = False

    async def detach() -> None:
        nonlocal detached
        if detached:
            return
        # Mark detached and free the guard first, so a `stop` that raises still
        # leaves the loader re-attachable and this handle a no-op on re-entry.
        detached = True
        _attached.discard(loader)
        await _maybe_await(loader.stop())

    async def refresh() -> None:
        await _maybe_await(loader.refresh())

    return CatalogLoaderHandle(detach=detach, refresh=refresh)
