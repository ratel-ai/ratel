"""Catalog-source config seam — the Python mirror of `src/sdk/ts/src/source.ts`.

Pure resolution of where a catalog-source loader pulls from (ADR-0003): explicit
options beat the `RATEL_URL` / `RATEL_API_KEY` environment; no url anywhere means
no source (the permanent embedded floor). Loaders (e.g. `ratel-ai-cloud`) consume
the resolved `SourceConfig`; this module never touches the network.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

__all__ = ["SOURCE_API_KEY_ENV", "SOURCE_URL_ENV", "SourceConfig", "SourceOptions"]

SOURCE_URL_ENV = "RATEL_URL"
SOURCE_API_KEY_ENV = "RATEL_API_KEY"


@dataclass(frozen=True)
class SourceOptions:
    """Explicit loader options; any field set here wins over the environment.

    `scope` is an opaque subject selector passed through as `?scope=` (ADR-0010);
    it is options-only — never read from the environment.
    """

    url: str | None = None
    api_key: str | None = None
    scope: str | None = None


@dataclass(frozen=True)
class SourceConfig:
    """A resolved catalog source: base URL, Bearer key, and fixed scope."""

    url: str
    api_key: str | None
    scope: str | None


def resolve_source_config(
    options: SourceOptions | None = None,
    env: Mapping[str, str] | None = None,
) -> SourceConfig | None:
    """Resolve options + environment into a `SourceConfig`, or `None` when no
    url is configured anywhere. Pure and env-injectable (the
    `resolve_otlp_config` pattern) so precedence is testable without patching
    `os.environ`.
    """
    opts = options or SourceOptions()
    environ = os.environ if env is None else env
    url = opts.url or environ.get(SOURCE_URL_ENV)
    if not url:
        return None
    return SourceConfig(
        url=url,
        api_key=opts.api_key or environ.get(SOURCE_API_KEY_ENV),
        scope=opts.scope,
    )
