"""Send one feedback item (thumbs, rating, comment) to Ratel Cloud (experimental).

Feedback is not a runtime event: it goes straight to ``POST /api/v1/feedback``
over stdlib ``urllib`` and never raises on a network error or a non-2xx answer.
"""

from __future__ import annotations

import importlib.metadata as importlib_metadata
import json
import math
import os
import urllib.error
import urllib.request
import uuid
import warnings
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Union

from .telemetry import ambient_projection

#: ``(url, headers, body, timeout) -> (status, response body)``; inject it in tests.
FeedbackTransport = Callable[[str, Mapping[str, str], bytes, float], tuple[int, bytes]]
FeedbackValue = Union[bool, int, float, str]

DEFAULT_BASE_URL = "https://cloud.ratel.sh"
FEEDBACK_PATH = "/api/v1/feedback"
API_KEY_ENV = "RATEL_API_KEY"
OTLP_ENDPOINT_ENV = "RATEL_OTLP_ENDPOINT"
LEGACY_URL_ENV = "RATEL_URL"
_OTLP_TRACES_SUFFIX = "/v1/traces"
_LINK_FIELDS = ("trace_id", "span_id", "turn_id", "session_id", "end_user_id")


@dataclass(frozen=True)
class FeedbackResult:
    """The outcome of one :func:`experimental_feedback` call.

    Attributes:
        ok: whether the server answered 2xx.
        status: the HTTP status, or ``None`` when no answer arrived.
        accepted: items the server stored.
        duplicate: items the server already had (same idempotency key).
        rejected: items the server refused.
        body: the parsed JSON answer, when there is one.
        error: why the call failed, or ``None``.
    """

    ok: bool
    status: int | None = None
    accepted: int = 0
    duplicate: int = 0
    rejected: int = 0
    body: Any = None
    error: str | None = None


def experimental_feedback(
    *,
    name: str,
    value: FeedbackValue,
    trace_id: str | None = None,
    span_id: str | None = None,
    turn_id: str | None = None,
    session_id: str | None = None,
    end_user_id: str | None = None,
    comment: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    observed_at: datetime | str | None = None,
    idempotency_key: str | None = None,
    api_key: str | None = None,
    endpoint: str | None = None,
    timeout: float = 5.0,
    transport: FeedbackTransport | None = None,
) -> FeedbackResult:
    """Send one feedback item to Ratel Cloud (``POST {base}/api/v1/feedback``).

    **Experimental** — may change without a major version bump.

    ``turn_id`` and ``end_user_id`` default from the active turn (``turn_id`` only
    when it is a UUID); ``trace_id`` and ``span_id`` from the current OTel span.
    Explicit arguments win.

    Raises:
        ValueError: an argument is invalid, no link id is set, or no API key is
            configured. Nothing is sent.

    Returns:
        The outcome. A network error, a timeout or a non-2xx answer returns
        ``ok=False`` and warns with ``RuntimeWarning``; it never raises.
    """
    links = _resolve_links(
        trace_id=trace_id,
        span_id=span_id,
        turn_id=turn_id,
        session_id=session_id,
        end_user_id=end_user_id,
    )
    _validate(name, value, links, metadata)
    key = api_key or os.environ.get(API_KEY_ENV)
    if not key:
        raise ValueError(f"experimental_feedback: no API key. Pass api_key= or set {API_KEY_ENV}.")

    item: dict[str, Any] = {"idempotency_key": idempotency_key or str(uuid.uuid4())}
    item.update(links)
    item["name"] = name
    item["value"] = value
    if comment is not None:
        item["comment"] = comment
    if metadata is not None:
        item["metadata"] = dict(metadata)
    item["observed_at"] = _iso_utc(observed_at)
    try:
        body = json.dumps({"feedback": [item]}, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"experimental_feedback: metadata is not JSON-serializable: {exc}"
        ) from exc

    url = _resolve_base_url(endpoint) + FEEDBACK_PATH
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}",
        "x-ratel-sdk": f"ratel-ai-python/{_sdk_version()}",
    }
    send = transport or _urllib_transport
    try:
        status, raw = send(url, headers, body, timeout)
    except Exception as exc:  # never raise a delivery failure into the caller
        return _failed(None, None, f"{type(exc).__name__}: {exc}")
    answer = _parse_json(raw)
    if not 200 <= status < 300:
        return _failed(status, answer, f"HTTP {status}")
    counts = answer if isinstance(answer, dict) else {}
    return FeedbackResult(
        ok=True,
        status=status,
        accepted=_count(counts, "accepted"),
        duplicate=_count(counts, "duplicate"),
        rejected=_count(counts, "rejected"),
        body=answer,
    )


