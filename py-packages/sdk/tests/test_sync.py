import httpx
import respx

from agentified._sync import SyncAgentified
from agentified.models import AgentifiedConfig, RankedTool, ServerTool

TEST_URL = "http://localhost:9119"

TEST_TOOL = ServerTool(
    name="get_weather",
    description="Get weather for a city",
    parameters={"type": "object", "properties": {"city": {"type": "string"}}},
)

RANKED_TOOL = RankedTool(**TEST_TOOL.model_dump(), score=0.95)


class TestSyncAgentified:
    @respx.mock
    def test_register_sync(self):
        respx.post(f"{TEST_URL}/api/v1/tools").mock(
            return_value=httpx.Response(200, json={"registered": 1})
        )

        client = SyncAgentified(
            AgentifiedConfig(server_url=TEST_URL, tools=[TEST_TOOL])
        )
        result = client.register()
        assert result.registered == 1

    @respx.mock
    def test_prefetch_sync(self):
        respx.post(f"{TEST_URL}/api/v1/discover").mock(
            return_value=httpx.Response(
                200, json={"tools": [RANKED_TOOL.model_dump()]}
            )
        )

        client = SyncAgentified(
            AgentifiedConfig(server_url=TEST_URL, tools=[TEST_TOOL])
        )
        result = client.prefetch(
            messages=[{"role": "user", "content": "weather"}]
        )
        assert len(result) == 1
        assert result[0].score == 0.95

    @respx.mock
    def test_capture_turn_sync(self):
        respx.post(f"{TEST_URL}/api/v1/turns").mock(
            return_value=httpx.Response(201, json={"turn_id": "abc-123"})
        )

        client = SyncAgentified(
            AgentifiedConfig(server_url=TEST_URL, tools=[TEST_TOOL])
        )
        result = client.capture_turn(
            tools_loaded=["get_weather"], message="What is the weather?"
        )
        assert result.turn_id == "abc-123"

    def test_get_frontend_tools_sync(self):
        frontend_tool = ServerTool(
            name="confirm",
            description="Confirm",
            parameters={},
            metadata={"location": "frontend"},
        )
        client = SyncAgentified(
            AgentifiedConfig(server_url=TEST_URL, tools=[frontend_tool, TEST_TOOL])
        )
        assert client.get_frontend_tool_names() == ["confirm"]
