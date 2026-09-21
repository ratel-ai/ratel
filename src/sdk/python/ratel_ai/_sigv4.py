"""Minimal AWS Signature Version 4 signer for S3 REST requests.

Exists so `ExperimentalS3IntentGraphStorage` needs no `boto3` dependency —
everything here is stdlib (`hashlib`, `hmac`, `urllib`). See ADR-0025.
"""

from __future__ import annotations

import hashlib
import hmac as hmac_lib
from dataclasses import dataclass
from datetime import datetime, timezone


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