def _resolve_links(**explicit: str | None) -> dict[str, str]:
    """Explicit link ids, filled from the active turn and the current OTel span."""
    ambient = ambient_projection()
    links: dict[str, str] = {}
    for field in _LINK_FIELDS:
        value = explicit[field]
        if value is None:
            fallback = ambient.get(field)
            if field == "turn_id" and not _is_uuid(fallback):
                fallback = None
            value = fallback if isinstance(fallback, str) else None
        if value is not None:
            links[field] = value
    return links


def _validate(name: object, value: object, links: Mapping[str, object], metadata: object) -> None:
    if not links:
        raise ValueError(
            "experimental_feedback: no link. Pass at least one of "
            + ", ".join(_LINK_FIELDS)
            + " (or call it inside a turn)."
        )
    for field, link in links.items():
        if not isinstance(link, str) or not link:
            raise ValueError(f"experimental_feedback: {field} must be a non-empty string")
    if "turn_id" in links and not _is_uuid(links["turn_id"]):
        raise ValueError("experimental_feedback: turn_id must be a UUID")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("experimental_feedback: name must be a non-empty string")
    if not _is_feedback_value(value):
        raise ValueError("experimental_feedback: value must be a bool, a finite number or a str")
    if metadata is not None and not isinstance(metadata, Mapping):
        raise ValueError("experimental_feedback: metadata must be a dict")


def _is_uuid(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def _is_feedback_value(value: object) -> bool:
    if isinstance(value, (bool, str)):
        return True
    return isinstance(value, (int, float)) and math.isfinite(value)


def _iso_utc(observed_at: datetime | str | None) -> str:
    if isinstance(observed_at, str):
        return observed_at
    moment = observed_at or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    utc = moment.astimezone(timezone.utc)
    return utc.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _resolve_base_url(endpoint: str | None) -> str:
    """``endpoint``, else ``RATEL_OTLP_ENDPOINT`` minus ``/v1/traces``, else ``RATEL_URL``."""
    base = (
        endpoint
        or os.environ.get(OTLP_ENDPOINT_ENV)
        or os.environ.get(LEGACY_URL_ENV)
        or DEFAULT_BASE_URL
    ).rstrip("/")
    if base.endswith(_OTLP_TRACES_SUFFIX):
        base = base[: -len(_OTLP_TRACES_SUFFIX)]
    return base


def _sdk_version() -> str:
    try:
        return importlib_metadata.version("ratel-ai")
    except importlib_metadata.PackageNotFoundError:
        return "unknown"


def _urllib_transport(
    url: str, headers: Mapping[str, str], body: bytes, timeout: float
) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=dict(headers), method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return int(response.status), bytes(response.read())
    except urllib.error.HTTPError as exc:  # a non-2xx answer, not a network failure
        return int(exc.code), bytes(exc.read())


def _parse_json(raw: bytes) -> Any:
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def _count(answer: Mapping[str, Any], field: str) -> int:
    value = answer.get(field)
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _failed(status: int | None, body: Any, error: str) -> FeedbackResult:
    warnings.warn(f"ratel_ai: feedback was not delivered: {error}", RuntimeWarning, stacklevel=3)
    return FeedbackResult(ok=False, status=status, body=body, error=error)
