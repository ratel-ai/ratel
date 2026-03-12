import json

import httpx
import respx

from agentified.api_client import ApiClient
from agentified.session import Session
from agentified.models import ApiClientConfig, BackendTool, GetMessagesOptions

TEST_URL = "http://localhost:9119"
DATASET = "ds"
TOOLS = [BackendTool(name="get_weather", description="Weather", parameters={}, handler=lambda a: a)]

STORED_MSG = lambda seq, role="user", content="hi": {
    "id": f"m{seq}", "role": role, "content": content,
    "tool_call_id": None, "tool_calls": None,
    "created_at": "2026-01-01T00:00:00Z", "seq": seq,
}

CONTEXT_RESPONSE = lambda msgs: {
    "messages": msgs,
    "strategy_used": "recent",
    "total_messages": len(msgs),
    "included_messages": len(msgs),
    "recalled": {"tools": [], "memories": []},
    "token_estimate": 10,
    "conversation_messages": len(msgs),
    "fallback": False,
}


class TestSessionGetMessages:
    @respx.mock
    async def test_returns_messages_from_context(self):
        respx.post(f"{TEST_URL}/api/v1/context").mock(
            return_value=httpx.Response(200, json=CONTEXT_RESPONSE([STORED_MSG(1)]))
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        session = Session("s1", "default", sdk, DATASET, TOOLS)
        result = await session.get_messages(GetMessagesOptions(strategy="recent"))

        assert len(result.messages) == 1
        assert result.strategy_used == "recent"

    @respx.mock
    async def test_truncates_to_max_messages(self):
        msgs = [STORED_MSG(i) for i in range(1, 6)]
        respx.post(f"{TEST_URL}/api/v1/context").mock(
            return_value=httpx.Response(200, json=CONTEXT_RESPONSE(msgs))
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        session = Session("s1", "default", sdk, DATASET, [])
        result = await session.get_messages(GetMessagesOptions(max_messages=2))

        assert len(result.messages) == 2
        assert result.included_messages == 2


class TestUpdateConversation:
    @respx.mock
    async def test_appends_all_when_no_overlap(self):
        respx.get(url__startswith=f"{TEST_URL}/api/v1/messages").mock(
            return_value=httpx.Response(200, json={"messages": [], "has_more": False, "max_seq": 0})
        )
        append_route = respx.post(f"{TEST_URL}/api/v1/messages").mock(
            return_value=httpx.Response(200, json={"appended": 2, "first_seq": 1, "last_seq": 2})
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        session = Session("s1", "default", sdk, DATASET, [])
        await session.update_conversation([
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ])

        assert append_route.called
        body = json.loads(append_route.calls[0].request.content)
        assert len(body["messages"]) == 2

    @respx.mock
    async def test_deduplicates_overlapping_messages(self):
        respx.get(url__startswith=f"{TEST_URL}/api/v1/messages").mock(
            return_value=httpx.Response(200, json={
                "messages": [
                    STORED_MSG(1, "user", "hello"),
                    STORED_MSG(2, "assistant", "hi"),
                ],
                "has_more": False,
                "max_seq": 2,
            })
        )
        append_route = respx.post(f"{TEST_URL}/api/v1/messages").mock(
            return_value=httpx.Response(200, json={"appended": 1, "first_seq": 3, "last_seq": 3})
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        session = Session("s1", "default", sdk, DATASET, [])
        await session.update_conversation([
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
            {"role": "user", "content": "thanks"},
        ])

        body = json.loads(append_route.calls[0].request.content)
        assert len(body["messages"]) == 1
        assert body["messages"][0]["content"] == "thanks"

    @respx.mock
    async def test_skips_when_all_already_stored(self):
        respx.get(url__startswith=f"{TEST_URL}/api/v1/messages").mock(
            return_value=httpx.Response(200, json={
                "messages": [STORED_MSG(1, "user", "hello")],
                "has_more": False,
                "max_seq": 1,
            })
        )
        append_route = respx.post(f"{TEST_URL}/api/v1/messages").mock(
            return_value=httpx.Response(200, json={"appended": 0, "first_seq": 0, "last_seq": 0})
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        session = Session("s1", "default", sdk, DATASET, [])
        await session.update_conversation([{"role": "user", "content": "hello"}])

        assert not append_route.called

    async def test_noop_on_empty_messages(self):
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        session = Session("s1", "default", sdk, DATASET, [])
        await session.update_conversation([])  # should not raise


class TestSessionProperties:
    def test_context_returns_new_builder(self):
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        session = Session("s1", "default", sdk, DATASET, TOOLS)
        ctx1 = session.context
        ctx2 = session.context
        assert ctx1 is not ctx2

    def test_discover_tool_available(self):
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        session = Session("s1", "default", sdk, DATASET, [])
        assert session.discover_tool.definition.name == "agentified_discover"

    def test_context_receives_registered_tools(self):
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        session = Session("s1", "default", sdk, DATASET, TOOLS)
        ctx = session.context
        assert ctx._registered_tools is TOOLS

    def test_context_shares_discovered_names(self):
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        session = Session("s1", "default", sdk, DATASET, TOOLS)
        session._discover_tool.discovered_names.add("get_weather")
        ctx = session.context
        assert "get_weather" in ctx._discovered_names
