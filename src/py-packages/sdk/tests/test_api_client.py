import json

import httpx
import pytest
import respx

from agentified.api_client import ApiClient
from agentified.models import (
    AgentifiedEvent,
    ApiClientConfig,
    RankedTool,
    ServerTool,
    StoredMessage,
)

TEST_URL = "http://localhost:9119"
DATASET = "test-dataset"

TEST_TOOL = ServerTool(
    name="get_weather",
    description="Get weather for a city",
    parameters={"type": "object", "properties": {"city": {"type": "string"}}},
)

RANKED_TOOL = RankedTool(**TEST_TOOL.model_dump(), score=0.95)

STORED_MSG = {
    "id": "msg-1",
    "role": "user",
    "content": "hello",
    "tool_call_id": None,
    "tool_calls": None,
    "created_at": "2026-01-01T00:00:00Z",
    "seq": 1,
}


class TestRegister:
    @respx.mock
    async def test_posts_tools_to_dataset_endpoint(self):
        route = respx.post(f"{TEST_URL}/api/v1/datasets/{DATASET}/tools").mock(
            return_value=httpx.Response(200, json={"registered": 2})
        )
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[TEST_TOOL]))
        result = await client.register(DATASET)

        assert result.registered == 2
        assert route.called
        body = json.loads(route.calls[0].request.content)
        assert "tools" in body


class TestDiscover:
    @respx.mock
    async def test_posts_query_and_returns_ranked_tools(self):
        respx.post(f"{TEST_URL}/api/v1/datasets/{DATASET}/discover").mock(
            return_value=httpx.Response(200, json={"tools": [RANKED_TOOL.model_dump()]})
        )
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        result = await client.discover(DATASET, "weather info")

        assert len(result) == 1
        assert result[0].name == "get_weather"
        assert result[0].score == 0.95

    @respx.mock
    async def test_passes_optional_params(self):
        route = respx.post(f"{TEST_URL}/api/v1/datasets/{DATASET}/discover").mock(
            return_value=httpx.Response(200, json={"tools": []})
        )
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        await client.discover(DATASET, "q", limit=5, exclude=["foo"], turn_id="t1")

        body = json.loads(route.calls[0].request.content)
        assert body["limit"] == 5
        assert body["exclude"] == ["foo"]
        assert body["turn_id"] == "t1"

    @respx.mock
    async def test_omits_optional_params_when_none(self):
        route = respx.post(f"{TEST_URL}/api/v1/datasets/{DATASET}/discover").mock(
            return_value=httpx.Response(200, json={"tools": []})
        )
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        await client.discover(DATASET, "q")

        body = json.loads(route.calls[0].request.content)
        assert "limit" not in body
        assert "exclude" not in body
        assert "turn_id" not in body


class TestPrefetch:
    @respx.mock
    async def test_emits_events_and_returns_tools(self):
        respx.post(f"{TEST_URL}/api/v1/datasets/{DATASET}/discover").mock(
            return_value=httpx.Response(200, json={"tools": [RANKED_TOOL.model_dump()]})
        )
        events: list[AgentifiedEvent] = []
        client = ApiClient(
            ApiClientConfig(server_url=TEST_URL, tools=[], on_event=events.append)
        )
        from agentified.models import Message, PrefetchOptions

        result = await client.prefetch(
            DATASET, PrefetchOptions(messages=[Message(role="user", content="weather")])
        )

        assert len(result) == 1
        assert len(events) == 2
        assert events[0].type == "agentified:prefetch:start"
        assert events[1].type == "agentified:prefetch:complete"
        assert events[1].duration_ms >= 0


class TestCaptureTurn:
    @respx.mock
    async def test_posts_turn_data(self):
        route = respx.post(f"{TEST_URL}/api/v1/turns").mock(
            return_value=httpx.Response(201, json={"turn_id": "t-abc"})
        )
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        result = await client.capture_turn("ns1", "sess1", tools_loaded=["get_weather"], message="hi")

        assert result.turn_id == "t-abc"
        body = json.loads(route.calls[0].request.content)
        assert body["namespace_id"] == "ns1"
        assert body["session_id"] == "sess1"


class TestAppendMessages:
    @respx.mock
    async def test_appends_and_returns_seq_info(self):
        route = respx.post(f"{TEST_URL}/api/v1/messages").mock(
            return_value=httpx.Response(200, json={"appended": 2, "first_seq": 1, "last_seq": 2})
        )
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        result = await client.append_messages(
            DATASET, "ns1", "sess1", [{"role": "user", "content": "hi"}]
        )

        assert result.appended == 2
        assert result.first_seq == 1
        assert result.last_seq == 2
        body = json.loads(route.calls[0].request.content)
        assert body["dataset"] == DATASET


class TestGetMessages:
    @respx.mock
    async def test_fetches_messages_with_params(self):
        respx.get(url__startswith=f"{TEST_URL}/api/v1/messages").mock(
            return_value=httpx.Response(200, json={
                "messages": [STORED_MSG],
                "has_more": False,
                "max_seq": 1,
            })
        )
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        result = await client.get_messages(DATASET, "ns1", "sess1", limit=10)

        assert len(result.messages) == 1
        assert result.messages[0].id == "msg-1"
        assert result.messages[0].seq == 1
        assert result.has_more is False


