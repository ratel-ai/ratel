"""Tests for the init() OTLP builder and its content-capture gate."""

from __future__ import annotations

import builtins
import importlib
from typing import Any

import pytest

from ratel_ai_telemetry.otlp import (
    API_KEY_ENV,
    DEFAULT_SERVICE_NAME,
    ENDPOINT_ENV,
    ContentCapture,
    clear_content_capture,
    content_capture_mode,
    init,
    resolve_otlp_config,
    set_content_capture,
)

CONTENT_ENV = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"


@pytest.fixture(autouse=True)
def _reset_content_capture_override() -> object:
    """The programmatic override is module-level state in ratel_ai_telemetry.otlp; clear
    it after every test so an override never leaks into another test's env parsing."""
    yield
    set_content_capture(None)


class TestResolveOtlpConfig:
    def test_uses_api_key_from_environment_when_not_passed(self) -> None:
        cfg = resolve_otlp_config(
            env={
                ENDPOINT_ENV: "https://collector.ratel.sh/v1/traces",
                API_KEY_ENV: "env-secret",
            },
        )
        assert cfg.headers["Authorization"] == "Bearer env-secret"

    def test_explicit_api_key_wins_over_environment(self) -> None:
        cfg = resolve_otlp_config(
            api_key="explicit-secret",
            env={
                ENDPOINT_ENV: "https://collector.ratel.sh/v1/traces",
                API_KEY_ENV: "env-secret",
            },
        )
        assert cfg.headers["Authorization"] == "Bearer explicit-secret"

    def test_env_api_key_does_not_override_an_explicit_authorization_header(self) -> None:
        # A partner dual-exporting through their own collector passes a custom auth header;
        # an ambient RATEL_API_KEY (set process-wide for the SDK) must not clobber it.
        cfg = resolve_otlp_config(
            endpoint="https://my-collector/v1/traces",
            headers={"Authorization": "Api-Key abc"},
            env={API_KEY_ENV: "ambient-env-key"},
        )
        assert cfg.headers["Authorization"] == "Api-Key abc"

    def test_reads_api_key_from_the_default_process_environment(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Exercises the os.environ default binding (not an injected env=), the actual
        # user-facing "set RATEL_API_KEY and call init()" path.
        monkeypatch.setenv(ENDPOINT_ENV, "https://collector.ratel.sh/v1/traces")
        monkeypatch.setenv(API_KEY_ENV, "process-env-secret")
        cfg = resolve_otlp_config()
        assert cfg.headers["Authorization"] == "Bearer process-env-secret"

    def test_api_key_form_uses_ratel_url_and_bearer_and_default_service(self) -> None:
        cfg = resolve_otlp_config(
            api_key="secret",
            env={ENDPOINT_ENV: "https://collector.ratel.sh/v1/traces"},
        )
        assert cfg.url == "https://collector.ratel.sh/v1/traces"
        assert cfg.headers["Authorization"] == "Bearer secret"
        assert cfg.service_name == DEFAULT_SERVICE_NAME

    def test_endpoint_headers_form_is_verbatim_without_authorization(self) -> None:
        cfg = resolve_otlp_config(
            endpoint="http://localhost:4318/v1/traces",
            headers={"x-custom": "1"},
            env={},
        )
        assert cfg.url == "http://localhost:4318/v1/traces"
        assert cfg.headers == {"x-custom": "1"}
        assert "Authorization" not in cfg.headers

    def test_explicit_endpoint_wins_over_ratel_url(self) -> None:
        cfg = resolve_otlp_config(
            endpoint="https://explicit/v1/traces",
            api_key="k",
            env={ENDPOINT_ENV: "https://env/v1/traces"},
        )
        assert cfg.url == "https://explicit/v1/traces"
        assert cfg.headers["Authorization"] == "Bearer k"

    def test_custom_service_name_is_respected(self) -> None:
        cfg = resolve_otlp_config(
            endpoint="https://x/v1/traces", service_name="my-agent", env={}
        )
        assert cfg.service_name == "my-agent"

    def test_raises_when_no_endpoint_and_no_ratel_url(self) -> None:
        with pytest.raises(ValueError, match=ENDPOINT_ENV):
            resolve_otlp_config(api_key="k", env={})


class TestContentCaptureMode:
    def test_defaults_to_no_content_when_unset_or_empty(self) -> None:
        assert content_capture_mode(env={}) == ContentCapture.NO_CONTENT
        assert content_capture_mode(env={CONTENT_ENV: ""}) == ContentCapture.NO_CONTENT

    def test_parses_each_enum_value_case_insensitively(self) -> None:
        assert content_capture_mode(env={CONTENT_ENV: "NO_CONTENT"}) == ContentCapture.NO_CONTENT
        assert content_capture_mode(env={CONTENT_ENV: "span_only"}) == ContentCapture.SPAN_ONLY
        assert content_capture_mode(env={CONTENT_ENV: "Event_Only"}) == ContentCapture.EVENT_ONLY
        assert (
            content_capture_mode(env={CONTENT_ENV: "SPAN_AND_EVENT"})
            == ContentCapture.SPAN_AND_EVENT
        )

    def test_maps_the_legacy_boolean_form(self) -> None:
        assert content_capture_mode(env={CONTENT_ENV: "true"}) == ContentCapture.SPAN_AND_EVENT
        assert content_capture_mode(env={CONTENT_ENV: "false"}) == ContentCapture.NO_CONTENT


class TestInit:
    def test_disabled_init_is_a_noop_without_config_or_otel(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv(ENDPOINT_ENV, raising=False)
        real_import = builtins.__import__

        def block_otel(name: str, *args: Any, **kwargs: Any) -> Any:
            if name == "opentelemetry" or name.startswith("opentelemetry."):
                raise ModuleNotFoundError(name)
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", block_otel)
        handle = init(enabled=False)

        assert handle.force_flush()
        assert handle.shutdown() is None

    def test_disabled_init_returns_a_noop_when_a_foreign_provider_is_active(self) -> None:
        # A disabled caller must never take over or fail on someone else's provider — it just
        # opts out with a no-op handle. Mirrors the TS init.test.ts foreign+disabled case.
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider

        foreign = TracerProvider()
        trace.set_tracer_provider(foreign)
        try:
            handle = init(enabled=False)
            assert trace.get_tracer_provider() is foreign  # untouched
            assert handle.shutdown() is None
        finally:
            foreign.shutdown()

    def test_respects_a_custom_span_filter(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from opentelemetry import trace
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        forwarded: list[str] = []
        monkeypatch.setattr(BatchSpanProcessor, "on_end", lambda _self, s: forwarded.append(s.name))
        handle = init(
            endpoint="http://localhost:4318/v1/traces",
            span_filter=lambda span: span.name.startswith("keep."),
        )
        try:
            # Emit through the global API — init() registered the provider globally.
            tracer = trace.get_tracer(__name__)
            with tracer.start_as_current_span("keep.this"):
                pass
            with tracer.start_as_current_span("drop.this"):
                pass
        finally:
            handle.shutdown()

        assert forwarded == ["keep.this"]

    def test_repeated_init_returns_the_owned_handle_without_requiring_config(self) -> None:
        handle = init(endpoint="http://localhost:4318/v1/traces")
        try:
            assert init() is handle
            assert init(enabled=False) is handle
        finally:
            handle.shutdown()

    def test_init_after_shutdown_raises_instead_of_returning_the_dead_handle(self) -> None:
        # Shutdown is terminal: OTel's global provider is set-once, so a later init() must fail
        # loud rather than hand back a provider whose exporter is already stopped.
        handle = init(endpoint="http://localhost:4318/v1/traces")
        handle.shutdown()
        with pytest.raises(RuntimeError, match="already shut down"):
            init(endpoint="http://localhost:4318/v1/traces")
        with pytest.raises(RuntimeError, match="already shut down"):
            init(enabled=True)

    def test_race_loser_returns_a_ratel_owned_winner(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # If another thread's init() wins the set-once registration, the loser must honor
        # idempotence and return that Ratel-owned winner, not raise the foreign-provider error.
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider

        import ratel_ai_telemetry.otlp as otlp

        original_set_provider = trace.set_tracer_provider
        winner = TracerProvider()
        setattr(winner, otlp._PROVIDER_HANDLE_ATTR, winner)  # marked as Ratel-owned

        def install_winner(_provider: object) -> None:
            original_set_provider(winner)

        monkeypatch.setattr(trace, "set_tracer_provider", install_winner)
        try:
            assert init(endpoint="http://localhost:4318/v1/traces") is winner
        finally:
            winner.shutdown()

    def test_reloaded_module_recognizes_the_owned_provider(self) -> None:
        import ratel_ai_telemetry.otlp as otlp

        provider = otlp.init(endpoint="http://localhost:4318/v1/traces")
        try:
            reloaded = importlib.reload(otlp)
            assert reloaded.init() is provider
        finally:
            provider.shutdown()

    def test_returns_a_provider_with_shutdown(self) -> None:
        provider = init(
            api_key="k",
            endpoint="http://localhost:4318/v1/traces",
            service_name="test",
        )
        try:
            assert callable(provider.shutdown)
        finally:
            provider.shutdown()

    def test_raises_if_a_foreign_provider_wins_registration_race(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider

        original_set_provider = trace.set_tracer_provider
        foreign_provider = TracerProvider()

        def install_foreign_provider(_provider: object) -> None:
            original_set_provider(foreign_provider)

        monkeypatch.setattr(trace, "set_tracer_provider", install_foreign_provider)
        try:
            with pytest.raises(RuntimeError, match="ratel_span_processor"):
                init(endpoint="http://localhost:4318/v1/traces")
        finally:
            foreign_provider.shutdown()

    def test_raises_on_misconfiguration(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(ENDPOINT_ENV, raising=False)
        with pytest.raises(ValueError, match=ENDPOINT_ENV):
            init(api_key="k")


def test_top_level_lazy_accessor_resolves_the_otlp_surface() -> None:
    """`from ratel_ai_telemetry import init` still works via the module __getattr__,
    resolving to the same object as the .otlp submodule (ADR-0007 back-compat)."""
    import ratel_ai_telemetry
    from ratel_ai_telemetry.otlp import TelemetryHandle as otlp_handle
    from ratel_ai_telemetry.otlp import init as otlp_init
    from ratel_ai_telemetry.otlp import resolve_otlp_config as otlp_resolve

    assert ratel_ai_telemetry.init is otlp_init
    assert ratel_ai_telemetry.resolve_otlp_config is otlp_resolve
    assert ratel_ai_telemetry.API_KEY_ENV == API_KEY_ENV
    assert ratel_ai_telemetry.TelemetryHandle is otlp_handle


class TestSetContentCapture:
    """Programmatic override of the content-capture gate. Mirrors the TS
    `setContentCapture` suite in src/telemetry/ts/src/config.test.ts."""

    def test_wins_over_an_explicitly_set_env_in_either_direction(self) -> None:
        set_content_capture(ContentCapture.NO_CONTENT)
        assert content_capture_mode(env={CONTENT_ENV: "SPAN_ONLY"}) == ContentCapture.NO_CONTENT

        set_content_capture(ContentCapture.SPAN_AND_EVENT)
        assert (
            content_capture_mode(env={CONTENT_ENV: "NO_CONTENT"}) == ContentCapture.SPAN_AND_EVENT
        )

    def test_applies_when_the_env_is_unset(self) -> None:
        set_content_capture(ContentCapture.EVENT_ONLY)
        assert content_capture_mode(env={}) == ContentCapture.EVENT_ONLY

    def test_clearing_with_none_restores_env_parsing(self) -> None:
        set_content_capture(ContentCapture.NO_CONTENT)
        set_content_capture(None)
        assert content_capture_mode(env={CONTENT_ENV: "SPAN_ONLY"}) == ContentCapture.SPAN_ONLY
        assert content_capture_mode(env={}) == ContentCapture.NO_CONTENT

    def test_never_set_leaves_env_parsing_untouched(self) -> None:
        set_content_capture(None)  # clearing with nothing set is a no-op
        assert content_capture_mode(env={CONTENT_ENV: "event_only"}) == ContentCapture.EVENT_ONLY
        assert content_capture_mode(env={}) == ContentCapture.NO_CONTENT

    def test_normalizes_like_the_env_var(self) -> None:
        set_content_capture("span_only")
        assert content_capture_mode(env={}) == ContentCapture.SPAN_ONLY

        set_content_capture(" SPAN_AND_EVENT ")
        assert content_capture_mode(env={}) == ContentCapture.SPAN_AND_EVENT

        set_content_capture("true")
        assert content_capture_mode(env={}) == ContentCapture.SPAN_AND_EVENT

        set_content_capture("0")
        assert (
            content_capture_mode(env={CONTENT_ENV: "SPAN_AND_EVENT"}) == ContentCapture.NO_CONTENT
        )

    def test_raises_valueerror_naming_the_valid_values_on_garbage(self) -> None:
        with pytest.raises(ValueError, match="NO_CONTENT.*SPAN_ONLY.*EVENT_ONLY.*SPAN_AND_EVENT"):
            set_content_capture("garbage")

    def test_stores_nothing_on_a_failed_set(self) -> None:
        with pytest.raises(ValueError):
            set_content_capture("SPAN_ONLY_TYPO")
        assert content_capture_mode(env={CONTENT_ENV: "SPAN_ONLY"}) == ContentCapture.SPAN_ONLY
        assert content_capture_mode(env={}) == ContentCapture.NO_CONTENT


class TestClearContentCapture:
    """Generation-scoped clear. Mirrors the TS `clearContentCapture` suite."""

    def test_only_the_most_recent_setter_can_clear(self) -> None:
        g1 = set_content_capture(ContentCapture.NO_CONTENT)
        g2 = set_content_capture(ContentCapture.EVENT_ONLY)
        assert g2 > g1

        clear_content_capture(g1)  # stale — must not clobber g2's override
        assert (
            content_capture_mode(env={CONTENT_ENV: "SPAN_AND_EVENT"}) == ContentCapture.EVENT_ONLY
        )

        clear_content_capture(g2)  # current owner — clears, env rules again
        assert (
            content_capture_mode(env={CONTENT_ENV: "SPAN_AND_EVENT"})
            == ContentCapture.SPAN_AND_EVENT
        )
        assert content_capture_mode(env={}) == ContentCapture.NO_CONTENT

    def test_is_idempotent_for_the_current_generation(self) -> None:
        g = set_content_capture(ContentCapture.SPAN_ONLY)
        clear_content_capture(g)
        clear_content_capture(g)
        assert content_capture_mode(env={}) == ContentCapture.NO_CONTENT

    def test_unconditional_none_invalidates_outstanding_generations(self) -> None:
        g1 = set_content_capture(ContentCapture.SPAN_ONLY)
        set_content_capture(None)  # the direct user's clear is the newest config action
        g3 = set_content_capture(ContentCapture.EVENT_ONLY)

        clear_content_capture(g1)  # stale — the slot moved on twice since
        assert content_capture_mode(env={}) == ContentCapture.EVENT_ONLY
        clear_content_capture(g3)
        assert content_capture_mode(env={}) == ContentCapture.NO_CONTENT
