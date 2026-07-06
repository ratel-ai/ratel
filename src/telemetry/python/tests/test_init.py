"""Tests for the init() OTLP builder and its content-capture gate."""

from __future__ import annotations

import pytest

from ratel_ai_telemetry.otlp import (
    DEFAULT_SERVICE_NAME,
    ENDPOINT_ENV,
    ContentCapture,
    content_capture_mode,
    init,
    resolve_otlp_config,
)

CONTENT_ENV = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"


class TestResolveOtlpConfig:
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

    def test_raises_on_misconfiguration(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(ENDPOINT_ENV, raising=False)
        with pytest.raises(ValueError, match=ENDPOINT_ENV):
            init(api_key="k")


def test_top_level_lazy_accessor_resolves_the_otlp_surface() -> None:
    """`from ratel_ai_telemetry import init` still works via the module __getattr__,
    resolving to the same object as the .otlp submodule (ADR-0007 back-compat)."""
    import ratel_ai_telemetry
    from ratel_ai_telemetry.otlp import init as otlp_init
    from ratel_ai_telemetry.otlp import resolve_otlp_config as otlp_resolve

    assert ratel_ai_telemetry.init is otlp_init
    assert ratel_ai_telemetry.resolve_otlp_config is otlp_resolve
