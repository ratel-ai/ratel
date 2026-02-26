import json

from agentified.tool import tool


def test_converts_definition_to_server_tool_with_fields():
    result = tool(
        name="get_weather",
        description="Get weather for a city",
        parameters={
            "type": "object",
            "properties": {"city": {"type": "string"}},
        },
    )

    assert result.name == "get_weather"
    assert result.description == "Get weather for a city"
    assert result.parameters == {
        "type": "object",
        "properties": {"city": {"type": "string"}},
    }
    assert result.metadata is None
    assert result.fields is not None
    assert result.fields.name == "get_weather"
    assert result.fields.description == "Get weather for a city"
    assert result.fields.input_schema == json.dumps(
        {"type": "object", "properties": {"city": {"type": "string"}}}
    )


def test_preserves_metadata_when_provided():
    result = tool(
        name="confirm",
        description="Confirm action",
        parameters={},
        metadata={"location": "frontend"},
    )

    assert result.metadata == {"location": "frontend"}
