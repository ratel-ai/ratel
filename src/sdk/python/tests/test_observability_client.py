"""RatelClient configuration, emission, capture toggles, and no-op mode."""

from __future__ import annotations

from typing import Any

from ratel_ai.observability import CaptureExporter, ObservabilityConfig, RatelClient


class _FakeRecorder:
    """Stands in for a ratel-ai-core registry: collects recorded core events."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def record_event(self, event: dict[str, Any]) -> None:
        self.events.append(event)


def _types(events: list[dict[str, Any]]) -> list[str]:
    return [e["type"] for e in events]


# -- config resolution ------------------------------------------------------


def test_config_disabled_without_api_key(monkeypatch: Any) -> None:
    monkeypatch.delenv("RATEL_API_KEY", raising=False)
    cfg = ObservabilityConfig.resolve()
    assert cfg.enabled is False
    assert cfg.can_export is False


def test_config_enabled_when_key_present() -> None:
    cfg = ObservabilityConfig.resolve(api_key="rk-1")
    assert cfg.enabled is True
    assert cfg.can_export is True
    assert cfg.ingest_url == "https://cloud.ratel.sh/v1/ingest"


def test_kwargs_override_env(monkeypatch: Any) -> None:
    monkeypatch.setenv("RATEL_HOST", "https://env.example")
    cfg = ObservabilityConfig.resolve(api_key="rk-1", host="https://explicit.example")
    assert cfg.host == "https://explicit.example"


def test_env_used_when_no_kwarg(monkeypatch: Any) -> None:
    monkeypatch.setenv("RATEL_HOST", "https://env.example/")
    cfg = ObservabilityConfig.resolve(api_key="rk-1")
    assert cfg.host == "https://env.example"  # trailing slash trimmed


# -- no-op mode -------------------------------------------------------------


def test_no_op_mode_emits_nothing_and_never_raises() -> None:
    client = RatelClient(api_key=None, enabled=False)
    with client.start_as_current_span("x") as span:
        span.update(output="ok")
    client.flush()
    client.shutdown()  # no exporter, no exceptions


# -- emission ---------------------------------------------------------------


def test_span_emits_trace_then_observation(capture: CaptureExporter) -> None:
    from ratel_ai import get_client

    with get_client().start_as_current_span("step", input={"x": 1}) as span:
        span.update(output={"y": 2})

    types = _types(capture.events)
    assert types == ["trace-create", "observation-create"]
    obs = capture.events[1]
    assert obs["observation_type"] == "span"
    assert obs["input"] == {"captured": True, "value": {"x": 1}}
    assert obs["output"] == {"captured": True, "value": {"y": 2}}
    assert obs["status"] == "ok"


def test_generation_emits_gen_ai_with_usage(capture: CaptureExporter) -> None:
    from ratel_ai import get_client

    with get_client().start_as_current_generation("llm", model="gpt-4o", provider="openai") as gen:
        gen.update(output="hello", usage={"input_tokens": 10, "output_tokens": 5})

    obs = [e for e in capture.events if e["type"] == "observation-create"][0]
    assert obs["observation_type"] == "generation"
    assert obs["gen_ai"]["system"] == "openai"
    assert obs["gen_ai"]["request"]["model"] == "gpt-4o"
    assert obs["gen_ai"]["usage"]["total_tokens"] == 15


def test_error_status_recorded_on_context_manager_exception(capture: CaptureExporter) -> None:
    from ratel_ai import get_client

    try:
        with get_client().start_as_current_span("boom"):
            raise RuntimeError("kaboom")
    except RuntimeError:
        pass

    obs = [e for e in capture.events if e["type"] == "observation-create"][0]
    assert obs["status"] == "error"
    assert obs["status_message"] == "kaboom"


def test_capture_toggle_suppresses_content() -> None:
    exporter = CaptureExporter()
    client = RatelClient(
        api_key="rk-test", capture_input=False, capture_output=False, exporter=exporter
    )
    with client.start_as_current_span("x", input="secret") as span:
        span.update(output="also secret")
    obs = [e for e in exporter.events if e["type"] == "observation-create"][0]
    assert obs["input"] == {"captured": False, "length": len("secret")}
    assert obs["output"]["captured"] is False


def test_update_current_trace_sets_attributes(capture: CaptureExporter) -> None:
    from ratel_ai import get_client

    client = get_client()
    with client.start_as_current_span("x"):
        client.update_current_trace(
            user_id="u1", session_id="s1", tags=["prod"], metadata={"k": "v"}
        )

    traces = [e for e in capture.events if e["type"] == "trace-create"]
    last = traces[-1]
    assert last["user_id"] == "u1"
    assert last["session_id"] == "s1"
    assert last["tags"] == ["prod"]
    assert last["metadata"] == {"k": "v"}


# -- core-stream mirroring --------------------------------------------------


def test_core_recorder_receives_identity_and_usage_events() -> None:
    recorder = _FakeRecorder()
    client = RatelClient(api_key="rk-test", exporter=CaptureExporter(), core_recorder=recorder)
    with client.start_as_current_generation("llm", model="gpt-4o", provider="openai") as gen:
        gen.update(usage={"input_tokens": 3, "output_tokens": 4})

    types = _types(recorder.events)
    assert types == ["trace_root", "observation_start", "observation_end", "generation"]
    generation = recorder.events[-1]
    assert generation["model"] == "gpt-4o"
    assert generation["total_tokens"] == 7


def test_sampling_zero_drops_everything() -> None:
    exporter = CaptureExporter()
    client = RatelClient(api_key="rk-test", sample_rate=0.0, exporter=exporter)
    with client.start_as_current_span("x") as span:
        span.update(output="y")
    assert exporter.events == []


def test_context_manager_fails_open_when_start_raises() -> None:
    from ratel_ai.observability.trace import NULL_OBSERVATION

    class _BrokenStart(RatelClient):
        def start_observation(self, *args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("observability is broken")

    client = _BrokenStart(api_key="rk-test", exporter=CaptureExporter())
    # The `with` must not raise even though opening the span fails internally,
    # and user code calling .update()/.end() on the yielded object must be safe.
    with client.start_as_current_span("x") as span:
        assert span is NULL_OBSERVATION
        span.update(output="still works")
    # generation context manager too
    with client.start_as_current_generation("g", model="m") as gen:
        gen.update(usage={"input_tokens": 1})


def test_status_message_is_truncated() -> None:
    exporter = CaptureExporter()
    client = RatelClient(api_key="rk-test", exporter=exporter)
    long_message = "x" * 5000
    try:
        with client.start_as_current_span("boom"):
            raise RuntimeError(long_message)
    except RuntimeError:
        pass
    obs = [e for e in exporter.events if e["type"] == "observation-create"][0]
    assert obs["status"] == "error"
    assert len(obs["status_message"]) <= 500


def test_configure_shuts_down_replaced_client() -> None:
    from ratel_ai.observability import configure

    class _TrackExporter(CaptureExporter):
        def __init__(self) -> None:
            super().__init__()
            self.shutdown_called = False

        def shutdown(self) -> None:
            self.shutdown_called = True

    first = _TrackExporter()
    configure(api_key="rk-1", exporter=first)
    configure(api_key="rk-2")  # replaces the singleton
    assert first.shutdown_called is True
