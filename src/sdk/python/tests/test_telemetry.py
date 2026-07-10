"""OpenTelemetry emission tests — mirrors `src/sdk/ts/src/telemetry.test.ts`.

Instrumentation is verified through the public OTel API: register an in-memory
exporter as the global provider, drive the SDK, and read the spans back. The SDK
never imports the exporter — it emits to whatever provider is active, exactly as a
host deployment would wire it. These tests need the OpenTelemetry SDK
(`ratel-ai[otlp]` or a bare `opentelemetry-sdk`); they skip if it is absent.
"""

from __future__ import annotations

from typing import Any

import pytest

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


@pytest.mark.asyncio
async def test_execute_tool_span_attributes(exporter: Any) -> None:
    catalog = ToolCatalog()
    catalog.register(_read_file())
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
    catalog.register(_read_file())
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
    catalog.register(_read_file())
    await catalog.invoke("read_file", {"path": "/p"})

    attrs = _spans_named(exporter, "execute_tool read_file")[0].attributes
    assert attrs["gen_ai.tool.call.arguments"] == '{"path": "/p"}'
    assert "contents of /p" in attrs["gen_ai.tool.call.result"]


@pytest.mark.asyncio
async def test_execute_tool_span_error(exporter: Any) -> None:
    def boom(_args: dict[str, Any]) -> Any:
        raise RuntimeError("kaboom")

    catalog = ToolCatalog()
    catalog.register(
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
    catalog.register(_read_file())
    await catalog.invoke("read_file", {"path": "/tmp/x"})

    local = catalog.drain_trace_events()
    invoke_events = [e["type"] for e in local if str(e["type"]).startswith("invoke_")]
    assert invoke_events == ["invoke_start", "invoke_end"]
    assert len(_spans_named(exporter, "execute_tool read_file")) == 1


def test_ratel_search_span_tool(exporter: Any) -> None:
    catalog = ToolCatalog()
    catalog.register(_read_file())
    catalog.search("read file", 5, "agent")

    attrs = _spans_named(exporter, "ratel.search")[0].attributes
    assert attrs["ratel.search.target"] == "tool"
    assert attrs["ratel.search.top_k"] == 5
    assert attrs["ratel.origin"] == "agent"
    assert attrs["ratel.search.hit_count"] > 0
    assert "ratel.search.query" not in attrs  # content off by default


def test_ratel_search_span_skill_with_query(
    exporter: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(CAPTURE_ENV, "SPAN_ONLY")
    skills = SkillCatalog()
    skills.register(Skill(id="pdf", name="pdf", description="fill pdf forms", body="b"))
    skills.search("pdf", 3)

    attrs = _spans_named(exporter, "ratel.search")[0].attributes
    assert attrs["ratel.search.target"] == "skill"
    assert attrs["ratel.search.query"] == "pdf"


def test_ratel_skill_load_span(exporter: Any) -> None:
    skills = SkillCatalog()
    skills.register(Skill(id="pdf", name="pdf", description="d", body="BODY"))
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
    catalog.register(_read_file())
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
