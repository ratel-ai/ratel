"""OpenTelemetry emission tests — mirrors `src/sdk/ts/src/telemetry.test.ts`.

Instrumentation is verified through the public OTel API: register an in-memory
exporter as the global provider, drive the SDK, and read the spans back. The SDK
never imports the exporter — it emits to whatever provider is active, exactly as a
host deployment would wire it. These tests need the OpenTelemetry SDK
(`ratel-ai[otlp]` or a bare `opentelemetry-sdk`); they skip if it is absent.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import tomllib

pytest.importorskip("opentelemetry.sdk.trace", reason="OpenTelemetry SDK not installed")
pytest.importorskip("ratel_ai_telemetry", reason="ratel-ai telemetry vocabulary not installed")

from opentelemetry import trace  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import SimpleSpanProcessor  # noqa: E402
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (  # noqa: E402
    InMemorySpanExporter,
)
from opentelemetry.trace import StatusCode  # noqa: E402
from ratel_ai_telemetry import set_content_capture  # noqa: E402

from ratel_ai import (  # noqa: E402
    ExecutableTool,
    Skill,
    SkillCatalog,
    ToolCatalog,
    TraceSinkConfig,
    configure_telemetry,
)

CAPTURE_ENV = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"

# OpenTelemetry forbids overriding the global provider once set, so register one
# provider for the whole module and give each test a clean exporter via clear().
_EXPORTER = InMemorySpanExporter()
_PROVIDER = TracerProvider()
_PROVIDER.add_span_processor(SimpleSpanProcessor(_EXPORTER))
trace.set_tracer_provider(_PROVIDER)


@pytest.fixture()
def exporter(monkeypatch: pytest.MonkeyPatch) -> Any:
    """The shared in-memory exporter, cleared so each test sees only its own spans."""
    monkeypatch.delenv(CAPTURE_ENV, raising=False)
    _EXPORTER.clear()
    return _EXPORTER


def _read_file() -> ExecutableTool:
    return ExecutableTool(
        id="read_file",
        name="read_file",
        description="Read a file from local disk and return its textual contents.",
        input_schema={"properties": {"path": {"type": "string"}}},
        output_schema={"properties": {"contents": {"type": "string"}}},
        execute=lambda args: {"contents": f"contents of {args.get('path')}"},
    )


def _spans_named(exp: Any, name: str) -> list[Any]:
    return [s for s in exp.get_finished_spans() if s.name == name]


INFERENCE_DETAILS = "gen_ai.client.inference.operation.details"
SEARCH_RESULTS = "ratel.search.results"


def _event_named(span: Any, name: str) -> Any:
    """The single span event with the given name, or None."""
    return next((e for e in span.events if e.name == name), None)


@pytest.mark.asyncio
async def test_execute_tool_span_attributes(exporter: Any) -> None:
    catalog = ToolCatalog()
    await catalog.register(_read_file())
    await catalog.invoke("read_file", {"path": "/tmp/x"})

    spans = _spans_named(exporter, "execute_tool read_file")
    assert len(spans) == 1
    attrs = spans[0].attributes
    assert attrs["gen_ai.operation.name"] == "execute_tool"
    assert attrs["gen_ai.tool.name"] == "read_file"
    assert attrs["ratel.tool.args_size_bytes"] > 0
    assert spans[0].status.status_code == StatusCode.OK


@pytest.mark.asyncio
async def test_content_not_captured_by_default(exporter: Any) -> None:
    catalog = ToolCatalog()
    await catalog.register(_read_file())
    await catalog.invoke("read_file", {"path": "/secret"})

    attrs = _spans_named(exporter, "execute_tool read_file")[0].attributes
    assert "gen_ai.tool.call.arguments" not in attrs
    assert "gen_ai.tool.call.result" not in attrs


@pytest.mark.asyncio
async def test_content_captured_when_gate_set(
    exporter: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(CAPTURE_ENV, "SPAN_AND_EVENT")
    catalog = ToolCatalog()
    await catalog.register(_read_file())
    await catalog.invoke("read_file", {"path": "/p"})

    span = _spans_named(exporter, "execute_tool read_file")[0]
    attrs = span.attributes
    assert attrs["gen_ai.tool.call.arguments"] == '{"path": "/p"}'
    assert "contents of /p" in attrs["gen_ai.tool.call.result"]
    # Dual emission: the content event is present too.
    event = _event_named(span, INFERENCE_DETAILS)
    assert event is not None
    assert "gen_ai.input.messages" in event.attributes
    assert "gen_ai.output.messages" in event.attributes


@pytest.mark.asyncio
async def test_execute_tool_emits_content_event_under_event_only(
    exporter: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(CAPTURE_ENV, "EVENT_ONLY")
    catalog = ToolCatalog()
    await catalog.register(_read_file())
    await catalog.invoke("read_file", {"path": "/p"})

    span = _spans_named(exporter, "execute_tool read_file")[0]
    # Content rides the event, not span attributes.
    assert "gen_ai.tool.call.arguments" not in span.attributes
    assert "gen_ai.tool.call.result" not in span.attributes

    event = _event_named(span, INFERENCE_DETAILS)
    assert event is not None
    assert json.loads(event.attributes["gen_ai.input.messages"]) == [
        {
            "role": "assistant",
            "parts": [{"type": "tool_call", "name": "read_file", "arguments": {"path": "/p"}}],
        }
    ]
    assert json.loads(event.attributes["gen_ai.output.messages"]) == [
        {
            "role": "tool",
            "parts": [{"type": "tool_call_response", "response": {"contents": "contents of /p"}}],
        }
    ]


@pytest.mark.asyncio
async def test_execute_tool_span_only_emits_no_content_event(
    exporter: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(CAPTURE_ENV, "SPAN_ONLY")
    catalog = ToolCatalog()
    await catalog.register(_read_file())
    await catalog.invoke("read_file", {"path": "/p"})

    span = _spans_named(exporter, "execute_tool read_file")[0]
    assert span.attributes["gen_ai.tool.call.arguments"] == '{"path": "/p"}'
    assert _event_named(span, INFERENCE_DETAILS) is None


@pytest.mark.asyncio
async def test_execute_tool_no_content_emits_neither(
    exporter: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(CAPTURE_ENV, "NO_CONTENT")
    catalog = ToolCatalog()
    await catalog.register(_read_file())
    await catalog.invoke("read_file", {"path": "/p"})

    span = _spans_named(exporter, "execute_tool read_file")[0]
    assert "gen_ai.tool.call.arguments" not in span.attributes
    assert _event_named(span, INFERENCE_DETAILS) is None


@pytest.mark.asyncio
async def test_failed_tool_emits_input_message_only_under_event_only(
    exporter: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(CAPTURE_ENV, "EVENT_ONLY")

    def boom(_args: dict[str, Any]) -> Any:
        raise RuntimeError("kaboom")

    catalog = ToolCatalog()
    await catalog.register(
        ExecutableTool(id="boom", name="boom", description="throws", execute=boom)
    )
    with pytest.raises(RuntimeError, match="kaboom"):
        await catalog.invoke("boom", {"x": 1})

    span = _spans_named(exporter, "execute_tool boom")[0]
    assert span.status.status_code == StatusCode.ERROR
    event = _event_named(span, INFERENCE_DETAILS)
    assert event is not None
    assert json.loads(event.attributes["gen_ai.input.messages"]) == [
        {
            "role": "assistant",
            "parts": [{"type": "tool_call", "name": "boom", "arguments": {"x": 1}}],
        }
    ]
    assert "gen_ai.output.messages" not in event.attributes


@pytest.mark.asyncio
async def test_execute_tool_span_error(exporter: Any) -> None:
    def boom(_args: dict[str, Any]) -> Any:
        raise RuntimeError("kaboom")

    catalog = ToolCatalog()
    await catalog.register(
        ExecutableTool(id="boom", name="boom", description="throws", execute=boom)
    )
    with pytest.raises(RuntimeError, match="kaboom"):
        await catalog.invoke("boom", {})

    span = _spans_named(exporter, "execute_tool boom")[0]
    assert span.status.status_code == StatusCode.ERROR
    assert any(e.name == "exception" for e in span.events)


@pytest.mark.asyncio
async def test_local_stream_intact_alongside_span(exporter: Any) -> None:
    catalog = ToolCatalog(trace=TraceSinkConfig("memory", session_id="s"))
    await catalog.register(_read_file())
    await catalog.invoke("read_file", {"path": "/tmp/x"})

    local = catalog.drain_trace_events()
    invoke_events = [e["type"] for e in local if str(e["type"]).startswith("invoke_")]
    assert invoke_events == ["invoke_start", "invoke_end"]
    assert len(_spans_named(exporter, "execute_tool read_file")) == 1


async def test_ratel_search_span_tool(exporter: Any) -> None:
    catalog = ToolCatalog()
    await catalog.register(_read_file())
    catalog.search("read file", 5, "agent")

    attrs = _spans_named(exporter, "ratel.search")[0].attributes
    assert attrs["ratel.search.target"] == "tool"
    assert attrs["ratel.search.top_k"] == 5
    assert attrs["ratel.origin"] == "agent"
    assert attrs["ratel.search.hit_count"] > 0
    assert "ratel.search.query" not in attrs  # content off by default


async def test_ratel_search_span_skill_with_query(
    exporter: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(CAPTURE_ENV, "SPAN_ONLY")
    skills = SkillCatalog()
    await skills.register(Skill(id="pdf", name="pdf", description="fill pdf forms", body="b"))
    skills.search("pdf", 3)

    span = _spans_named(exporter, "ratel.search")[0]
    assert span.attributes["ratel.search.target"] == "skill"
    assert span.attributes["ratel.search.query"] == "pdf"
    # SPAN_ONLY: query on the span, no results event.
    assert _event_named(span, SEARCH_RESULTS) is None


async def test_ratel_search_query_on_results_event_under_event_only(
    exporter: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(CAPTURE_ENV, "EVENT_ONLY")
    catalog = ToolCatalog()
    await catalog.register(_read_file())
    catalog.search("read file", 5, "agent")

    span = _spans_named(exporter, "ratel.search")[0]
    assert "ratel.search.query" not in span.attributes  # content off the span
    event = _event_named(span, SEARCH_RESULTS)
    assert event is not None
    assert event.attributes["ratel.search.query"] == "read file"


async def test_ratel_search_query_on_both_under_span_and_event(
    exporter: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(CAPTURE_ENV, "SPAN_AND_EVENT")
    catalog = ToolCatalog()
    await catalog.register(_read_file())
    catalog.search("read file", 5, "agent")

    span = _spans_named(exporter, "ratel.search")[0]
    assert span.attributes["ratel.search.query"] == "read file"
    assert _event_named(span, SEARCH_RESULTS).attributes["ratel.search.query"] == "read file"


@pytest.mark.asyncio
async def test_host_owned_provider_receives_spans_without_configure_telemetry(
    exporter: Any,
) -> None:
    """The base-SDK contract (ADR-0007): with a host-registered OTel provider and no
    configure_telemetry() call, the SDK's spans flow to that provider. This module's
    TracerProvider is exactly such a host-owned provider."""
    catalog = ToolCatalog()
    await catalog.register(_read_file())
    await catalog.invoke("read_file", {"path": "/tmp/x"})

    assert len(_spans_named(exporter, "execute_tool read_file")) == 1


def test_base_sdk_depends_on_the_vocabulary_so_host_owned_otel_works() -> None:
    """Regression for the host-owned base path: emission imports the ratel_ai_telemetry
    vocabulary, so the base install must ship it (not only the [otlp] extra). Otherwise a
    host bringing its own OpenTelemetry provider on a base install gets no Ratel spans —
    contradicting the documented behavior. The vocabulary is OTel-free, so this keeps the
    base install lightweight (the [otlp] extra still adds the exporter/OTel SDK)."""
    pyproject = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text())
    base_deps = pyproject["project"]["dependencies"]
    assert any(dep.startswith("ratel-ai-telemetry") for dep in base_deps), (
        f"base dependencies must include ratel-ai-telemetry; got {base_deps}"
    )


async def test_ratel_skill_load_span(exporter: Any) -> None:
    skills = SkillCatalog()
    await skills.register(Skill(id="pdf", name="pdf", description="d", body="BODY"))
    assert skills.invoke("pdf") == "BODY"

    span = _spans_named(exporter, "ratel.skill.load")[0]
    assert span.attributes["ratel.skill.id"] == "pdf"
    assert span.status.status_code == StatusCode.OK


# --- configure_telemetry content-capture options -----------------------------
# Mirror of the TS `configureTelemetry content-capture options` suite
# (src/sdk/ts/src/telemetry.test.ts). configure_telemetry sets the programmatic
# capture override (module state in ratel_ai_telemetry, read by content_capture_mode)
# and its returned handle's shutdown() clears it. OpenTelemetry forbids overriding the
# global provider once set (this module registers one at import), so init() itself is
# stubbed out; the override still applies to spans captured by the shared provider.


class _FakeProvider:
    """Stand-in for the TracerProvider init() would return: just a shutdown handle."""

    def __init__(self) -> None:
        self.shutdown_called = False

    def shutdown(self) -> None:
        self.shutdown_called = True


@pytest.fixture()
def fake_init(monkeypatch: pytest.MonkeyPatch) -> dict[str, int]:
    """Replace the OTLP init() so configure_telemetry runs its override logic without
    registering a second global provider. Returns a call counter so a test can assert
    init() was (not) reached."""
    calls = {"count": 0}

    def _init(**_kwargs: Any) -> _FakeProvider:
        calls["count"] += 1
        return _FakeProvider()

    monkeypatch.setattr("ratel_ai_telemetry.otlp.init", _init)
    return calls


@pytest.fixture(autouse=True)
def _reset_override() -> Any:
    """Never leak a programmatic capture override across tests (it is module state)."""
    yield
    set_content_capture(None)


async def _invoke_and_read_args(exporter: Any) -> Any:
    catalog = ToolCatalog()
    await catalog.register(_read_file())
    await catalog.invoke("read_file", {"path": "/p"})
    spans = _spans_named(exporter, "execute_tool read_file")
    return spans[-1].attributes.get("gen_ai.tool.call.arguments")  # most recent invoke


@pytest.mark.asyncio
async def test_include_span_and_events_true_captures_with_env_unset(
    exporter: Any, fake_init: dict[str, int]
) -> None:
    handle = configure_telemetry(include_span_and_events=True)
    try:
        assert await _invoke_and_read_args(exporter) == '{"path": "/p"}'
    finally:
        handle.shutdown()


@pytest.mark.asyncio
async def test_capture_content_span_only_puts_content_on_the_span(
    exporter: Any, fake_init: dict[str, int]
) -> None:
    handle = configure_telemetry(capture_content="SPAN_ONLY")
    try:
        assert await _invoke_and_read_args(exporter) == '{"path": "/p"}'
    finally:
        handle.shutdown()


@pytest.mark.asyncio
async def test_option_beats_an_explicitly_set_env(
    exporter: Any, fake_init: dict[str, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    # env SPAN_AND_EVENT + include_span_and_events=False -> no content.
    monkeypatch.setenv(CAPTURE_ENV, "SPAN_AND_EVENT")
    handle = configure_telemetry(include_span_and_events=False)
    try:
        assert await _invoke_and_read_args(exporter) is None
    finally:
        handle.shutdown()


@pytest.mark.asyncio
async def test_capture_content_wins_over_include_span_and_events(
    exporter: Any, fake_init: dict[str, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    # The env also asks for capture, so NO_CONTENT winning proves capture_content beat
    # BOTH include_span_and_events (True) and the env var — not merely that nothing was
    # installed (which an env-unset default could not distinguish from a dropped override).
    monkeypatch.setenv(CAPTURE_ENV, "SPAN_ONLY")
    handle = configure_telemetry(capture_content="NO_CONTENT", include_span_and_events=True)
    try:
        assert await _invoke_and_read_args(exporter) is None
    finally:
        handle.shutdown()


@pytest.mark.asyncio
async def test_shutdown_restores_env_driven_behavior(
    exporter: Any, fake_init: dict[str, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = configure_telemetry(include_span_and_events=True)
    handle.shutdown()

    # Env unset again -> back to the NO_CONTENT default.
    assert await _invoke_and_read_args(exporter) is None

    # And the env var rules again once set.
    monkeypatch.setenv(CAPTURE_ENV, "SPAN_ONLY")
    assert await _invoke_and_read_args(exporter) == '{"path": "/p"}'


@pytest.mark.asyncio
async def test_with_neither_option_the_env_keeps_ruling(
    exporter: Any, fake_init: dict[str, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(CAPTURE_ENV, "SPAN_ONLY")
    handle = configure_telemetry()
    try:
        assert await _invoke_and_read_args(exporter) == '{"path": "/p"}'
    finally:
        handle.shutdown()


@pytest.mark.asyncio
async def test_stale_handle_shutdown_does_not_clobber_a_newer_override(
    exporter: Any, fake_init: dict[str, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    # Privacy off in code while the env says full capture: a late h1.shutdown()
    # (SIGTERM hook, test teardown) must not clear h2's override — that would silently
    # re-enable content capture via the env fallback.
    monkeypatch.setenv(CAPTURE_ENV, "SPAN_AND_EVENT")
    h1 = configure_telemetry(include_span_and_events=False)
    h2 = configure_telemetry(include_span_and_events=False)

    h1.shutdown()  # stale generation — must no-op on the override
    assert await _invoke_and_read_args(exporter) is None  # still h2's NO_CONTENT, not env

    h2.shutdown()  # current owner — env-driven again
    assert await _invoke_and_read_args(exporter) == '{"path": "/p"}'


@pytest.mark.asyncio
async def test_stale_handle_isolated_when_idempotent_init_returns_one_provider(
    exporter: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each configure call owns its capture teardown even when init() reuses a provider.

    Scope is the content-capture override only — the provider/exporter lifecycle is shared, so
    shutting one handle down stops export for the others (documented; not asserted here, since
    _FakeProvider.shutdown is an inert flag).
    """
    shared_provider = _FakeProvider()
    monkeypatch.setattr("ratel_ai_telemetry.otlp.init", lambda **_kwargs: shared_provider)
    monkeypatch.setenv(CAPTURE_ENV, "SPAN_AND_EVENT")

    h1 = configure_telemetry(include_span_and_events=False)
    h2 = configure_telemetry(include_span_and_events=False)

    h1.shutdown()
    assert await _invoke_and_read_args(exporter) is None

    h2.shutdown()
    assert await _invoke_and_read_args(exporter) == '{"path": "/p"}'


