import httpx
import respx

from agentified._sync import SyncAgentified
from agentified.models import BackendTool, RegisterInput

TEST_URL = "http://localhost:9119"


class TestSyncAgentified:
    @respx.mock
    def test_connect_and_disconnect(self):
        respx.get(f"{TEST_URL}/health").mock(return_value=httpx.Response(200))

        client = SyncAgentified()
        client.connect(TEST_URL)
        assert client._async._connected
        client.disconnect()
        assert not client._async._connected

    @respx.mock
    def test_register(self):
        respx.get(f"{TEST_URL}/health").mock(return_value=httpx.Response(200))
        respx.post(f"{TEST_URL}/api/v1/datasets/default/tools").mock(
            return_value=httpx.Response(200, json={"registered": 1})
        )

        client = SyncAgentified()
        client.connect(TEST_URL)
        instance = client.register(RegisterInput(tools=[
            BackendTool(name="t1", description="d", parameters={}, handler=lambda a: a),
        ]))
        assert instance.dataset_id == "default"
        client.disconnect()

    def test_dataset_returns_ref(self):
        client = SyncAgentified()
        ref = client.dataset("myds")
        assert ref.dataset_name == "myds"
