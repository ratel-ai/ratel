import json
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import respx

from quickhr.agent import create_hr_agent


AGENTIFIED_URL = "http://test-agentified:9119"


class TestCreateHrAgent:
    @respx.mock
    async def test_register_sends_all_tools(self):
        register_route = respx.post(f"{AGENTIFIED_URL}/api/v1/tools").mock(
            return_value=httpx.Response(200, json={"registered": 142})
        )

        agent = await create_hr_agent(AGENTIFIED_URL, google_api_key="test-key")

        assert register_route.called
        body = json.loads(register_route.calls[0].request.content)
        assert len(body["tools"]) == 142

    @respx.mock
    async def test_run_turn_prefetches_and_invokes(self):
        respx.post(f"{AGENTIFIED_URL}/api/v1/tools").mock(
            return_value=httpx.Response(200, json={"registered": 142})
        )
        respx.post(f"{AGENTIFIED_URL}/api/v1/discover").mock(
            return_value=httpx.Response(200, json={"tools": [
                {"name": "list_employees", "description": "List all employees", "parameters": {}, "score": 0.95},
                {"name": "search_employees", "description": "Search employees", "parameters": {}, "score": 0.9},
            ]})
        )

        agent = await create_hr_agent(AGENTIFIED_URL, google_api_key="test-key")

        fake_result = {"messages": [
            {"role": "user", "content": "Show me all employees"},
            {"role": "assistant", "content": "Here are the employees..."},
        ]}

        with patch("quickhr.agent.create_react_agent") as mock_create:
            mock_graph = AsyncMock()
            mock_graph.ainvoke.return_value = fake_result
            mock_create.return_value = mock_graph

            messages = [{"role": "user", "content": "Show me all employees"}]
            result = await agent.run_turn(messages)

            mock_create.assert_called_once()
            call_args = mock_create.call_args
            # second arg is tools list — should only contain prefetched tools
            tools = call_args[0][1]
            tool_names = [t.name for t in tools]
            assert "list_employees" in tool_names
            assert "search_employees" in tool_names
            assert len(tools) == 2

            assert result == fake_result

    @respx.mock
    async def test_run_turn_skips_unknown_tools(self):
        respx.post(f"{AGENTIFIED_URL}/api/v1/tools").mock(
            return_value=httpx.Response(200, json={"registered": 142})
        )
        respx.post(f"{AGENTIFIED_URL}/api/v1/discover").mock(
            return_value=httpx.Response(200, json={"tools": [
                {"name": "nonexistent_tool", "description": "X", "parameters": {}, "score": 0.9},
                {"name": "list_employees", "description": "List", "parameters": {}, "score": 0.8},
            ]})
        )

        agent = await create_hr_agent(AGENTIFIED_URL, google_api_key="test-key")

        with patch("quickhr.agent.create_react_agent") as mock_create:
            mock_graph = AsyncMock()
            mock_graph.ainvoke.return_value = {"messages": []}
            mock_create.return_value = mock_graph

            await agent.run_turn([{"role": "user", "content": "hi"}])

            tools = mock_create.call_args[0][1]
            assert len(tools) == 1
            assert tools[0].name == "list_employees"
