"""`SkillSync` — pull-syncs a source's published skills into a host-owned
`SkillCatalog` under the ownership rule: the loader mutates only the ids it
synced itself; a host-registered skill with a colliding id is reported in
`SyncResult.conflicts` and never touched. The replica is in-memory only;
staleness surfaces as `last_synced_at` / `consecutive_failures` (ADR-0003).
"""

from __future__ import annotations

import random
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from ratel_ai import Skill, SkillCatalog, SourceConfig

from .canonical import SKILL_FIELDS
from .errors import ApiError, AuthError
from .fetch_catalog import CatalogChanged, FetchCatalogResult, fetch_catalog

__all__ = ["SkillSync", "SyncResult", "skills_equal"]

FetchImpl = Callable[[SourceConfig, Optional[str]], FetchCatalogResult]


@dataclass(frozen=True)
class SyncResult:
    added: int
    updated: int
    removed: int
    # Ids present in the catalog but not owned by this sync — host skills the
    # ownership rule refused to overwrite.
    conflicts: list[str]
    # True when the source answered 304 for the cached etag.
    unchanged: bool


def skills_equal(a: Skill, b: Skill) -> bool:
    """Field-wise equality over exactly the 7 wire fields — the same set the
    frozen ETag projection hashes, so an identical resync emits zero churn."""
    return all(getattr(a, f) == getattr(b, f) for f in SKILL_FIELDS)


def _to_skill(wire: dict[str, Any]) -> Skill:
    """Project a wire skill to the 7 fields (unknown fields are ignored)."""
    return Skill(
        id=wire["id"],
        name=wire["name"],
        description=wire["description"],
        tags=list(wire["tags"]),
        tools=list(wire["tools"]),
        metadata={k: list(v) for k, v in wire["metadata"].items()},
        body=wire["body"],
    )


def _jittered_interval(interval_s: float) -> float:
    """The next tick's delay: the interval with ±10% jitter, so a fleet of
    loaders never revalidates in lockstep."""
    return interval_s * (0.9 + 0.2 * random.random())


@dataclass
class SkillSync:
    """A sync handle for one `(source url, scope)`. `refresh()` is one
    conditional pull + diff apply; `start()` keeps refreshing on a jittered
    timer chain until `stop()` or a permanent auth failure."""

    catalog: SkillCatalog
    config: SourceConfig
    fetch_impl: FetchImpl = field(default=fetch_catalog)

    def __post_init__(self) -> None:
        self._refresh_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._etag: str | None = None
        self._synced_ids: set[str] = set()
        self._last_synced_at: datetime | None = None
        self._consecutive_failures = 0
        self._interval_s: float | None = None
        self._timer: threading.Timer | None = None
        self._stopped = False
        self._auth_failed = False

    @property
    def last_synced_at(self) -> datetime | None:
        return self._last_synced_at

    @property
    def consecutive_failures(self) -> int:
        return self._consecutive_failures

    @property
    def owned_count(self) -> int:
        return len(self._synced_ids)

    def refresh(self) -> SyncResult:
        """One conditional pull + diff apply, serialized via a lock. Raises the
        typed fetch errors; a failure keeps the replica and bumps
        `consecutive_failures`."""
        with self._refresh_lock:
            try:
                result = self.fetch_impl(self.config, self._etag)
            except Exception:
                self._consecutive_failures += 1
                raise
            sync_result = (
                self._apply(result)
                if isinstance(result, CatalogChanged)
                else SyncResult(added=0, updated=0, removed=0, conflicts=[], unchanged=True)
            )
            self._last_synced_at = datetime.now(timezone.utc)
            self._consecutive_failures = 0
            return sync_result

    def _apply(self, result: CatalogChanged) -> SyncResult:
        added = updated = removed = 0
        conflicts: list[str] = []
        wire_ids: set[str] = set()
        for wire in result.catalog.skills:
            skill = _to_skill(wire)
            wire_ids.add(skill.id)
            if skill.id in self._synced_ids:
                existing = self.catalog.get(skill.id)
                if existing is None or not skills_equal(existing, skill):
                    self.catalog.upsert(skill)
                    updated += 1
            elif self.catalog.has(skill.id):
                conflicts.append(skill.id)
            else:
                self.catalog.register(skill)
                self._synced_ids.add(skill.id)
                added += 1
        for gone in sorted(self._synced_ids - wire_ids):
            self.catalog.remove(gone)
            self._synced_ids.discard(gone)
            removed += 1
        self._etag = result.etag
        return SyncResult(
            added=added, updated=updated, removed=removed, conflicts=conflicts, unchanged=False
        )

    def start(self, interval_s: float) -> None:
        """Keep refreshing every `interval_s` seconds (±10% jitter) on a daemon
        timer chain. Transient errors keep the chain; an auth failure stops it
        permanently."""
        with self._state_lock:
            if self._auth_failed:
                return
            self._stopped = False
            self._interval_s = interval_s
            self._schedule_locked()

    def stop(self) -> None:
        """Cancel the timer chain. Idempotent and safe to race with a tick."""
        with self._state_lock:
            self._stopped = True
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None

    def _schedule_locked(self) -> None:
        if self._stopped or self._auth_failed or self._interval_s is None:
            return
        timer = threading.Timer(_jittered_interval(self._interval_s), self._tick)
        timer.daemon = True
        self._timer = timer
        timer.start()

    def _tick(self) -> None:
        try:
            self.refresh()
        except AuthError:
            with self._state_lock:
                self._auth_failed = True
                self._timer = None
            return
        except ApiError:
            pass  # transient — the replica stays live, the chain continues
        with self._state_lock:
            self._timer = None
            self._schedule_locked()
