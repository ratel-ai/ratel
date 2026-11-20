"""experimental_with_variant: agent variant tags on every span of a run (CONVENTIONS.md)."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any

import pytest

pytest.importorskip("opentelemetry.sdk")

from opentelemetry import baggage, context  # noqa: E402
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import SimpleSpanProcessor  # noqa: E402
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (  # noqa: E402
    InMemorySpanExporter,
)

from ratel_ai import ExperimentalVariantSpanProcessor, experimental_with_variant  # noqa: E402


@pytest.fixture()
def tracing() -> Iterator[tuple[Any, InMemorySpanExporter]]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(ExperimentalVariantSpanProcessor())
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    yield provider.get_tracer("variant-test"), exporter
    provider.shutdown()


def _span(exporter: InMemorySpanExporter, name: str) -> ReadableSpan:
    return next(s for s in exporter.get_finished_spans() if s.name == name)


def _variant(span: ReadableSpan) -> dict[str, Any]:
    return {k: v for k, v in (span.attributes or {}).items() if k.startswith("ratel.variant.")}


EXPECTED = {
    "ratel.variant.experiment": "support-model",
    "ratel.variant.name": "haiku",
    "ratel.variant.model": "claude-haiku-5-5",
    "ratel.variant.prompt_version": 3,
    "ratel.variant.cached": True,
}


def test_sync_run_tags_root_and_nested_spans(tracing: Any) -> None:
    tracer, exporter = tracing
    with experimental_with_variant(
        experiment="support-model",
        name="haiku",
        model="claude-haiku-5-5",
        prompt_version=3,
        cached=True,
    ):
        with tracer.start_as_current_span("root"):
            with tracer.start_as_current_span("child"):
                pass

    assert _variant(_span(exporter, "root")) == EXPECTED
    assert _variant(_span(exporter, "child")) == EXPECTED


async def test_async_run_tags_spans_across_await_and_tasks(tracing: Any) -> None:
    tracer, exporter = tracing

    async def child() -> None:
        await asyncio.sleep(0)
        with tracer.start_as_current_span("task-child"):
            pass

    async with experimental_with_variant(
        experiment="support-model",
        name="haiku",
        model="claude-haiku-5-5",
        prompt_version=3,
        cached=True,
    ):
        with tracer.start_as_current_span("root"):
            await asyncio.sleep(0)
            with tracer.start_as_current_span("child"):
                pass
            await asyncio.create_task(child())

    for name in ("root", "child", "task-child"):
        assert _variant(_span(exporter, name)) == EXPECTED


def test_spans_outside_the_scope_carry_no_tags(tracing: Any) -> None:
    tracer, exporter = tracing
    with tracer.start_as_current_span("before"):
        pass
    with experimental_with_variant(experiment="e", name="a"):
        pass
    with tracer.start_as_current_span("after"):
        pass

    assert _variant(_span(exporter, "before")) == {}
    assert _variant(_span(exporter, "after")) == {}


def test_tags_go_into_baggage_as_strings() -> None:
    with experimental_with_variant(experiment="e", name="a", temperature=0.5, cached=False):
        entries = baggage.get_all()
        assert entries["ratel.variant.experiment"] == "e"
        assert entries["ratel.variant.name"] == "a"
        assert entries["ratel.variant.temperature"] == "0.5"
        assert entries["ratel.variant.cached"] == "false"
    assert "ratel.variant.experiment" not in baggage.get_all()


def test_inner_scope_replaces_every_outer_tag(tracing: Any) -> None:
    tracer, exporter = tracing
    with experimental_with_variant(experiment="outer", name="a", model="m1"):
        with experimental_with_variant(experiment="inner", name="b"):
            with tracer.start_as_current_span("inner"):
                pass

    assert _variant(_span(exporter, "inner")) == {
        "ratel.variant.experiment": "inner",
        "ratel.variant.name": "b",
    }


@pytest.mark.parametrize(
    ("experiment", "name"),
    [("", "a"), ("e", "x" * 129), (3, "a"), ("e", None)],
)
def test_refuses_an_invalid_experiment_or_name(experiment: Any, name: Any) -> None:
    with pytest.raises(ValueError):
        experimental_with_variant(experiment=experiment, name=name)


def test_drops_invalid_descriptors_with_a_warning(tracing: Any) -> None:
    tracer, exporter = tracing
    bad: dict[str, Any] = {
        "Bad": "x",
        "empty": "",
        "long": "x" * 129,
        "nan": float("nan"),
        "nothing": None,
        "items": ["a"],
        "nested": {"a": 1},
    }
    with pytest.warns(UserWarning, match="nested"):
        scope = experimental_with_variant(experiment="e", name="a", model="ok", **bad)
    with scope:
        with tracer.start_as_current_span("run"):
            pass

    assert _variant(_span(exporter, "run")) == {
        "ratel.variant.experiment": "e",
        "ratel.variant.name": "a",
        "ratel.variant.model": "ok",
    }


def test_keeps_the_first_16_descriptors_in_key_order(tracing: Any) -> None:
    tracer, exporter = tracing
    descriptors = {f"k{i:02d}": i for i in range(18)}
    with pytest.warns(UserWarning):
        scope = experimental_with_variant(experiment="e", name="a", **descriptors)
    with scope:
        with tracer.start_as_current_span("run"):
            pass

    attributes = _variant(_span(exporter, "run"))
    assert len(attributes) == 18
    assert attributes["ratel.variant.k15"] == 15
    assert "ratel.variant.k16" not in attributes


def test_processor_copies_remote_variant_baggage_as_strings(tracing: Any) -> None:
    tracer, exporter = tracing
    ctx = context.get_current()
    for key, value in {
        "ratel.variant.experiment": "e",
        "ratel.variant.name": "a",
        "ratel.variant.prompt_version": "3",
        "ratel.variant.Bad": "x",
        "other.key": "y",
    }.items():
        ctx = baggage.set_baggage(key, value, ctx)
    token = context.attach(ctx)
    try:
        with tracer.start_as_current_span("remote"):
            pass
    finally:
        context.detach(token)

    assert _variant(_span(exporter, "remote")) == {
        "ratel.variant.experiment": "e",
        "ratel.variant.name": "a",
        "ratel.variant.prompt_version": "3",
    }


def test_processor_ignores_baggage_without_experiment_and_name(tracing: Any) -> None:
    tracer, exporter = tracing
    token = context.attach(baggage.set_baggage("ratel.variant.model", "m"))
    try:
        with tracer.start_as_current_span("partial"):
            pass
    finally:
        context.detach(token)

    assert _variant(_span(exporter, "partial")) == {}


def test_configure_telemetry_adds_the_variant_processor_once(monkeypatch: Any) -> None:
    import ratel_ai_telemetry

    from ratel_ai import configure_telemetry

    class FakeProvider:
        def __init__(self) -> None:
            self.processors: list[Any] = []

        def add_span_processor(self, processor: Any) -> None:
            self.processors.append(processor)

        def shutdown(self) -> None:
            pass

    provider = FakeProvider()
    monkeypatch.setattr(ratel_ai_telemetry, "init", lambda **_kwargs: provider)
    configure_telemetry()
    configure_telemetry()

    assert len(provider.processors) == 1
    assert isinstance(provider.processors[0], ExperimentalVariantSpanProcessor)
