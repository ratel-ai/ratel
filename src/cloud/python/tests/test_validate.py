from __future__ import annotations

from typing import Any

from ratel_ai_cloud import Event, validate


def minimal() -> Event:
    return {
        "provider": "openai",
        "model": "gpt-5.5",
        "ts": "2026-06-30T12:00:00Z",
        "stream": False,
        "messages": [{"role": "user", "content": "hi"}],
    }


def paths(event: Any) -> list[str]:
    result = validate(event)
    return [i.path for i in result.issues]


def test_minimal_event_is_valid() -> None:
    assert validate(minimal()).ok


def test_empty_provider_model_ts_rejected() -> None:
    event = {**minimal(), "provider": "", "model": "  ", "ts": ""}
    p = paths(event)
    assert "provider" in p
    assert "model" in p
    assert "ts" in p


def test_empty_messages_rejected() -> None:
    assert paths({**minimal(), "messages": []}) == ["messages"]


def test_tool_call_in_user_message_rejected() -> None:
    event = {
        **minimal(),
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_call",
                        "id": "c1",
                        "name": "w",
                        "arguments": {"location": "Paris"},
                    }
                ],
            }
        ],
    }
    assert paths(event) == ["messages[0].content[0]"]


def test_tool_call_in_assistant_message_allowed() -> None:
    event = {
        **minimal(),
        "messages": [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_call",
                        "id": "c1",
                        "name": "w",
                        "arguments": {"location": "Paris"},
                    }
                ],
            }
        ],
    }
    assert validate(event).ok


def test_non_object_tool_arguments_rejected() -> None:
    event = {
        **minimal(),
        "messages": [
            {
                "role": "assistant",
                "content": [{"type": "tool_call", "id": "c1", "name": "x", "arguments": "nope"}],
            }
        ],
    }
    assert paths(event) == ["messages[0].content[0].arguments"]


def test_image_without_source_or_url_rejected() -> None:
    event = {
        **minimal(),
        "messages": [{"role": "user", "content": [{"type": "image", "media_type": "image/png"}]}],
    }
    assert paths(event) == ["messages[0].content[0]"]


def test_tool_parameters_not_object_rejected() -> None:
    event = {**minimal(), "tools": [{"name": "x", "parameters": "nope"}]}
    assert paths(event) == ["tools[0].parameters"]


def test_missing_required_fields_reported_not_raised() -> None:
    # Mirrors the TS host-safety contract: malformed input is reported, never raised.
    event = {"model": "x", "ts": "x", "messages": [{"role": "user", "content": "hi"}]}
    result = validate(event)
    assert not result.ok
    assert "provider" in [i.path for i in result.issues]


def test_empty_object_does_not_raise() -> None:
    result = validate({})
    assert not result.ok


def test_non_object_message_reported() -> None:
    event = {"provider": "p", "model": "m", "ts": "t", "messages": [None]}
    assert paths(event) == ["messages[0]"]


def test_full_savings_facet_is_valid() -> None:
    event = {
        **minimal(),
        "savings": {
            "tokens_by_category": {
                "skills": 120,
                "tools": 400,
                "history": 900,
                "memory": 50,
                "user_input": 30,
            },
            "saved_by_category": {"tools": 3800},
        },
    }
    assert validate(event).ok


def test_over_int4_savings_count_rejected() -> None:
    event = {**minimal(), "savings": {"tokens_by_category": {"tools": 3_000_000_000}}}
    assert paths(event) == ["savings.tokens_by_category.tools"]
