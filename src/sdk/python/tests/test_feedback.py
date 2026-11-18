"""`experimental_feedback`: one feedback item to Ratel Cloud, never raising on the wire."""

from __future__ import annotations

import json
import socket
import uuid
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.error import URLError

import pytest
from opentelemetry import trace
from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags

import ratel_ai
from ratel_ai import FeedbackResult, ToolCatalog, experimental_feedback

TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
TURN_UUID = "6f1c2b0e-8a4d-4b7e-9c3a-2d5e7f9a1b3c"
OK_BODY = {"received": 1, "accepted": 1, "duplicate": 0, "rejected": 0, "results": []}


class FakeTransport:
    def __init__(
        self, status: int = 200, body: Any = OK_BODY, error: BaseException | None = None
    ) -> None:
        self.calls: list[tuple[str, dict[str, str], dict[str, Any], float]] = []
        self._status = status
        self._body = body
        self._error = error

    def __call__(
        self, url: str, headers: Mapping[str, str], body: bytes, timeout: float
    ) -> tuple[int, bytes]:
        self.calls.append((url, dict(headers), json.loads(body), timeout))
        if self._error is not None:
            raise self._error
        return self._status, json.dumps(self._body).encode()

    @property
    def item(self) -> dict[str, Any]:
        (_url, _headers, body, _timeout) = self.calls[0]
        (item,) = body["feedback"]
        return item  # type: ignore[no-any-return]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("RATEL_API_KEY", "RATEL_OTLP_ENDPOINT", "RATEL_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("RATEL_API_KEY", "rk_test")


def test_sends_one_contract_item_with_headers() -> None:
    transport = FakeTransport()

    result = experimental_feedback(
        name="thumbs", value=False, trace_id=TRACE_ID, transport=transport
    )

    assert len(transport.calls) == 1
    url, headers, body, timeout = transport.calls[0]
    assert url == "https://cloud.ratel.sh/api/v1/feedback"
    assert headers["Content-Type"] == "application/json"
    assert headers["Authorization"] == "Bearer rk_test"
    assert headers["x-ratel-sdk"].startswith("ratel-ai-python/")
    assert timeout == 5.0
    (item,) = body["feedback"]
    assert set(item) == {"idempotency_key", "observed_at", "trace_id", "name", "value"}
    assert uuid.UUID(item["idempotency_key"])
    observed = datetime.fromisoformat(item["observed_at"].replace("Z", "+00:00"))
    assert observed.utcoffset() == timedelta(0)
    assert item["trace_id"] == TRACE_ID
    assert item["name"] == "thumbs"
    assert item["value"] is False
    assert result == FeedbackResult(
        ok=True, status=200, accepted=1, duplicate=0, rejected=0, body=OK_BODY, error=None
    )


def test_optional_fields_pass_through() -> None:
    transport = FakeTransport()
    observed = datetime(2026, 11, 18, 10, 0, tzinfo=timezone.utc)

    experimental_feedback(
        name="rating",
        value=4.5,
        session_id="s-1",
        comment="nice",
        metadata={"k": "v"},
        observed_at=observed,
        idempotency_key="idem-1",
        api_key="rk_arg",
        endpoint="https://example.test/prefix/",
        timeout=1.5,
        transport=transport,
    )

    url, headers, _body, timeout = transport.calls[0]
    assert url == "https://example.test/prefix/api/v1/feedback"
    assert headers["Authorization"] == "Bearer rk_arg"
    assert timeout == 1.5
    assert transport.item == {
        "idempotency_key": "idem-1",
        "session_id": "s-1",
        "name": "rating",
        "value": 4.5,
        "comment": "nice",
        "metadata": {"k": "v"},
        "observed_at": "2026-11-18T10:00:00.000Z",
    }


def test_ids_default_from_active_turn() -> None:
    transport = FakeTransport()

    with ToolCatalog().turn(TURN_UUID, end_user_id="user-7"):
        experimental_feedback(name="thumbs", value=True, transport=transport)

    assert transport.item["turn_id"] == TURN_UUID
    assert transport.item["end_user_id"] == "user-7"


def test_explicit_ids_win_over_active_turn() -> None:
    transport = FakeTransport()
    other_turn = str(uuid.uuid4())

    with ToolCatalog().turn(TURN_UUID, end_user_id="user-7"):
        experimental_feedback(
            name="thumbs",
            value=True,
            turn_id=other_turn,
            end_user_id="user-9",
            transport=transport,
        )

    assert transport.item["turn_id"] == other_turn
    assert transport.item["end_user_id"] == "user-9"


