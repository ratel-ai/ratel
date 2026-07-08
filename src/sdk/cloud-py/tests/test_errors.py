"""Typed error taxonomy mapped from the frozen `{error:{code,message,details?}}` body."""

from __future__ import annotations

import json

from ratel_ai_cloud.errors import (
    ApiError,
    AuthError,
    ConfigError,
    UnavailableError,
    error_from_response,
)


def _body(code: str, message: str) -> bytes:
    return json.dumps({"error": {"code": code, "message": message}}).encode("utf-8")


def test_401_maps_to_auth_error() -> None:
    err = error_from_response(401, _body("unauthorized", "unknown key"))
    assert isinstance(err, AuthError)
    assert isinstance(err, ApiError)
    assert err.status == 401
    assert err.code == "unauthorized"
    assert "unknown key" in str(err)


def test_503_maps_to_unavailable_error() -> None:
    err = error_from_response(503, _body("unavailable", "key store unreachable"))
    assert isinstance(err, UnavailableError)
    assert isinstance(err, ApiError)
    assert err.status == 503
    assert err.code == "unavailable"


def test_other_statuses_map_to_api_error() -> None:
    err = error_from_response(404, _body("not_found", "no such catalog"))
    assert type(err) is ApiError
    assert err.status == 404
    assert err.code == "not_found"

    err = error_from_response(400, _body("invalid_request", "bad scope"))
    assert err.status == 400
    assert err.code == "invalid_request"


def test_malformed_bodies_are_tolerated() -> None:
    for status, expected_type, expected_code in [
        (401, AuthError, "unauthorized"),
        (503, UnavailableError, "unavailable"),
        (404, ApiError, "not_found"),
        (400, ApiError, "invalid_request"),
        (500, ApiError, "unknown"),
    ]:
        for body in [b"", b"not json", b'{"error": "flat string"}', b'{"unrelated": true}']:
            err = error_from_response(status, body)
            assert isinstance(err, expected_type), (status, body)
            assert err.status == status
            assert err.code == expected_code, (status, body)


def test_unavailable_error_carries_optional_status_for_network_failures() -> None:
    err = UnavailableError("connection refused", status=None)
    assert err.status is None
    assert err.code == "unavailable"


def test_config_error_is_a_distinct_type() -> None:
    assert not issubclass(ConfigError, ApiError)
    assert issubclass(ConfigError, Exception)
