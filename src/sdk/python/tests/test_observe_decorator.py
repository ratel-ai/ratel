"""The @observe decorator — sync/async, capture, nesting, fail-open."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from ratel_ai import observe
from ratel_ai.observability import CaptureExporter, RatelClient, set_global_client


def _observations(exporter: CaptureExporter) -> list[dict[str, Any]]:
    return [e for e in exporter.events if e["type"] == "observation-create"]


def test_sync_function_captures_input_and_output(capture: CaptureExporter) -> None:
    @observe()
    def add(a: int, b: int) -> int:
        return a + b

    assert add(2, 3) == 5
    obs = _observations(capture)
    assert len(obs) == 1
    assert obs[0]["name"].endswith("add")
    assert obs[0]["input"]["value"] == {"a": 2, "b": 3}
    assert obs[0]["output"]["value"] == 5
    assert obs[0]["status"] == "ok"


def test_bare_decorator_without_parens(capture: CaptureExporter) -> None:
    @observe
    def greet(name: str) -> str:
        return f"hi {name}"

    assert greet("ada") == "hi ada"
    assert len(_observations(capture)) == 1


def test_async_function_is_traced(capture: CaptureExporter) -> None:
    @observe(name="async-job")
    async def job(x: int) -> int:
        await asyncio.sleep(0)
        return x * 2

    assert asyncio.run(job(21)) == 42
    obs = _observations(capture)
    assert obs[0]["name"] == "async-job"
    assert obs[0]["output"]["value"] == 42


def test_exception_records_error_and_propagates(capture: CaptureExporter) -> None:
    @observe()
    def boom() -> None:
        raise ValueError("nope")

    with pytest.raises(ValueError, match="nope"):
        boom()
    obs = _observations(capture)
    assert obs[0]["status"] == "error"
    assert obs[0]["status_message"] == "nope"


def test_nested_calls_form_a_tree(capture: CaptureExporter) -> None:
    @observe()
    def inner(x: int) -> int:
        return x + 1

    @observe()
    def outer(x: int) -> int:
        return inner(x) + 1

    assert outer(1) == 3
    obs = _observations(capture)
    assert len(obs) == 2
    by_name = {o["name"].split(".")[-1].split("<locals>")[-1]: o for o in obs}
    inner_obs = next(o for o in obs if o["name"].endswith("inner"))
    outer_obs = next(o for o in obs if o["name"].endswith("outer"))
    assert inner_obs["parent_observation_id"] == outer_obs["observation_id"]
    assert len({o["trace_id"] for o in obs}) == 1
    assert by_name  # silence unused in case of future edits


def test_generation_as_type_with_capture_off(capture: CaptureExporter) -> None:
    @observe(as_type="generation", capture_input=False)
    def call(prompt: str) -> str:
        return "answer"

    call("secret prompt")
    obs = _observations(capture)
    assert obs[0]["observation_type"] == "generation"
    assert obs[0]["input"]["captured"] is False


def test_observability_failure_never_breaks_the_function() -> None:
    class BrokenClient(RatelClient):
        def start_observation(self, *args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("observability is broken")

    set_global_client(BrokenClient(api_key="rk-test", exporter=CaptureExporter()))

    @observe()
    def work(x: int) -> int:
        return x * 10

    # The decorator must swallow the broken-observability error.
    assert work(4) == 40