def test_non_uuid_active_turn_id_is_not_sent() -> None:
    # A minted turn id is a ULID; the server rejects a non-UUID turn_id.
    transport = FakeTransport()

    with ToolCatalog().turn(end_user_id="user-7"):
        experimental_feedback(name="thumbs", value=True, transport=transport)

    assert "turn_id" not in transport.item
    assert transport.item["end_user_id"] == "user-7"


def test_trace_and_span_default_from_ambient_otel_span() -> None:
    transport = FakeTransport()
    context = SpanContext(
        trace_id=int(TRACE_ID, 16),
        span_id=0x00F067AA0BA902B7,
        is_remote=False,
        trace_flags=TraceFlags(TraceFlags.SAMPLED),
    )

    with trace.use_span(NonRecordingSpan(context)):
        experimental_feedback(name="thumbs", value=True, transport=transport)

    assert transport.item["trace_id"] == TRACE_ID
    assert transport.item["span_id"] == "00f067aa0ba902b7"


def test_no_link_raises_before_request() -> None:
    transport = FakeTransport()

    with pytest.raises(ValueError) as raised:
        experimental_feedback(name="thumbs", value=True, transport=transport)

    for field in ("trace_id", "span_id", "turn_id", "session_id", "end_user_id"):
        assert field in str(raised.value)
    assert transport.calls == []


def test_missing_api_key_raises_before_request(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RATEL_API_KEY")
    transport = FakeTransport()

    with pytest.raises(ValueError, match="RATEL_API_KEY"):
        experimental_feedback(name="thumbs", value=True, trace_id=TRACE_ID, transport=transport)

    assert transport.calls == []


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"name": ""}, "name"),
        ({"value": None}, "value"),
        ({"value": float("nan")}, "value"),
        ({"value": float("inf")}, "value"),
        ({"value": [1]}, "value"),
        ({"turn_id": "not-a-uuid"}, "turn_id"),
        ({"metadata": ["a"]}, "metadata"),
        ({"metadata": {"k": object()}}, "metadata"),
    ],
)
def test_bad_input_raises_before_request(overrides: dict[str, Any], message: str) -> None:
    transport = FakeTransport()
    kwargs: dict[str, Any] = {"name": "thumbs", "value": True, "trace_id": TRACE_ID}
    kwargs.update(overrides)

    with pytest.raises(ValueError, match=message):
        experimental_feedback(**kwargs, transport=transport)

    assert transport.calls == []


@pytest.mark.parametrize(
    "error",
    [URLError("unreachable"), OSError("reset"), socket.timeout("timed out"), TimeoutError()],
)
def test_transport_failure_returns_not_ok(error: BaseException) -> None:
    transport = FakeTransport(error=error)

    with pytest.warns(RuntimeWarning, match="feedback"):
        result = experimental_feedback(
            name="thumbs", value=True, trace_id=TRACE_ID, transport=transport
        )

    assert result.ok is False
    assert result.status is None
    assert result.error


def test_server_error_returns_not_ok() -> None:
    transport = FakeTransport(status=500, body={"error": "boom"})

    with pytest.warns(RuntimeWarning, match="500"):
        result = experimental_feedback(
            name="thumbs", value=True, trace_id=TRACE_ID, transport=transport
        )

    assert result.ok is False
    assert result.status == 500
    assert result.body == {"error": "boom"}


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({"RATEL_OTLP_ENDPOINT": "https://otlp.test/v1/traces"}, "https://otlp.test"),
        ({"RATEL_OTLP_ENDPOINT": "https://otlp.test/ratel/v1/traces"}, "https://otlp.test/ratel"),
        (
            {"RATEL_OTLP_ENDPOINT": "https://otlp.test/v1/traces", "RATEL_URL": "https://u.test"},
            "https://otlp.test",
        ),
        ({"RATEL_URL": "https://u.test/"}, "https://u.test"),
        ({}, "https://cloud.ratel.sh"),
    ],
)
def test_base_url_env_precedence(
    monkeypatch: pytest.MonkeyPatch, env: dict[str, str], expected: str
) -> None:
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    transport = FakeTransport()

    experimental_feedback(name="thumbs", value=True, trace_id=TRACE_ID, transport=transport)

    assert transport.calls[0][0] == f"{expected}/api/v1/feedback"


def test_endpoint_arg_wins_over_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RATEL_OTLP_ENDPOINT", "https://otlp.test/v1/traces")
    transport = FakeTransport()

    experimental_feedback(
        name="thumbs",
        value=True,
        trace_id=TRACE_ID,
        endpoint="https://arg.test",
        transport=transport,
    )

    assert transport.calls[0][0] == "https://arg.test/api/v1/feedback"


def test_feedback_is_exported_but_not_a_runtime_event() -> None:
    assert {"experimental_feedback", "FeedbackResult"} <= set(ratel_ai.__all__)
    assert "feedback" not in ratel_ai.RUNTIME_EVENT_TYPES