@pytest.mark.asyncio
async def test_accepts_a_lowercase_capture_content(
    exporter: Any, fake_init: dict[str, int]
) -> None:
    handle = configure_telemetry(capture_content="span_only")
    try:
        assert await _invoke_and_read_args(exporter) == '{"path": "/p"}'
    finally:
        handle.shutdown()


@pytest.mark.asyncio
async def test_raises_on_garbage_capture_content_before_wiring_the_exporter(
    exporter: Any, fake_init: dict[str, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    with pytest.raises(ValueError):
        configure_telemetry(capture_content="garbage")

    # init() was never reached: no exporter side effects...
    assert fake_init["count"] == 0
    # ...and no garbage override was stored: the env var still rules.
    monkeypatch.setenv(CAPTURE_ENV, "SPAN_ONLY")
    assert await _invoke_and_read_args(exporter) == '{"path": "/p"}'
    monkeypatch.delenv(CAPTURE_ENV, raising=False)
    assert await _invoke_and_read_args(exporter) is None


# --- configure_telemetry default span filtering (RS-15) ----------------------
# configure_telemetry (the high-level SDK path) must default to the ratel.*/gen_ai.*
# signal filter and require export_all_spans to forward everything. The filter lives
# inside init()'s provider (which never exports in-process), so init() is stubbed to
# capture exactly the span_filter configure_telemetry hands it.


class _FakeSpan:
    """Minimal ReadableSpan stand-in: ratel_signal_filter reads name + attributes."""

    def __init__(self, name: str, attributes: dict[str, Any]) -> None:
        self.name = name
        self.attributes = attributes


@pytest.fixture()
def capturing_init(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Replace init() with one that records the kwargs configure_telemetry passes."""
    captured: dict[str, Any] = {}

    def _init(**kwargs: Any) -> _FakeProvider:
        captured.update(kwargs)
        return _FakeProvider()

    monkeypatch.setattr("ratel_ai_telemetry.otlp.init", _init)
    return captured


@pytest.mark.asyncio
async def test_configure_telemetry_defaults_to_the_signal_filter(
    capturing_init: dict[str, Any],
) -> None:
    handle = configure_telemetry()
    try:
        span_filter = capturing_init["span_filter"]
        assert span_filter is not None
        assert span_filter(_FakeSpan("ratel.search", {})) is True
        assert (
            span_filter(_FakeSpan("execute_tool x", {"gen_ai.operation.name": "execute_tool"}))
            is True
        )
        # An unrelated framework/HTTP span carries no gen_ai/ratel signal -> dropped.
        assert span_filter(_FakeSpan("GET /api", {"http.method": "GET"})) is False
    finally:
        handle.shutdown()


@pytest.mark.asyncio
async def test_configure_telemetry_export_all_spans_forwards_everything(
    capturing_init: dict[str, Any],
) -> None:
    handle = configure_telemetry(export_all_spans=True)
    try:
        # None -> init()'s accept-all turnkey default.
        assert capturing_init["span_filter"] is None
    finally:
        handle.shutdown()
