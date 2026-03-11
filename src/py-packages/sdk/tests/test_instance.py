from agentified.api_client import ApiClient
from agentified.instance import Instance
from agentified.models import ApiClientConfig

TEST_URL = "http://localhost:9119"


class TestInstance:
    def test_session_creates_session_with_default_namespace(self):
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        inst = Instance("inst1", "ds1", sdk, ["get_weather"])
        session = inst.session("s1")

        assert session.id == "s1"
        assert session.namespace_id == "default"

    def test_namespace_creates_namespace(self):
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        inst = Instance("inst1", "ds1", sdk, ["get_weather"])
        ns = inst.namespace("custom")

        assert ns.id == "custom"

    def test_discover_tool_available(self):
        sdk = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        inst = Instance("inst1", "ds1", sdk, ["get_weather"])

        assert inst.discover_tool.definition.name == "agentified_discover"
