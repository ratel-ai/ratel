"""Typed error taxonomy for the loader, mapped from the frozen v1 error body
`{error: {code, message, details?}}` (`protocol/v1/schema/error.schema.json`).
A malformed body is tolerated — the HTTP status alone picks the type and a
per-status fallback code.
"""

from __future__ import annotations

import json

__all__ = [
    "ApiError",
    "AuthError",
    "ConfigError",
    "UnavailableError",
    "error_from_response",
]


class ConfigError(Exception):
    """No source is configured / the configuration is unusable. Fails fast,
    never retried."""


class ApiError(Exception):
    """Any non-2xx the source answered with. `status` is the HTTP status
    (`None` only for network-level failures, see `UnavailableError`); `code`
    is the frozen error-body code, or a per-status fallback."""

    def __init__(self, message: str, status: int | None, code: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class AuthError(ApiError):
    """401 — missing, malformed, unknown, or revoked key. Terminal for a
    sync chain."""

    def __init__(self, message: str, status: int = 401, code: str = "unauthorized") -> None:
        super().__init__(message, status, code)


class UnavailableError(ApiError):
    """503 or a network-level failure (`status=None`) — the source is
    unreachable; the last-pulled replica stays live."""

    def __init__(
        self, message: str, status: int | None = 503, code: str = "unavailable"
    ) -> None:
        super().__init__(message, status, code)


_FALLBACK_CODES = {
    400: "invalid_request",
    401: "unauthorized",
    404: "not_found",
    503: "unavailable",
}


def _parse_error_body(body: bytes) -> tuple[str | None, str | None]:
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None, None
    if not isinstance(parsed, dict):
        return None, None
    error = parsed.get("error")
    if not isinstance(error, dict):
        return None, None
    code = error.get("code")
    message = error.get("message")
    return (
        code if isinstance(code, str) else None,
        message if isinstance(message, str) else None,
    )


def error_from_response(status: int, body: bytes) -> ApiError:
    """Map a non-2xx `/v1` response to a typed error, tolerating malformed
    bodies (the HTTP status wins)."""
    body_code, body_message = _parse_error_body(body)
    code = body_code or _FALLBACK_CODES.get(status, "unknown")
    message = f"catalog source responded {status}"
    if body_message:
        message = f"{message}: {body_message}"
    if status == 401:
        return AuthError(message, status=status, code=code)
    if status == 503:
        return UnavailableError(message, status=status, code=code)
    return ApiError(message, status, code)
