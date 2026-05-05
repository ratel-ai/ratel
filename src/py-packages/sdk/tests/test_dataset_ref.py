import httpx
import pytest
import respx

from agentified.client import Agentified
from agentified.dataset_ref import DatasetRef
from agentified.models import BackendTool, ClientTool, RegisterInput

TEST_URL = "http://localhost:9119"


class TestDatasetRef:
    @respx.mock
    async def test_register_creates_instance(self):
        respx.get(f"{TEST_URL}/health").mock(return_value=httpx.Response(200))
        respx.post(f"{TEST_URL}/api/v1/datasets/myds/tools").mock(
            return_value=httpx.Response(200, json={"registered": 1})
        )

        ag = Agentified()
        await ag.connect(TEST_URL)

        ref = ag.dataset("myds")
        instance = await ref.register(RegisterInput(tools=[
            BackendTool(
                name="get_weather",
                description="Weather",
                parameters={},
                handler=lambda args: {"temp": 22},
            ),
        ]))

        assert instance.instance_id == "myds"
        assert instance.dataset_id == "myds"
        await ag.disconnect()

    async def test_register_rejects_client_tools(self):
        ag = Agentified()
        ag._sdk = object()  # fake non-None
        ag._server_url = TEST_URL
        ag._connected = True

        ref = ag.dataset("ds")
        with pytest.raises(ValueError, match="Client tools are not yet supported"):
            await ref.register(RegisterInput(tools=[
                ClientTool(name="t", description="d", parameters={}),
            ]))
