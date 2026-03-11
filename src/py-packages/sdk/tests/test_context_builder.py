import httpx
import respx

from agentified.api_client import ApiClient
from agentified.context_builder import ContextBuilder
from agentified.models import ApiClientConfig

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
