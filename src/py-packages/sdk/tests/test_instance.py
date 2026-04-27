import httpx
import respx

from agentified.api_client import ApiClient
from agentified.instance import Instance
from agentified.models import ApiClientConfig, BackendTool, Skill

TEST_URL = "http://localhost:9119"

TOOLS = [BackendTool(name="get_weather", description="Weather", parameters={}, handler=lambda a: a)]


class TestInstance:
    def test_session_creates_session_with_default_namespace(self):
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        inst = Instance("inst1", "ds1", sdk, TOOLS)
        session = inst.session("s1")

        assert session.id == "s1"
        assert session.namespace_id == "default"

    def test_namespace_creates_namespace(self):
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        inst = Instance("inst1", "ds1", sdk, TOOLS)
        ns = inst.namespace("custom")

        assert ns.id == "custom"

    def test_discover_tool_available(self):
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        inst = Instance("inst1", "ds1", sdk, TOOLS)

        assert inst.discover_tool.definition.name == "agentified_discover"

    def test_session_receives_registered_tools(self):
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        inst = Instance("inst1", "ds1", sdk, TOOLS)
        session = inst.session("s1")

        assert session._registered_tools is TOOLS

    def test_namespace_receives_registered_tools(self):
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        inst = Instance("inst1", "ds1", sdk, TOOLS)
        ns = inst.namespace("ns1")

        assert ns._registered_tools is TOOLS

    @respx.mock
    async def test_register_skills_delegates_to_api_client(self):
        respx.post(f"{TEST_URL}/api/v1/datasets/ds1/skills").mock(
            return_value=httpx.Response(201, json={"registered": 1})
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        inst = Instance("inst1", "ds1", sdk, TOOLS)
        result = await inst.register_skills(
            [Skill(name="s1", description="d", atoms=["get_weather"])]
        )
        assert result.registered == 1

    @respx.mock
    async def test_list_skills_delegates_to_api_client(self):
        respx.get(f"{TEST_URL}/api/v1/datasets/ds1/skills").mock(
            return_value=httpx.Response(
                200,
                json={"skills": [{"name": "s1", "description": "d", "atoms": ["get_weather"]}]},
            )
        )
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        inst = Instance("inst1", "ds1", sdk, TOOLS)
        skills = await inst.list_skills()
        assert len(skills) == 1
        assert skills[0].name == "s1"