class TestGetContext:
    @respx.mock
    async def test_posts_context_request_and_returns_response(self):
        respx.post(f"{TEST_URL}/api/v1/context").mock(
            return_value=httpx.Response(200, json={
                "messages": [STORED_MSG],
                "strategy_used": "recent",
                "total_messages": 1,
                "included_messages": 1,
                "recalled": {"tools": [], "memories": []},
                "token_estimate": 10,
                "conversation_messages": 1,
                "fallback": False,
            })
        )
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        result = await client.get_context(DATASET, "ns1", "sess1", strategy="recent")

        assert len(result.messages) == 1
        assert result.strategy_used == "recent"
        assert result.total_messages == 1
        assert result.fallback is False


class TestAsDiscoverTool:
    @respx.mock
    async def test_returns_definition_and_executes(self):
        respx.post(f"{TEST_URL}/api/v1/datasets/{DATASET}/discover").mock(
            return_value=httpx.Response(200, json={"tools": [RANKED_TOOL.model_dump()]})
        )
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        dt = client.as_discover_tool(DATASET)

        assert dt.definition.name == "agentified_discover"
        from agentified.models import DiscoverToolInput

        result = await dt.execute(DiscoverToolInput(query="weather"))
        assert len(result) == 1

    @respx.mock
    async def test_emits_discover_events(self):
        respx.post(f"{TEST_URL}/api/v1/datasets/{DATASET}/discover").mock(
            return_value=httpx.Response(200, json={"tools": []})
        )
        events: list[AgentifiedEvent] = []
        client = ApiClient(
            ApiClientConfig(server_url=TEST_URL, tools=[], on_event=events.append)
        )
        from agentified.models import DiscoverToolInput

        await client.as_discover_tool(DATASET).execute(DiscoverToolInput(query="test"))
        assert len(events) == 2
        assert events[0].type == "agentified:discover:start"
        assert events[1].type == "agentified:discover:complete"


    @respx.mock
    async def test_populates_discovered_names(self):
        respx.post(f"{TEST_URL}/api/v1/datasets/{DATASET}/discover").mock(
            return_value=httpx.Response(200, json={"tools": [RANKED_TOOL.model_dump()]})
        )
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        dt = client.as_discover_tool(DATASET)
        assert len(dt.discovered_names) == 0

        await dt.execute({"query": "weather"})
        assert "get_weather" in dt.discovered_names

    @respx.mock
    async def test_discovered_names_accumulate(self):
        tool2 = RankedTool(name="search", description="Search", parameters={}, score=0.8)
        call_count = 0

        def mock_response(request):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return httpx.Response(200, json={"tools": [RANKED_TOOL.model_dump()]})
            return httpx.Response(200, json={"tools": [tool2.model_dump()]})

        respx.post(f"{TEST_URL}/api/v1/datasets/{DATASET}/discover").mock(side_effect=mock_response)
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        dt = client.as_discover_tool(DATASET)

        await dt.execute({"query": "weather"})
        await dt.execute({"query": "search"})
        assert dt.discovered_names == {"get_weather", "search"}


class TestCustomHeaders:
    @respx.mock
    async def test_config_headers_sent_on_post_requests(self):
        route = respx.post(f"{TEST_URL}/api/v1/datasets/{DATASET}/tools").mock(
            return_value=httpx.Response(200, json={"registered": 1})
        )
        client = ApiClient(
            ApiClientConfig(
                server_url=TEST_URL,
                tools=[TEST_TOOL],
                headers={"Authorization": "Bearer tok-123"},
            )
        )
        await client.register(DATASET)

        assert route.called
        req = route.calls[0].request
        assert req.headers["authorization"] == "Bearer tok-123"

    @respx.mock
    async def test_config_headers_sent_on_get_requests(self):
        route = respx.get(url__startswith=f"{TEST_URL}/api/v1/messages").mock(
            return_value=httpx.Response(200, json={
                "messages": [],
                "has_more": False,
                "max_seq": 0,
            })
        )
        client = ApiClient(
            ApiClientConfig(
                server_url=TEST_URL,
                tools=[],
                headers={"Authorization": "Bearer tok-123"},
            )
        )
        await client.get_messages(DATASET, "ns", "sess")

        assert route.called
        req = route.calls[0].request
        assert req.headers["authorization"] == "Bearer tok-123"

    @respx.mock
    async def test_works_without_headers(self):
        route = respx.post(f"{TEST_URL}/api/v1/datasets/{DATASET}/tools").mock(
            return_value=httpx.Response(200, json={"registered": 1})
        )
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[TEST_TOOL]))
        await client.register(DATASET)
        assert route.called


class TestFrontendTools:
    def test_filters_frontend_tools(self):
        ft = ServerTool(name="confirm", description="c", parameters={}, metadata={"location": "frontend"})
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[ft, TEST_TOOL]))
        assert client.get_frontend_tools() == [ft]
        assert client.get_frontend_tool_names() == ["confirm"]
