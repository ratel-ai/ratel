"""The read-only tool-sequence span processor (ADR-0028): the Python mirror of
otel-sequence.test.ts."""

from __future__ import annotations

import json
from typing import Any

import pytest

pytest.importorskip("opentelemetry.sdk.trace")

from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import SimpleSpanProcessor  # noqa: E402
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (  # noqa: E402
    InMemorySpanExporter,
)
from opentelemetry.trace import Status, StatusCode  # noqa: E402

from ratel_ai import (  # noqa: E402
    ExecutableTool,
    IntentGraph,
    ToolCatalog,
    experimental_tool_sequence_span_processor,
)


def _tool(tool_id: str) -> ExecutableTool:
    async def run(_args: dict[str, Any]) -> str:
        return tool_id

    return ExecutableTool(id=tool_id, name=tool_id, description=tool_id, execute=run)


class _Setup:
    def __init__(self, catalog: ToolCatalog, graph: IntentGraph) -> None:
        self.catalog = catalog
        self.graph = graph
        self.exporter = InMemorySpanExporter()
        self.provider = TracerProvider()
        self.provider.add_span_processor(experimental_tool_sequence_span_processor(catalog))
        self.provider.add_span_processor(SimpleSpanProcessor(self.exporter))

    def run_tool(self, name: str, scope: str = "gen_ai", error: bool = False) -> None:
        """A host framework's tool span."""
        span = self.provider.get_tracer(scope).start_span(
            f"execute_tool {name}",
            attributes={"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name},
        )
        if error:
            span.set_status(Status(StatusCode.ERROR, "boom"))
        span.end()

    def transitions(self) -> dict[str, Any]:
        result: dict[str, Any] = json.loads(self.graph.to_json()).get("transitions", {})
        return result


async def _setup() -> _Setup:
    catalog = ToolCatalog()
    await catalog.register([_tool("find_task"), _tool("assign_task")])
    graph = IntentGraph()
    catalog.experimental_enable_adaptive_ranking(graph)
    return _Setup(catalog, graph)


async def test_learns_the_order_of_host_tool_spans_inside_a_turn() -> None:
    s = await _setup()
    with s.catalog.turn():
        s.run_tool("find_task")
        s.run_tool("assign_task")
    t = s.transitions()
    assert t["<start>"]["next"] == {"find_task": 1}
    assert t["find_task"]["next"] == {"assign_task": 1}


async def test_counts_a_failed_tool_as_the_choice_it_was() -> None:
    s = await _setup()
    with s.catalog.turn():
        s.run_tool("find_task", error=True)
    assert s.transitions()["<start>"]["next"] == {"find_task": 1}


async def test_ignores_spans_outside_a_turn_ratels_own_and_gateway_tools() -> None:
    s = await _setup()
    s.run_tool("find_task")
    with s.catalog.turn():
        s.run_tool("find_task", scope="ratel-ai")
        for gateway in ("invoke_tool", "search_capabilities", "get_skill_content"):
            s.run_tool(gateway)
    assert s.transitions() == {}


async def test_never_changes_a_span() -> None:
    s = await _setup()
    with s.catalog.turn():
        s.run_tool("find_task")
    (span,) = s.exporter.get_finished_spans()
    assert dict(span.attributes or {}) == {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "find_task",
    }
