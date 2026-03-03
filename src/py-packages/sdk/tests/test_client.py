import httpx
import pytest
import respx

from agentified.client import Agentified
from agentified.models import (
    AgentifiedConfig,
    AgentifiedEvent,
    RankedTool,
    ServerTool,
)

TEST_URL = "http://localhost:9119"

TEST_TOOL = ServerTool(
    name="get_weather",
    description="Get weather for a city",
    parameters={"type": "object", "properties": {"city": {"type": "string"}}},
)

RANKED_TOOL = RankedTool(**TEST_TOOL.model_dump(), score=0.95)


class TestRegister:
    @respx.mock
    async def test_posts_tools_and_returns_registered_count(self):
        route = respx.post(f"{TEST_URL}/api/v1/tools").mock(
            return_value=httpx.Response(200, json={"registered": 1})
        )

        async with Agentified(
            AgentifiedConfig(server_url=TEST_URL, tools=[TEST_TOOL])
        ) as agent:
            result = await agent.register()

        assert result.registered == 1
        assert route.called
        body = route.calls[0].request.content
        assert b'"tools"' in body


class TestPrefetch:
    @respx.mock
    async def test_posts_discover_from_messages_and_returns_ranked_tools(self):
        respx.post(f"{TEST_URL}/api/v1/discover").mock(
            return_value=httpx.Response(
                200, json={"tools": [RANKED_TOOL.model_dump()]}
            )
        )

        async with Agentified(
            AgentifiedConfig(server_url=TEST_URL, tools=[TEST_TOOL])
        ) as agent:
            result = await agent.prefetch(
                messages=[{"role": "user", "content": "What is the weather in Paris?"}],
                limit=5,
            )

        assert len(result) == 1
        assert result[0].name == "get_weather"
        assert result[0].score == 0.95

    @respx.mock
    async def test_emits_start_and_complete_events_with_timing(self):
        respx.post(f"{TEST_URL}/api/v1/discover").mock(
            return_value=httpx.Response(
                200, json={"tools": [RANKED_TOOL.model_dump()]}
            )
        )

        events: list[AgentifiedEvent] = []
        messages = [{"role": "user", "content": "weather in Paris"}]

        async with Agentified(
            AgentifiedConfig(
                server_url=TEST_URL,
                tools=[TEST_TOOL],
                on_event=lambda e: events.append(e),
            )
        ) as agent:
            await agent.prefetch(messages=messages)

        assert len(events) == 2
        assert events[0].type == "agentified:prefetch:start"
        assert events[1].type == "agentified:prefetch:complete"
        assert events[1].duration_ms >= 0

    @respx.mock
    async def test_passes_exclude_to_discover_body(self):
        route = respx.post(f"{TEST_URL}/api/v1/discover").mock(
            return_value=httpx.Response(
                200, json={"tools": [RANKED_TOOL.model_dump()]}
            )
        )

        async with Agentified(
            AgentifiedConfig(server_url=TEST_URL, tools=[TEST_TOOL])
        ) as agent:
            await agent.prefetch(
                messages=[{"role": "user", "content": "test"}],
                exclude=["frontendTool"],
            )

        import json

        body = json.loads(route.calls[0].request.content)
        assert body["exclude"] == ["frontendTool"]

    @respx.mock
    async def test_omits_exclude_when_not_provided(self):
        route = respx.post(f"{TEST_URL}/api/v1/discover").mock(
            return_value=httpx.Response(200, json={"tools": []})
        )

        async with Agentified(
            AgentifiedConfig(server_url=TEST_URL, tools=[TEST_TOOL])
        ) as agent:
            await agent.prefetch(messages=[{"role": "user", "content": "test"}])

        import json

        body = json.loads(route.calls[0].request.content)
        assert "exclude" not in body

    @respx.mock
    async def test_passes_turn_id_to_discover_body(self):
        route = respx.post(f"{TEST_URL}/api/v1/discover").mock(
            return_value=httpx.Response(
                200, json={"tools": [RANKED_TOOL.model_dump()]}
            )
        )

        async with Agentified(
            AgentifiedConfig(server_url=TEST_URL, tools=[TEST_TOOL])
        ) as agent:
            await agent.prefetch(
                messages=[{"role": "user", "content": "test"}],
                limit=5,
                turn_id="turn-xyz",
            )

        import json

        body = json.loads(route.calls[0].request.content)
        assert body["turn_id"] == "turn-xyz"

    @respx.mock
    async def test_omits_turn_id_when_not_provided(self):
        route = respx.post(f"{TEST_URL}/api/v1/discover").mock(
            return_value=httpx.Response(200, json={"tools": []})
        )

        async with Agentified(
            AgentifiedConfig(server_url=TEST_URL, tools=[TEST_TOOL])
        ) as agent:
            await agent.prefetch(messages=[{"role": "user", "content": "test"}])

        import json

        body = json.loads(route.calls[0].request.content)
        assert "turn_id" not in body


