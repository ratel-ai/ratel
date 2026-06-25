"""Lean cloud client + rollup builder (ADR-0016)."""

from __future__ import annotations

from ratel_ai.observability import (
    CaptureExporter,
    RatelClient,
    build_rollup,
    normalize_sources,
)

# -- rollup builder ---------------------------------------------------------


def test_build_rollup_fills_sources_and_defaults_input_tokens() -> None:
    rollup = build_rollup(tokens_by_category={"tools": 2000, "history": 3400})
    assert rollup["tokens_by_category"] == {
        "skills": 0,
        "tools": 2000,
        "history": 3400,
        "memory": 0,
        "user_input": 0,
    }
    assert rollup["input_tokens"] == 5400  # defaults to the sum of the spend
    # absent optionals are omitted, not null
    assert "saved_by_category" not in rollup
    assert "cost_usd" not in rollup


def test_build_rollup_estimates_cost_from_model() -> None:
    rollup = build_rollup(
        tokens_by_category={"tools": 1000}, output_tokens=200, model="claude-sonnet-4-6"
    )
    assert rollup["model"] == "claude-sonnet-4-6"
    assert rollup["output_tokens"] == 200
    assert rollup["cost_usd"] > 0


def test_build_rollup_explicit_cost_wins_over_estimate() -> None:
    rollup = build_rollup(
        tokens_by_category={"tools": 1000}, model="claude-opus-4-8", cost_usd=0.5
    )
    assert rollup["cost_usd"] == 0.5


def test_normalize_sources_none_passes_through() -> None:
    assert normalize_sources(None) is None
    assert normalize_sources({"tools": 5})["tools"] == 5  # type: ignore[index]


# -- client -----------------------------------------------------------------


def test_track_enqueues_a_rollup() -> None:
    exporter = CaptureExporter()
    client = RatelClient(api_key="rk-test", enabled=True, exporter=exporter)
    client.track(
        tokens_by_category={"tools": 2000},
        saved_by_category={"tools": 7000},
        model="claude-haiku-4-5",
        output_tokens=120,
    )
    assert len(exporter.events) == 1
    event = exporter.events[0]
    assert event["tokens_by_category"]["tools"] == 2000
    assert event["saved_by_category"]["tools"] == 7000
    assert event["cost_usd"] > 0


def test_noop_client_never_raises() -> None:
    client = RatelClient(api_key=None, enabled=False)  # no key → no-op
    client.track(tokens_by_category={"tools": 1})  # must not raise
    client.flush()
    client.shutdown()


def test_track_swallows_bad_input() -> None:
    exporter = CaptureExporter()
    client = RatelClient(api_key="rk-test", enabled=True, exporter=exporter)
    # A non-mapping would blow up inside normalize_sources — track must absorb it.
    client.track(tokens_by_category=123)  # type: ignore[arg-type]
    assert exporter.events == []  # dropped, not raised


def test_config_repr_masks_api_key() -> None:
    from ratel_ai.observability import ObservabilityConfig

    rendered = repr(ObservabilityConfig.resolve(api_key="rk-secret-123"))
    assert "rk-secret-123" not in rendered
    assert "***" in rendered


def test_sample_rate_zero_drops_everything() -> None:
    exporter = CaptureExporter()
    client = RatelClient(api_key="rk-test", enabled=True, exporter=exporter, sample_rate=0.0)
    for _ in range(20):
        client.track(tokens_by_category={"tools": 1})
    assert exporter.events == []
