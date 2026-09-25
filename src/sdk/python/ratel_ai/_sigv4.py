"""Minimal AWS Signature Version 4 signer for S3 REST requests.

Exists so `S3IntentGraphStorage` needs no `boto3` dependency —
everything here is stdlib (`hashlib`, `hmac`, `urllib`). See ADR-0025.
"""

from __future__ import annotations

import hashlib
import hmac as hmac_lib
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import ParseResult, quote, urlparse


@dataclass(frozen=True)
class SignedS3Request:
    """A signed request ready to send: every header (signed + ``authorization``), lowercase keys."""

    headers: dict[str, str]


def _sha256_hex(data: str) -> str:
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def _hmac(key: bytes, data: str) -> bytes:
    return hmac_lib.new(key, data.encode("utf-8"), hashlib.sha256).digest()


def sign_s3_request(
    *,
    method: str,
    host: str,
    path: str,
    headers: dict[str, str],
    body: str,
    region: str,
    access_key_id: str,
    secret_access_key: str,
    session_token: str | None = None,
    date: datetime | None = None,
) -> SignedS3Request:
    """Sign an S3 request per AWS SigV4. Returns the full header set to send."""
    # Converted, not relabelled: strftime on a non-UTC datetime would stamp a
    # local time with a Z suffix. TS normalizes through Date.toISOString().
    dt = (date or datetime.now(timezone.utc)).astimezone(timezone.utc)
    amz_date = dt.strftime("%Y%m%dT%H%M%SZ")
    date_only = dt.strftime("%Y%m%d")
    payload_hash = _sha256_hex(body)

    # Lowercased on the way in: the canonical form is lowercase, and indexing the
    # original bag with a lowercased name misses a caller's mixed-case key.
    supplied = {
        **headers,
        "host": host,
        "x-amz-date": amz_date,
        "x-amz-content-sha256": payload_hash,
    }
    if session_token:
        supplied["x-amz-security-token"] = session_token
    all_headers: dict[str, str] = {name.lower(): value for name, value in supplied.items()}

    signed_header_names = sorted(all_headers)
    canonical_headers = "".join(
        f"{name}:{all_headers[name].strip()}\n" for name in signed_header_names
    )
    signed_headers = ";".join(signed_header_names)

    canonical_request = "\n".join(
        [method, path, "", canonical_headers, signed_headers, payload_hash]
    )

    credential_scope = f"{date_only}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(
        ["AWS4-HMAC-SHA256", amz_date, credential_scope, _sha256_hex(canonical_request)]
    )

    k_date = _hmac(f"AWS4{secret_access_key}".encode(), date_only)
    k_region = _hmac(k_date, region)
    k_service = _hmac(k_region, "s3")
    k_signing = _hmac(k_service, "aws4_request")
    signature = hmac_lib.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    authorization = (
        f"AWS4-HMAC-SHA256 Credential={access_key_id}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return SignedS3Request(headers={**all_headers, "authorization": authorization})


@dataclass(frozen=True)
class S3EndpointTarget:
    """Where a `resolve_s3_endpoint` request should go."""

    scheme: str  # "http" | "https"
    #: Includes the port when non-default, e.g. ``"localhost:9000"``.
    host: str
    #: Leading slash; key percent-encoded; bucket-prefixed iff path-style.
    path: str


def resolve_s3_endpoint(
    *,
    bucket: str,
    key: str,
    region: str,
    endpoint: str | None = None,
    force_path_style: bool | None = None,
) -> S3EndpointTarget:
    """Resolve the scheme/host/path an S3 (or S3-compatible) request targets.

    Pure and network-free so endpoint/path-style logic is unit-testable
    without a live server. ``force_path_style`` defaults to `True` whenever
    `endpoint` is set — what MinIO and most self-hosted S3-compatible
    services require, since virtual-hosted style needs a wildcard DNS/TLS
    setup most self-hosted deployments don't have. Pass `False` for a
    custom endpoint that supports virtual-hosted style (e.g. Cloudflare
    R2). No effect without `endpoint` — AWS S3 always uses virtual-hosted
    style.
    """
    encoded_key = "/".join(quote(part, safe="") for part in key.split("/"))

    if not endpoint:
        return S3EndpointTarget(
            scheme="https",
            host=f"{bucket}.s3.{region}.amazonaws.com",
            path=f"/{encoded_key}",
        )

    endpoint_url = _parse_endpoint(endpoint)
    scheme = endpoint_url.scheme
    host = _endpoint_host(endpoint_url)
    # A gateway mounted under a prefix keeps it: it is part of the canonical URI,
    # so dropping it signs one path and addresses another.
    prefix = endpoint_url.path.rstrip("/")
    path_style = force_path_style if force_path_style is not None else True

    if path_style:
        return S3EndpointTarget(
            scheme=scheme, host=host, path=f"{prefix}/{bucket}/{encoded_key}"
        )
    return S3EndpointTarget(
        scheme=scheme, host=f"{bucket}.{host}", path=f"{prefix}/{encoded_key}"
    )


def _parse_endpoint(endpoint: str) -> ParseResult:
    """Parse `endpoint`, rejecting anything that is not an absolute http(s) URL.

    ``urlparse("minio.internal:9000")`` does not raise: it reads the host as a
    scheme and leaves the location empty, which would sign a request against an
    empty host.
    """
    invalid = ValueError(
        f"invalid endpoint {endpoint!r}: expected an absolute http(s) URL, "
        'e.g. "http://localhost:9000"'
    )
    try:
        url = urlparse(endpoint)
        url.port  # noqa: B018 - raises for a non-numeric port
    except ValueError:
        raise invalid from None
    if url.scheme not in ("http", "https") or not url.netloc:
        raise invalid
    return url


def _endpoint_host(url: ParseResult) -> str:
    """The `Host` header for `url`, matching what TS's ``URL.host`` produces.

    ``netloc`` would carry any userinfo into the signed header; ``hostname``
    drops the brackets an IPv6 literal needs; and a port that is the scheme's
    default is omitted, as the URL standard does.
    """
    host = url.hostname or ""
    if ":" in host:  # IPv6 literal, which urlparse unwraps
        host = f"[{host}]"
    port = url.port
    if port is None or port == (80 if url.scheme == "http" else 443):
        return host
    return f"{host}:{port}"
