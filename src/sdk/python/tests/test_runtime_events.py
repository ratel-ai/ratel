"""Public runtime-events and catalog-snapshot contract (ADR-0020)."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path

import pytest

from ratel_ai import (
    OPTIONAL_ENVELOPE_FIELDS,
    RUNTIME_EVENT_MAX_HITS,
    RUNTIME_EVENT_MAX_PAYLOAD_BYTES,
    RUNTIME_EVENT_MAX_QUERY_BYTES,
    RUNTIME_EVENT_TYPES,
    ExecutableTool,
    IntentGraph,
    RuntimeCatalog,
    RuntimeEvents,
    Skill,
    SkillCatalog,
    ToolCatalog,
)


@pytest.mark.asyncio
async def test_returns_complete_serializable_catalog_without_executable_content() -> None:
    tools = ToolCatalog()
    skills = SkillCatalog()
    await tools.register(
        [
            ExecutableTool(
                id="z_tool",
                name="Z tool",
                description="Last by id",
                input_schema={"type": "object", "properties": {"value": {"type": "string"}}},
                output_schema={"type": "string"},
                execute=lambda _args: {"secret": "must never escape"},
            ),
            ExecutableTool(
                id="a_tool",
                name="A tool",
                description="First by id",
                input_schema={"type": "object"},
                output_schema={"type": "object"},
                execute=lambda _args: {},
            ),
        ]
    )
    await skills.register(
        Skill(
            id="skill-a",
            name="Skill A",
            description="Public skill metadata",
            tags=["public"],
            tools=["a_tool"],
            metadata={"stacks": ["python"]},
            body="May contain private instructions",
        )
    )

    snapshot = RuntimeCatalog(tools, skills, source_id="service-a").snapshot()

    assert snapshot == {
        "source_id": "service-a",
        "tools": [
            {
                "id": "a_tool",
                "name": "A tool",
                "description": "First by id",
                "input_schema": {"type": "object"},
                "output_schema": {"type": "object"},
            },
            {
                "id": "z_tool",
                "name": "Z tool",
                "description": "Last by id",
                "input_schema": {
                    "type": "object",
                    "properties": {"value": {"type": "string"}},
                },
                "output_schema": {"type": "string"},
            },
        ],
        "skills": [
            {
                "id": "skill-a",
                "name": "Skill A",
                "description": "Public skill metadata",
                "tags": ["public"],
                "tools": ["a_tool"],
                "metadata": {"stacks": ["python"]},
            }
        ],
    }
    encoded = json.dumps(snapshot)
    assert "execute" not in encoded
    assert "private instructions" not in encoded


@pytest.mark.asyncio
async def test_merges_tool_and_skill_events_for_sync_handlers_off_thread() -> None:
    tools = ToolCatalog()
    skills = SkillCatalog()
    events = RuntimeEvents(
        [tools, skills],
        session_id="session-public",
        source_id="source-public",
        queue_capacity=16,
        batch_size=8,
    )
    received: list[dict[str, object]] = []
    handler_threads: list[int] = []
    producer_thread = threading.get_ident()

    def handler(batch: list[dict[str, object]]) -> None:
        received.extend(batch)
        handler_threads.append(threading.get_ident())

    subscription = events.subscribe(handler)
    await tools.register(
        ExecutableTool(
            id="read_file",
            name="read_file",
            description="Read a file",
            execute=lambda _args: {},
        )
    )
    await skills.register(
        Skill(id="api-design", name="API design", description="Design an API", body="Private")
    )
    tools.search("read", 1)
    skills.search("api", 1)

    await subscription.flush()

    assert {event["type"] for event in received} >= {
        "index_churn",
        "skill_churn",
        "search",
        "skill_search",
    }
    assert all(event["session_id"] == "session-public" for event in received)
    assert all(event["source_id"] == "source-public" for event in received)
    assert all(handler_thread != producer_thread for handler_thread in handler_threads)
    subscription.unsubscribe()


def test_matches_frozen_cross_language_event_vocabulary() -> None:
    fixtures = json.loads(
        (Path(__file__).parents[3] / "telemetry" / "conformance" / "fixtures.json").read_text()
    )

    assert fixtures["runtime_events"] == {
        "version": 2,
        "max_payload_bytes": RUNTIME_EVENT_MAX_PAYLOAD_BYTES,
        "max_query_bytes": RUNTIME_EVENT_MAX_QUERY_BYTES,
        "max_hits": RUNTIME_EVENT_MAX_HITS,
        "otel_event_id_attribute": "ratel.event.id",
        "required_envelope_fields": [
            "v",
            "event_id",
            "ts",
            "session_id",
            "source_id",
            "type",
        ],
        "optional_envelope_fields": list(OPTIONAL_ENVELOPE_FIELDS),
        "event_types": list(RUNTIME_EVENT_TYPES),
    }


@pytest.mark.parametrize("capture_mode", ["NO_CONTENT", "SPAN_AND_EVENT"])
async def test_publishes_catalog_definitions_independently_of_otel_capture_mode(
    capture_mode: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", capture_mode)
    tools = ToolCatalog()
    events = RuntimeEvents([tools], experimental_catalog_definitions=True)
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))

    await tools.register(
        ExecutableTool(
            id="read_file",
            name="read_file",
            description="Read a file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            output_schema={"type": "object"},
            execute=lambda _args: {"secret": "executor result"},
        )
    )
    await subscription.flush()

    definition = next(event for event in received if event["type"] == "catalog_definition")
    expected = {
        "kind": "tool",
        "id": "read_file",
        "name": "read_file",
        "description": "Read a file",
        "tags": [],
        "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}},
        "output_schema": {"type": "object"},
        "searchable_description": "Read a file",
        "searchable_description_overridden": False,
    }
    assert {key: definition[key] for key in expected} == expected
    assert "execute" not in definition
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_preserves_catalog_identity_while_trimming_an_oversized_schema() -> None:
    tools = ToolCatalog()
    events = RuntimeEvents([tools], experimental_catalog_definitions=True)
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))
    properties = {
        f"field_{index}": {"type": "string", "description": "x" * 4_096}
        for index in range(100)
    }

    await tools.register(
        ExecutableTool(
            id="oversized",
            name="oversized_tool",
            description="Oversized schema",
            input_schema={"type": "object", "properties": properties},
            output_schema={"type": "object"},
            execute=lambda _args: None,
        )
    )
    await subscription.flush()

    definition = next(event for event in received if event["type"] == "catalog_definition")
    assert definition["kind"] == "tool"
    assert definition["id"] == "oversized"
    assert definition["name"] == "oversized_tool"
    assert definition["payload_truncated"] is True
    assert len(str(definition["content_hash"])) == 64
    assert "input_schema" not in definition
    assert definition["output_schema"] == {"type": "object"}
    assert len(json.dumps(definition, separators=(",", ":")).encode()) <= (
        RUNTIME_EVENT_MAX_PAYLOAD_BYTES
    )
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_catalog_definitions_are_disabled_by_default() -> None:
    tools = ToolCatalog()
    events = RuntimeEvents([tools])
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))
    await tools.register(
        ExecutableTool(
            id="read_file",
            name="read_file",
            description="Read a file",
            execute=lambda _args: {},
        )
    )
    await subscription.flush()
    assert all(event["type"] != "catalog_definition" for event in received)
    subscription.unsubscribe()


class TestDefaultSourceId:
    """The default source_id chain (ADR-0020): OTEL_SERVICE_NAME, then service.name in
    OTEL_RESOURCE_ATTRIBUTES, then the service name the telemetry helper recorded from a
    programmatic configure_telemetry/init, then "ratel"."""

    @pytest.fixture(autouse=True)
    def _no_service_name_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("OTEL_SERVICE_NAME", raising=False)
        monkeypatch.delenv("OTEL_RESOURCE_ATTRIBUTES", raising=False)

    def test_falls_back_to_the_recorded_telemetry_service_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from ratel_ai_telemetry import otlp

        monkeypatch.setattr(otlp, "recorded_service_name", lambda: "checkout-agent")

        assert RuntimeEvents(()).source_id == "checkout-agent"

    def test_otel_service_name_env_wins_over_the_recorded_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from ratel_ai_telemetry import otlp

        monkeypatch.setattr(otlp, "recorded_service_name", lambda: "recorded-loser")
        monkeypatch.setenv("OTEL_SERVICE_NAME", "env-winner")

        assert RuntimeEvents(()).source_id == "env-winner"

    def test_resource_attributes_env_wins_over_the_recorded_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from ratel_ai_telemetry import otlp

        monkeypatch.setattr(otlp, "recorded_service_name", lambda: "recorded-loser")
        monkeypatch.setenv("OTEL_RESOURCE_ATTRIBUTES", "service.name=attr-winner")

        assert RuntimeEvents(()).source_id == "attr-winner"

    def test_falls_back_to_ratel_when_nothing_is_configured(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from ratel_ai_telemetry import otlp

        monkeypatch.setattr(otlp, "recorded_service_name", lambda: None)

        assert RuntimeEvents(()).source_id == "ratel"

    def test_tolerates_a_telemetry_release_predating_the_seam(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # ratel-ai floors ratel-ai-telemetry below the seam's release; an older helper
        # without recorded_service_name must degrade to the bare fallback, not raise.
        from ratel_ai_telemetry import otlp

        monkeypatch.delattr(otlp, "recorded_service_name")

        assert RuntimeEvents(()).source_id == "ratel"


def test_rolls_back_earlier_native_subscriptions_when_a_later_source_rejects() -> None:
    unsubscribed: list[str] = []

    class FirstSubscription:
        dropped_count = 0

        def unsubscribe(self) -> None:
            unsubscribed.append("first")

        def flush(self) -> None:
            pass

    class FirstSource:
        def subscribe_events(
            self,
            handler: object,
            *,
            session_id: str,
            source_id: str,
            queue_capacity: int,
            batch_size: int,
        ) -> FirstSubscription:
            return FirstSubscription()

    class BusySource:
        def subscribe_events(
            self,
            handler: object,
            *,
            session_id: str,
            source_id: str,
            queue_capacity: int,
            batch_size: int,
        ) -> FirstSubscription:
            raise RuntimeError("registry busy")

    events = RuntimeEvents([FirstSource(), BusySource()])  # type: ignore[list-item]

    with pytest.raises(RuntimeError, match="registry busy"):
        events.subscribe(lambda batch: None)
    assert unsubscribed == ["first"]


def test_unsubscribe_still_delivers_envelopes_already_queued_by_native() -> None:
    tools = ToolCatalog()
    events = RuntimeEvents([tools], queue_capacity=16, batch_size=1)
    first_batch_started = threading.Event()
    release_first_batch = threading.Event()
    queued_batch_delivered = threading.Event()

    def handler(batch: list[dict[str, object]]) -> None:
        if not first_batch_started.is_set():
            first_batch_started.set()
            release_first_batch.wait(timeout=1)
        if any(event.get("query") == "already-queued" for event in batch):
            queued_batch_delivered.set()

    subscription = events.subscribe(handler)
    tools.search("first", 1)
    assert first_batch_started.wait(timeout=1)
    tools.search("already-queued", 1)

    subscription.unsubscribe()
    release_first_batch.set()

    assert queued_batch_delivered.wait(timeout=2)


@pytest.mark.asyncio
async def test_bounds_query_hits_and_payload_before_delivery() -> None:
    tools = ToolCatalog()
    skills = SkillCatalog()
    events = RuntimeEvents([tools, skills])
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))
    await tools.register(
        [
            ExecutableTool(
                id=f"tool-{index:03d}",
                name=f"Tool {index:03d}",
                description="padding " * 1_000,
                execute=lambda _args: {},
            )
            for index in range(120)
        ]
    )

    tools.search("padding " * 1_000, 120)
    await subscription.flush()

    event = next(item for item in received if item["type"] == "search")
    assert len(str(event["query"]).encode()) <= RUNTIME_EVENT_MAX_QUERY_BYTES
    assert len(event["hits"]) == RUNTIME_EVENT_MAX_HITS  # type: ignore[arg-type]
    assert len(json.dumps(event, separators=(",", ":")).encode()) <= RUNTIME_EVENT_MAX_PAYLOAD_BYTES
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_stamps_matching_turn_id_on_search_invoke_start_and_invoke_end() -> None:
    tools = ToolCatalog()
    events = RuntimeEvents([tools])
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))
    await tools.register(
        ExecutableTool(id="t", name="t", description="a tool", execute=lambda _args: "ok")
    )
    received.clear()  # discard registration churn

    tools.search("do the thing", 5, turn_id="turn-xyz")
    await tools.invoke("t", {}, turn_id="turn-xyz")
    await subscription.flush()

    by_type = {event["type"]: event for event in received}
    assert by_type["search"]["turn_id"] == "turn-xyz"
    assert by_type["invoke_start"]["turn_id"] == "turn-xyz"
    assert by_type["invoke_end"]["turn_id"] == "turn-xyz"
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_stamps_matching_turn_id_on_skill_search_and_skill_invoke() -> None:
    skills = SkillCatalog()
    events = RuntimeEvents([skills])
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))
    await skills.register(
        Skill(id="s", name="s", description="a skill", tags=[], tools=[], metadata={}, body="# s")
    )
    received.clear()  # discard registration churn

    skills.search("do the thing", 5, turn_id="turn-xyz")
    skills.invoke("s", turn_id="turn-xyz")
    await subscription.flush()

    by_type = {event["type"]: event for event in received}
    assert by_type["skill_search"]["turn_id"] == "turn-xyz"
    assert by_type["skill_invoke"]["turn_id"] == "turn-xyz"
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_omits_turn_id_entirely_when_none_is_supplied() -> None:
    tools = ToolCatalog()
    events = RuntimeEvents([tools])
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))

    tools.search("do the thing", 5)
    await subscription.flush()

    search = next(event for event in received if event["type"] == "search")
    assert "turn_id" not in search
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_turn_id_survives_oversize_trimming_of_a_search_event() -> None:
    tools = ToolCatalog()
    events = RuntimeEvents([tools])
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))
    # 100 hits with long ids push the search event's serialized size well past the
    # payload cap even after query/hit-count bounding, forcing real trimming.
    await tools.register(
        [
            ExecutableTool(
                id=f"tool-{index:03d}-" + "x" * 1_500,
                name=f"tool-{index:03d}",
                description="padding",
                execute=lambda _args: "ok",
            )
            for index in range(100)
        ]
    )
    received.clear()  # discard registration churn

    tools.search("padding", 100, turn_id="turn-abc")
    await subscription.flush()

    search = next(event for event in received if event["type"] == "search")
    assert search["turn_id"] == "turn-abc"
    assert search.get("payload_truncated") is True
    encoded = json.dumps(search, separators=(",", ":")).encode()
    assert len(encoded) <= RUNTIME_EVENT_MAX_PAYLOAD_BYTES
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_marshals_async_handlers_to_the_subscribing_event_loop() -> None:
    tools = ToolCatalog()
    skills = SkillCatalog()
    events = RuntimeEvents([tools, skills], session_id="session-async")
    received: list[dict[str, object]] = []
    handler_threads: list[int] = []
    event_loop_thread = threading.get_ident()

    async def handler(batch: list[dict[str, object]]) -> None:
        await asyncio.sleep(0)
        received.extend(batch)
        handler_threads.append(threading.get_ident())

    subscription = events.subscribe(handler)
    tools.search("anything", 1)

    await subscription.flush()

    assert [event["type"] for event in received] == ["search"]
    assert handler_threads == [event_loop_thread]
    subscription.unsubscribe()


def test_counts_and_warns_when_an_async_handlers_event_loop_is_closed() -> None:
    tools = ToolCatalog()
    events = RuntimeEvents([tools], batch_size=1)

    async def handler(_batch: list[dict[str, object]]) -> None:
        pass

    async def subscribe():
        return events.subscribe(handler)

    subscription = asyncio.run(subscribe())

    with pytest.warns(RuntimeWarning, match="event loop is closed") as warning_records:
        tools.search("after-close", 1)
        tools.search("still-closed", 1)
        deadline = time.monotonic() + 1
        while subscription.dropped_count < 2 and time.monotonic() < deadline:
            time.sleep(0.01)

    assert subscription.dropped_count == 2
    assert len(warning_records) == 1
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_marshals_handlers_that_return_an_awaitable_to_the_event_loop() -> None:
    tools = ToolCatalog()
    events = RuntimeEvents([tools])
    received: list[dict[str, object]] = []
    handler_threads: list[int] = []
    event_loop_thread = threading.get_ident()

    async def async_handler(batch: list[dict[str, object]]) -> None:
        received.extend(batch)
        handler_threads.append(threading.get_ident())

    subscription = events.subscribe(lambda batch: async_handler(batch))
    tools.search("anything", 1)

    await subscription.flush()

    assert [event["type"] for event in received] == ["search"]
    assert handler_threads == [event_loop_thread]
    subscription.unsubscribe()


def _known_cluster_graph() -> IntentGraph:
    """A lexical (no-centroid) graph with one cluster already fully supported,
    so adaptive ranking boosts on the first search without needing to learn
    first."""
    return IntentGraph.from_json(
        json.dumps(
            {
                "v": 1,
                "built_from_ts": 1,
                "intents": [
                    {
                        "id": "i0",
                        "label": "l",
                        "terms": [],
                        "members": ["why is the build broken"],
                        "support": 9,
                        "tools": {"gh_run_list": 1.0},
                        "skills": {},
                    }
                ],
            }
        )
    )


async def _gh_run_list_catalog() -> ToolCatalog:
    catalog = ToolCatalog()
    await catalog.register(
        ExecutableTool(
            id="gh_run_list",
            name="gh_run_list",
            description="List CI workflow runs and whether the build passed",
            execute=lambda _a: "ok",
        )
    )
    return catalog


@pytest.mark.asyncio
async def test_usage_boost_reports_the_matched_cluster_and_promoted_count_on_a_hit() -> None:
    tools = await _gh_run_list_catalog()
    events = RuntimeEvents([tools])
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))
    tools.experimental_enable_adaptive_ranking(_known_cluster_graph(), learn=False)

    tools.search("why is the build broken", 5)
    await subscription.flush()

    boost = next(e for e in received if e["type"] == "usage_boost")
    assert boost["intent"] == "i0"
    assert boost["promoted"] == 1
    assert boost["dropped"] == 0
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_usage_boost_reports_a_null_intent_and_no_promotion_on_a_miss() -> None:
    tools = await _gh_run_list_catalog()
    events = RuntimeEvents([tools])
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))
    tools.experimental_enable_adaptive_ranking(_known_cluster_graph(), learn=False)

    tools.search("read a file from disk", 5)
    await subscription.flush()

    boost = next(e for e in received if e["type"] == "usage_boost")
    assert boost["intent"] is None
    assert boost["promoted"] == 0
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_no_usage_boost_is_delivered_without_a_graph_attached() -> None:
    tools = await _gh_run_list_catalog()
    events = RuntimeEvents([tools])
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))

    tools.search("why is the build broken", 5)
    await subscription.flush()

    assert not any(e["type"] == "usage_boost" for e in received)
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_usage_cluster_policy_changed_reports_built_vs_active_similarity() -> None:
    tools = await _gh_run_list_catalog()
    graph = IntentGraph.from_json(
        json.dumps(
            {
                "v": 1,
                "built_from_ts": 1,
                "cluster_policy": {"similarity": 0.7, "coverage": 0.5},
                "intents": [
                    {
                        "id": "i0",
                        "label": "l",
                        "terms": [],
                        "members": ["why is the build broken"],
                        "support": 9,
                        "tools": {"gh_run_list": 1.0},
                        "skills": {},
                    }
                ],
            }
        )
    )
    events = RuntimeEvents([tools])
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))
    tools.experimental_enable_adaptive_ranking(graph, learn=False, cluster_similarity=0.9)

    tools.search("anything", 5)
    await subscription.flush()

    drift = next(e for e in received if e["type"] == "usage_cluster_policy_changed")
    assert drift["built_similarity"] == pytest.approx(0.7)
    assert drift["active_similarity"] == pytest.approx(0.9)
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_usage_ranking_status_on_enable_carries_rev_and_graph_key() -> None:
    tools = await _gh_run_list_catalog()
    graph = _known_cluster_graph()
    events = RuntimeEvents([tools])
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))

    tools.experimental_enable_adaptive_ranking(graph, learn=False, graph_key="cloud")
    await subscription.flush()

    status = next(e for e in received if e["type"] == "usage_ranking_status")
    assert status["status"] == "active"
    assert status["reason"] == "enabled"
    assert status["rev"] == graph.rev
    assert status["graph_key"] == "cloud"
    assert status["learn"] is False
    assert "model" not in status
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_usage_ranking_status_omits_graph_key_and_defaults_learn_true() -> None:
    tools = await _gh_run_list_catalog()
    events = RuntimeEvents([tools])
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))

    tools.experimental_enable_adaptive_ranking(_known_cluster_graph())
    await subscription.flush()

    status = next(e for e in received if e["type"] == "usage_ranking_status")
    assert "graph_key" not in status
    assert status["learn"] is True
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_usage_ranking_status_inactive_on_disable_has_no_rev_or_graph_key() -> None:
    tools = await _gh_run_list_catalog()
    tools.experimental_enable_adaptive_ranking(_known_cluster_graph(), graph_key="cloud")
    events = RuntimeEvents([tools])
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))

    tools.experimental_disable_adaptive_ranking()
    await subscription.flush()

    status = next(e for e in received if e["type"] == "usage_ranking_status")
    assert status["status"] == "inactive"
    assert status["reason"] == "disabled"
    assert "rev" not in status
    assert "graph_key" not in status
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_usage_ranking_status_carries_the_graphs_model_when_present() -> None:
    tools = await _gh_run_list_catalog()
    graph = IntentGraph.from_json(
        json.dumps(
            {
                "v": 1,
                "built_from_ts": 1,
                "model": "bge-small",
                "intents": [
                    {
                        "id": "i0",
                        "label": "l",
                        "terms": [],
                        "members": ["why is the build broken"],
                        "centroid": [1.0, 0.0, 0.0],
                        "support": 9,
                        "tools": {"gh_run_list": 1.0},
                        "skills": {},
                    }
                ],
            }
        )
    )
    events = RuntimeEvents([tools])
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))

    tools.experimental_enable_adaptive_ranking(graph, learn=False)
    await subscription.flush()

    status = next(e for e in received if e["type"] == "usage_ranking_status")
    assert status["model"] == "bge-small"
    subscription.unsubscribe()


@pytest.mark.asyncio
async def test_usage_ranking_status_on_skill_catalog_for_enable_and_disable() -> None:
    skills = SkillCatalog()
    await skills.register(
        Skill(id="s", name="s", description="a skill", tags=[], tools=[], metadata={}, body="# s")
    )
    graph = _known_cluster_graph()
    events = RuntimeEvents([skills])
    received: list[dict[str, object]] = []
    subscription = events.subscribe(lambda batch: received.extend(batch))

    skills.experimental_enable_adaptive_ranking(graph, learn=False, graph_key="cloud")
    await subscription.flush()
    enabled = next(e for e in received if e["type"] == "usage_ranking_status")
    assert enabled["status"] == "active"
    assert enabled["reason"] == "enabled"
    assert enabled["rev"] == graph.rev
    assert enabled["graph_key"] == "cloud"
    assert enabled["learn"] is False
    received.clear()

    skills.experimental_disable_adaptive_ranking()
    await subscription.flush()
    disabled = next(e for e in received if e["type"] == "usage_ranking_status")
    assert disabled["status"] == "inactive"
    assert disabled["reason"] == "disabled"
    assert "rev" not in disabled
    assert "graph_key" not in disabled
    subscription.unsubscribe()
