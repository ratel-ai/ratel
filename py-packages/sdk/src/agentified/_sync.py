from __future__ import annotations

import asyncio
from typing import Any

from .client import Agentified
from .models import (
    AgentifiedConfig,
    CaptureTurnResponse,
    DiscoverTool,
    RankedTool,
    RegisterResponse,
    ServerTool,
)


class SyncAgentified:
    def __init__(self, config: AgentifiedConfig) -> None:
        self._async = Agentified(config)

    def register(self) -> RegisterResponse:
        return asyncio.run(self._async.register())

    def prefetch(self, **kwargs: Any) -> list[RankedTool]:
        return asyncio.run(self._async.prefetch(**kwargs))

    def capture_turn(self, **kwargs: Any) -> CaptureTurnResponse:
        return asyncio.run(self._async.capture_turn(**kwargs))

    def get_frontend_tools(self) -> list[ServerTool]:
        return self._async.get_frontend_tools()

    def get_frontend_tool_names(self) -> list[str]:
        return self._async.get_frontend_tool_names()

    def as_discover_tool(self) -> DiscoverTool:
        return self._async.as_discover_tool()
