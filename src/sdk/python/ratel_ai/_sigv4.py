"""Minimal AWS Signature Version 4 signer for S3 REST requests.

Exists so `ExperimentalS3IntentGraphStorage` needs no `boto3` dependency —
everything here is stdlib (`hashlib`, `hmac`, `urllib`). See ADR-0025.
"""

from __future__ import annotations

import hashlib
import hmac as hmac_lib
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import quote, urlparse


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
    dt = date or datetime.now(timezone.utc)
    amz_date = dt.strftime("%Y%m%dT%H%M%SZ")
    date_only = dt.strftime("%Y%m%d")
    payload_hash = _sha256_hex(body)

    all_headers: dict[str, str] = {
        **headers,
        "host": host,
        "x-amz-date": amz_date,
        "x-amz-content-sha256": payload_hash,
    }
    if session_token:
        all_headers["x-amz-security-token"] = session_token

    signed_header_names = sorted(name.lower() for name in all_headers)
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

    endpoint_url = urlparse(endpoint)
    scheme = "http" if endpoint_url.scheme == "http" else "https"
    path_style = force_path_style if force_path_style is not None else True

    if path_style:
        return S3EndpointTarget(
            scheme=scheme, host=endpoint_url.netloc, path=f"/{bucket}/{encoded_key}"
        )
    return S3EndpointTarget(
        scheme=scheme, host=f"{bucket}.{endpoint_url.netloc}", path=f"/{encoded_key}"
    )
