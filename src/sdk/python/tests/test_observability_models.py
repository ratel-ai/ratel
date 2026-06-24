"""Wire-model shape tests (ADR-0013)."""

from __future__ import annotations

from ratel_ai.observability.models import (
    ObservationCreate,
    TraceCreate,
    build_batch,
    capture_field,
    gen_ai_block,
    usage_block,
)


def test_capture_field_includes_value_when_enabled() -> None:
    field = capture_field({"role": "user", "content": "hi"}, enabled=True)
    assert field["captured"] is True
    assert field["value"] == {"role": "user", "content": "hi"}


def test_capture_field_omits_content_when_disabled() -> None:
    field = capture_field("a secret prompt", enabled=False)
    assert field["captured"] is False
    assert field["length"] == len("a secret prompt")
    assert "value" not in field


def test_jsonable_coerces_unknown_objects() -> None:
    class Resp:
        def __init__(self) -> None:
            self.model = "gpt-4o"
            self._private = "hidden"

    field = capture_field(Resp(), enabled=True)
    assert field["value"] == {"model": "gpt-4o"}


def test_usage_block_derives_total_when_missing() -> None:
    assert usage_block({"input_tokens": 10, "output_tokens": 5}) == {
        "input_tokens": 10,
        "output_tokens": 5,
        "total_tokens": 15,
    }


def test_usage_block_drops_unknown_keys_and_empty() -> None:
    assert usage_block({"weird": 1}) is None
    assert usage_block(None) is None


def test_gen_ai_block_is_otel_named() -> None:
    block = gen_ai_block(
        system="openai",
        request_model="gpt-4o",
        response_model="gpt-4o-2024-08-06",
        request_params={"temperature": 0.2},
        finish_reasons=["stop"],
        usage={"input_tokens": 8, "output_tokens": 2},
    )
    assert block["system"] == "openai"
    assert block["request"]["model"] == "gpt-4o"
    assert block["request"]["temperature"] == 0.2
    assert block["response"]["model"] == "gpt-4o-2024-08-06"
    assert block["response"]["finish_reasons"] == ["stop"]
    assert block["usage"]["total_tokens"] == 10


def test_trace_create_wire_shape() -> None:
    wire = TraceCreate(
        id="evt_1",
        trace_id="trc_1",
        timestamp=1750800000000,
        name="root",
        user_id="u1",
        tags=["prod"],
    ).to_wire()
    assert wire["type"] == "trace-create"
    assert wire["trace_id"] == "trc_1"
    assert wire["tags"] == ["prod"]
    assert wire["version"] is None


def test_observation_create_wire_shape_with_gen_ai() -> None:
    wire = ObservationCreate(
        id="evt_2",
        trace_id="trc_1",
        observation_id="obs_1",
        observation_type="generation",
        timestamp=1750800000010,
        name="llm",
        start_time=1750800000000,
        end_time=1750800000010,
        input={"captured": True, "value": "hi"},
        output={"captured": True, "value": "yo"},
        gen_ai=gen_ai_block(system="openai", request_model="gpt-4o", usage={"input_tokens": 1}),
    )
    out = wire.to_wire()
    assert out["type"] == "observation-create"
    assert out["observation_type"] == "generation"
    assert out["parent_observation_id"] is None
    assert out["gen_ai"]["request"]["model"] == "gpt-4o"


def test_observation_create_omits_gen_ai_for_spans() -> None:
    wire = ObservationCreate(
        id="evt_3",
        trace_id="trc_1",
        observation_id="obs_2",
        observation_type="span",
        timestamp=1,
    ).to_wire()
    assert "gen_ai" not in wire


def test_jsonable_survives_cyclic_objects() -> None:
    cyclic: dict[str, object] = {}
    cyclic["self"] = cyclic
    # Must not raise (RecursionError) and must terminate.
    field = capture_field(cyclic, enabled=True)
    assert field["captured"] is True


def test_jsonable_sets_are_deterministic() -> None:
    field = capture_field({3, 1, 2}, enabled=True)
    assert field["value"] == [1, 2, 3]


def test_build_batch_envelope() -> None:
    envelope = build_batch([{"id": "evt_1", "type": "trace-create"}])
    assert envelope["schema_version"] == 1
    assert envelope["sdk"]["name"] == "ratel-ai-python"
    assert isinstance(envelope["sdk"]["version"], str)
    assert len(envelope["batch"]) == 1
