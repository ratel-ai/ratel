from __future__ import annotations

from typing import TYPE_CHECKING

from .api_client import ApiClient
from .instance import Instance
from .models import ApiClientConfig, BackendTool, RegisterInput

if TYPE_CHECKING:
    from .client import Agentified


class DatasetRef:
    def __init__(self, agentified: Agentified, dataset_name: str) -> None:
        self._agentified = agentified
        self.dataset_name = dataset_name

    async def register(self, input: RegisterInput) -> Instance:
        _validate_tools(input.tools)

        sdk = self._agentified._sdk
        if sdk is None:
            raise RuntimeError("Not connected")

        from .models import ServerTool

        server_tools = [
            ServerTool(name=t.name, description=t.description, parameters=t.parameters)
            for t in input.tools
        ]
        reg_sdk = ApiClient(
            ApiClientConfig(server_url=self._agentified._server_url, tools=server_tools)
        )
        await reg_sdk.register(self.dataset_name)

        tool_names = [t.name for t in input.tools]
        return Instance(self.dataset_name, self.dataset_name, sdk, tool_names)


def _validate_tools(tools: list[BackendTool]) -> None:
    for tool in tools:
        if tool.type and tool.type not in ("backend", None):
            raise ValueError(f"Unsupported tool type: {tool.type}")
        if not callable(tool.handler):
            raise ValueError(f"Tool '{tool.name}' requires a handler")
