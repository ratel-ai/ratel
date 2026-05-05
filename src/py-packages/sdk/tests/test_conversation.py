import httpx
import respx

from agentified.api_client import ApiClient
from agentified.conversation import Conversation
from agentified.models import ApiClientConfig

TEST_URL = "http://localhost:9119"
DATASET = "ds1"

STORED_MSG = {
    "id": "m1", "role": "user", "content": "hi",
    "tool_call_id": None, "tool_calls": None,
    "created_at": "2026-01-01T00:00:00Z", "seq": 1,
}


class TestConversation:
    @respx.mock
    async def test_append_delegates_to_sdk(self):
        route = respx.post(f"{TEST_URL}/api/v1/messages").mock(
            return_value=httpx.Response(200, json={"appended": 1, "first_seq": 1, "last_seq": 1})
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        conv = Conversation(sdk, DATASET, "ns", "sess")
        result = await conv.append([{"role": "user", "content": "hi"}])

        assert result.appended == 1
        assert route.called

    @respx.mock
    async def test_messages_returns_stored_messages(self):
        respx.get(url__startswith=f"{TEST_URL}/api/v1/messages").mock(
            return_value=httpx.Response(200, json={"messages": [STORED_MSG], "has_more": False, "max_seq": 1})
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        conv = Conversation(sdk, DATASET, "ns", "sess")
        msgs = await conv.messages()

        assert len(msgs) == 1
        assert msgs[0].content == "hi"
