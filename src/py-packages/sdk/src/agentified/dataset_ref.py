from __future__ import annotations

from typing import TYPE_CHECKING

from .api_client import ApiClient
from .instance import Instance
from .models import (
    AgentifiedTool,
    ApiClientConfig,
    BackendTool,
    ClientTool,
    McpTool,
    RegisterInput,
    ServerTool,
)

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

        server_tools = []
        for t in input.tools:
            st = ServerTool(name=t.name, description=t.description, parameters=t.parameters)
            if isinstance(t, McpTool):
                st = ServerTool(
                    name=t.name, description=t.description, parameters=t.parameters,
                    type="mcp", server_uri=t.server,
                )
            elif isinstance(t, BackendTool) and t.always_include:
                st = ServerTool(
                    name=t.name, description=t.description, parameters=t.parameters,
                    always_include=True,
                )
            server_tools.append(st)

        reg_sdk = ApiClient(
            ApiClientConfig(server_url=self._agentified._server_url, tools=server_tools)
        )
        await reg_sdk.register(self.dataset_name)

        return Instance(
            self.dataset_name, self.dataset_name, sdk, input.tools,
            emitter=self._agentified.emitter,
        )


def _validate_tools(tools: list[AgentifiedTool]) -> None:
    for tool in tools:
        if isinstance(tool, ClientTool):
            raise ValueError("Client tools are not yet supported")
        if isinstance(tool, (BackendTool, McpTool)):
            if not callable(tool.handler):
                raise ValueError(f"Tool '{tool.name}' requires a handler")
