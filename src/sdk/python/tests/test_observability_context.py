"""Trace-tree nesting and async-task isolation (contextvars)."""

from __future__ import annotations

import asyncio

from ratel_ai.observability import CaptureExporter
from ratel_ai.observability import context as ctx


def _events_of(exporter: CaptureExporter, event_type: str) -> list[dict]:
    return [e for e in exporter.events if e["type"] == event_type]


def test_nested_spans_form_a_tree(capture: CaptureExporter) -> None:
    from ratel_ai import get_client

    client = get_client()
    with client.start_as_current_span("parent") as parent:
        with client.start_as_current_span("child") as child:
            assert ctx.current_observation_id() == child.observation_id
            assert child.parent_observation_id == parent.observation_id
        # back to parent scope after the child closes
        assert ctx.current_observation_id() == parent.observation_id
    assert ctx.current_observation_id() is None

    obs = _events_of(capture, "observation-create")
    assert len(obs) == 2
    # all observations share one trace
    assert len({e["trace_id"] for e in obs}) == 1


def test_single_trace_root_emitted_for_a_tree(capture: CaptureExporter) -> None:
    from ratel_ai import get_client

    client = get_client()
    with client.start_as_current_span("a"):
        with client.start_as_current_span("b"):
            pass
    traces = _events_of(capture, "trace-create")
    assert len(traces) == 1


def test_async_tasks_have_isolated_context(capture: CaptureExporter) -> None:
    from ratel_ai import get_client

    client = get_client()

    async def worker(tag: str) -> str | None:
        with client.start_as_current_span(f"work-{tag}") as obs:
            await asyncio.sleep(0)
            # each task sees only its own observation as current
            assert ctx.current_observation_id() == obs.observation_id
            return obs.parent_observation_id

    async def main() -> list[str | None]:
        return await asyncio.gather(worker("1"), worker("2"))

    parents = asyncio.run(main())
    # concurrent tasks each started their own root span (no shared parent)
    assert parents == [None, None]