class TestAsDiscoverTool:
    @respx.mock
    async def test_returns_definition_and_calls_discover(self):
        respx.post(f"{TEST_URL}/api/v1/discover").mock(
            return_value=httpx.Response(
                200, json={"tools": [RANKED_TOOL.model_dump()]}
            )
        )

        async with Agentified(
            AgentifiedConfig(server_url=TEST_URL, tools=[TEST_TOOL])
        ) as agent:
            discover_tool = agent.as_discover_tool()

        assert discover_tool.definition.name == "agentified_discover"
        assert "query" in discover_tool.definition.parameters["properties"]

        result = await discover_tool.execute({"query": "weather tools", "limit": 3})
        assert len(result) == 1
        assert result[0].name == "get_weather"

    @respx.mock
    async def test_emits_start_and_complete_events(self):
        respx.post(f"{TEST_URL}/api/v1/discover").mock(
            return_value=httpx.Response(
                200, json={"tools": [RANKED_TOOL.model_dump()]}
            )
        )

        events: list[AgentifiedEvent] = []

        async with Agentified(
            AgentifiedConfig(
                server_url=TEST_URL,
                tools=[TEST_TOOL],
                on_event=lambda e: events.append(e),
            )
        ) as agent:
            await agent.as_discover_tool().execute({"query": "weather"})

        assert len(events) == 2
        assert events[0].type == "agentified:discover:start"
        assert events[0].query == "weather"
        assert events[1].type == "agentified:discover:complete"
        assert events[1].duration_ms >= 0


class TestGetFrontendTools:
    def test_returns_tools_with_frontend_location(self):
        frontend_tool = ServerTool(
            name="confirm_action",
            description="Confirm an action",
            parameters={},
            metadata={"location": "frontend"},
        )
        server_tool = ServerTool(
            name="get_data",
            description="Get data",
            parameters={},
        )

        agent = Agentified(
            AgentifiedConfig(
                server_url=TEST_URL, tools=[frontend_tool, server_tool]
            )
        )
        assert agent.get_frontend_tools() == [frontend_tool]

    def test_returns_empty_when_no_frontend_tools(self):
        agent = Agentified(
            AgentifiedConfig(server_url=TEST_URL, tools=[TEST_TOOL])
        )
        assert agent.get_frontend_tools() == []


class TestGetFrontendToolNames:
    def test_returns_names_of_frontend_tools(self):
        frontend_tool = ServerTool(
            name="confirm_action",
            description="Confirm",
            parameters={},
            metadata={"location": "frontend"},
        )

        agent = Agentified(
            AgentifiedConfig(
                server_url=TEST_URL, tools=[frontend_tool, TEST_TOOL]
            )
        )
        assert agent.get_frontend_tool_names() == ["confirm_action"]


class TestCaptureTurn:
    @respx.mock
    async def test_posts_turn_data_and_returns_turn_id(self):
        route = respx.post(f"{TEST_URL}/api/v1/turns").mock(
            return_value=httpx.Response(201, json={"turn_id": "abc-123"})
        )

        async with Agentified(
            AgentifiedConfig(server_url=TEST_URL, tools=[TEST_TOOL])
        ) as agent:
            result = await agent.capture_turn(
                tools_loaded=["get_weather"],
                message="What is the weather?",
            )

        assert result.turn_id == "abc-123"
        assert route.called


class TestOnEventOptional:
    @respx.mock
    async def test_does_not_crash_when_on_event_not_provided(self):
        respx.post(f"{TEST_URL}/api/v1/discover").mock(
            return_value=httpx.Response(
                200, json={"tools": [RANKED_TOOL.model_dump()]}
            )
        )

        async with Agentified(
            AgentifiedConfig(server_url=TEST_URL, tools=[TEST_TOOL])
        ) as agent:
            result = await agent.prefetch(
                messages=[{"role": "user", "content": "test"}]
            )
            assert len(result) == 1

            result2 = await agent.as_discover_tool().execute({"query": "test"})
            assert len(result2) == 1
