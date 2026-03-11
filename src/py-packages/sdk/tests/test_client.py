import httpx
import pytest
import respx

from agentified.client import Agentified
from agentified.models import BackendTool, RegisterInput

TEST_URL = "http://localhost:9119"


class TestConnect:
    @respx.mock
    async def test_connects_to_server(self):
        respx.get(f"{TEST_URL}/health").mock(return_value=httpx.Response(200))

        ag = Agentified()
        await ag.connect(TEST_URL)

        assert ag._connected
        assert ag._server_url == TEST_URL
        assert ag._sdk is not None
        await ag.disconnect()

    @respx.mock
    async def test_health_check_failure_raises(self):
        respx.get(f"{TEST_URL}/health").mock(return_value=httpx.Response(503))

        ag = Agentified()
        with pytest.raises(RuntimeError, match="Health check failed"):
            await ag.connect(TEST_URL)

    @respx.mock
    async def test_double_connect_raises(self):
        respx.get(f"{TEST_URL}/health").mock(return_value=httpx.Response(200))

        ag = Agentified()
        await ag.connect(TEST_URL)
        with pytest.raises(RuntimeError, match="Already connected"):
            await ag.connect(TEST_URL)
        await ag.disconnect()


class TestRegister:
    @respx.mock
    async def test_register_delegates_to_default_dataset(self):
        respx.get(f"{TEST_URL}/health").mock(return_value=httpx.Response(200))
        respx.post(f"{TEST_URL}/api/v1/datasets/default/tools").mock(
            return_value=httpx.Response(200, json={"registered": 1})
        )

        ag = Agentified()
        await ag.connect(TEST_URL)
        instance = await ag.register(RegisterInput(tools=[
            BackendTool(name="t1", description="d", parameters={}, handler=lambda a: a),
        ]))

        assert instance.dataset_id == "default"
        await ag.disconnect()


class TestDisconnect:
    @respx.mock
    async def test_disconnect_clears_state(self):
        respx.get(f"{TEST_URL}/health").mock(return_value=httpx.Response(200))

        ag = Agentified()
        await ag.connect(TEST_URL)
        await ag.disconnect()

        assert ag._sdk is None
        assert ag._server_url is None
        assert not ag._connected

    async def test_disconnect_noop_when_not_connected(self):
        ag = Agentified()
        await ag.disconnect()  # should not raise


class TestContextManager:
    @respx.mock
    async def test_async_context_manager(self):
        respx.get(f"{TEST_URL}/health").mock(return_value=httpx.Response(200))

        async with Agentified() as ag:
            await ag.connect(TEST_URL)
            assert ag._connected

        assert not ag._connected
