"""One conditional GET of a source's `/v1/catalog` — the single place the
loader touches the network (stdlib `urllib`, no HTTP client dependency).
Everything above it consumes the changed/unchanged result objects.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Union
from urllib.parse import urlencode

from ratel_ai import SourceConfig

from .errors import ApiError, UnavailableError, error_from_response

__all__ = [
    "CatalogChanged",
    "CatalogResponse",
    "CatalogUnchanged",
    "FetchCatalogResult",
    "fetch_catalog",
]

_TIMEOUT_S = 30.0


@dataclass(frozen=True)
class CatalogResponse:
    """The 200 body of `GET /v1/catalog` (`catalog-response.schema.json`).
    `skills` stay in wire shape; callers project them."""

    catalog_version: str
    skills: list[dict[str, Any]]


@dataclass(frozen=True)
class CatalogChanged:
    etag: str
    catalog: CatalogResponse
    changed: bool = field(default=True, init=False)


@dataclass(frozen=True)
class CatalogUnchanged:
    changed: bool = field(default=False, init=False)


FetchCatalogResult = Union[CatalogChanged, CatalogUnchanged]


def fetch_catalog(config: SourceConfig, etag: str | None = None) -> FetchCatalogResult:
    """Conditional GET of `{config.url}/v1/catalog` (+ `?scope=`). Sends the
    Bearer key on every request and `If-None-Match` when `etag` is known;
    raises the typed errors from `.errors` on any failure."""
    url = f"{config.url.rstrip('/')}/v1/catalog"
    if config.scope is not None:
        url += "?" + urlencode({"scope": config.scope})

    request = urllib.request.Request(url)
    if config.api_key is not None:
        request.add_header("Authorization", f"Bearer {config.api_key}")
    if etag is not None:
        request.add_header("If-None-Match", etag)

    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT_S) as response:
            status: int = response.status
            header_etag: str | None = response.headers.get("ETag")
            body = response.read()
    except urllib.error.HTTPError as err:
        if err.code == 304:
            return CatalogUnchanged()
        try:
            error_body = err.read()
        except OSError:
            error_body = b""
        raise error_from_response(err.code, error_body) from None
    except (urllib.error.URLError, OSError) as err:
        raise UnavailableError(
            f"catalog source unreachable: {config.url}: {err}", status=None
        ) from err

    if status == 304:
        return CatalogUnchanged()

    try:
        parsed = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ApiError(
            "catalog source returned a non-JSON 200 body", status, "invalid_body"
        ) from None
    catalog_version = parsed.get("catalogVersion") if isinstance(parsed, dict) else None
    skills = parsed.get("skills") if isinstance(parsed, dict) else None
    if not isinstance(catalog_version, str) or not isinstance(skills, list):
        raise ApiError(
            "catalog source returned an invalid catalog body (catalogVersion/skills)",
            status,
            "invalid_body",
        )
    return CatalogChanged(
        etag=header_etag or f'"{catalog_version}"',
        catalog=CatalogResponse(catalog_version=catalog_version, skills=skills),
    )
