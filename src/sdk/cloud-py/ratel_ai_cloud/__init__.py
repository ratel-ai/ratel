"""Ratel cloud catalog-source loader (protocol/v1 pull-sync).

Pull-syncs a project's published skills into a local `ratel_ai.SkillCatalog`
over the frozen protocol/v1 contract; retrieval stays local (ADR-0003).
`create_skill_sync` is the offline-tolerant handle; `sync_skills` the one-shot
that raises. Configuration follows the source seam: explicit options beat the
`RATEL_URL` / `RATEL_API_KEY` environment; no url anywhere is a `ConfigError`
(unset `RATEL_URL` is the embedded floor — hosts simply don't attach a loader).
"""

from __future__ import annotations

from collections.abc import Mapping

from ratel_ai import SkillCatalog, SourceConfig, SourceOptions, resolve_source_config

from .errors import ApiError, AuthError, ConfigError, UnavailableError
from .fetch_catalog import (
    CatalogChanged,
    CatalogResponse,
    CatalogUnchanged,
    FetchCatalogResult,
    fetch_catalog,
)
from .skill_sync import SkillSync, SyncResult, skills_equal

__all__ = [
    "ApiError",
    "AuthError",
    "CatalogChanged",
    "CatalogResponse",
    "CatalogUnchanged",
    "ConfigError",
    "FetchCatalogResult",
    "SkillSync",
    "SyncResult",
    "UnavailableError",
    "create_skill_sync",
    "fetch_catalog",
    "skills_equal",
    "sync_skills",
]


def _resolve(
    url: str | None,
    api_key: str | None,
    scope: str | None,
    env: Mapping[str, str] | None,
) -> SourceConfig:
    config = resolve_source_config(SourceOptions(url=url, api_key=api_key, scope=scope), env)
    if config is None:
        raise ConfigError(
            "no catalog source configured: pass url= or set RATEL_URL (ADR-0003)"
        )
    return config


def create_skill_sync(
    catalog: SkillCatalog,
    *,
    url: str | None = None,
    api_key: str | None = None,
    scope: str | None = None,
    interval_s: float | None = None,
    env: Mapping[str, str] | None = None,
) -> SkillSync:
    """Attach a source loader to `catalog` and return the sync handle.

    Offline-tolerant: the initial refresh failure is swallowed (staleness
    surfaces as `last_synced_at` / `consecutive_failures`); with `interval_s`
    the handle keeps refreshing on a jittered timer — unless the source
    rejected the key, which stops the chain before it starts.
    """
    sync = SkillSync(catalog, _resolve(url, api_key, scope, env))
    auth_failed = False
    try:
        sync.refresh()
    except AuthError:
        auth_failed = True
    except (ApiError, UnavailableError):
        pass
    if interval_s is not None and not auth_failed:
        sync.start(interval_s)
    return sync


def sync_skills(
    catalog: SkillCatalog,
    *,
    url: str | None = None,
    api_key: str | None = None,
    scope: str | None = None,
    env: Mapping[str, str] | None = None,
) -> SyncResult:
    """One-shot pull-sync into `catalog`; raises on any failure."""
    return SkillSync(catalog, _resolve(url, api_key, scope, env)).refresh()
