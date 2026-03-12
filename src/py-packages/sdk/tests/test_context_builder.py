import httpx
import respx

from agentified.api_client import ApiClient
from agentified.context_builder import ContextBuilder
from agentified.models import ApiClientConfig, BackendTool

TEST_URL = "http://localhost:9119"

CONTEXT_RESPONSE = {
    "messages": [{
        "id": "m1", "role": "user", "content": "hi",
        "tool_call_id": None, "tool_calls": None,
        "created_at": "2026-01-01T00:00:00Z", "seq": 1,
    }],
    "strategy_used": "recent",
    "total_messages": 1,
    "included_messages": 1,
    "recalled": {"tools": [], "memories": []},
    "token_estimate": 5,
    "conversation_messages": 1,
    "fallback": False,
}

TOOLS = [
    BackendTool(name="get_weather", description="Weather", parameters={}, handler=lambda a: a),
    BackendTool(name="search_docs", description="Search", parameters={}, handler=lambda a: a),
]


class TestContextBuilder:
    @respx.mock
    async def test_fluent_messages_and_assemble(self):
        respx.post(f"{TEST_URL}/api/v1/context").mock(
            return_value=httpx.Response(200, json=CONTEXT_RESPONSE)
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        ctx = ContextBuilder(sdk, "ds", "ns", "sess")
        result = await ctx.messages(strategy="recent").assemble()

        assert result.strategy_used == "recent"
        assert len(result.messages) == 1
        assert result.total_messages == 1
        assert result.fallback is False

    @respx.mock
    async def test_recall_is_noop_chainable(self):
        respx.post(f"{TEST_URL}/api/v1/context").mock(
            return_value=httpx.Response(200, json=CONTEXT_RESPONSE)
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        ctx = ContextBuilder(sdk, "ds", "ns", "sess")
        result = await ctx.messages(strategy="recent").recall().assemble()

        assert result.strategy_used == "recent"

    @respx.mock
    async def test_assemble_returns_empty_tools_by_default(self):
        respx.post(f"{TEST_URL}/api/v1/context").mock(
            return_value=httpx.Response(200, json=CONTEXT_RESPONSE)
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        ctx = ContextBuilder(sdk, "ds", "ns", "sess")
        result = await ctx.assemble()

        assert result.tools == {}

    @respx.mock
    async def test_tools_resolves_discovered(self):
        respx.post(f"{TEST_URL}/api/v1/context").mock(
            return_value=httpx.Response(200, json=CONTEXT_RESPONSE)
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        discovered = {"get_weather"}
        ctx = ContextBuilder(sdk, "ds", "ns", "sess", registered_tools=TOOLS, discovered_names=discovered)
        result = await ctx.assemble()

        assert "get_weather" in result.tools
        assert "search_docs" not in result.tools

    @respx.mock
    async def test_explicit_tools_override_discovered(self):
        respx.post(f"{TEST_URL}/api/v1/context").mock(
            return_value=httpx.Response(200, json=CONTEXT_RESPONSE)
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        discovered = {"get_weather"}
        custom = object()
        ctx = ContextBuilder(sdk, "ds", "ns", "sess", registered_tools=TOOLS, discovered_names=discovered)
        result = await ctx.tools({"get_weather": custom}).assemble()

        assert result.tools["get_weather"] is custom

    @respx.mock
    async def test_explicit_tools_merged_with_discovered(self):
        respx.post(f"{TEST_URL}/api/v1/context").mock(
            return_value=httpx.Response(200, json=CONTEXT_RESPONSE)
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        discovered = {"get_weather"}
        custom = object()
        ctx = ContextBuilder(sdk, "ds", "ns", "sess", registered_tools=TOOLS, discovered_names=discovered)
        result = await ctx.tools({"my_custom": custom}).assemble()

        assert "get_weather" in result.tools
        assert result.tools["my_custom"] is custom

    def test_tools_is_chainable(self):
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        ctx = ContextBuilder(sdk, "ds", "ns", "sess")
        ret = ctx.tools({"a": 1})
        assert ret is ctx
