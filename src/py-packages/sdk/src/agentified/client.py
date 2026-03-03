from __future__ import annotations

import time
from typing import Any

import httpx

from .models import (
    AgentifiedConfig,
    AgentifiedEvent,
    CaptureTurnResponse,
    DiscoverResponse,
    DiscoverStartEvent,
    DiscoverCompleteEvent,
    DiscoverTool,
    DiscoverToolInput,
    PrefetchCompleteEvent,
    PrefetchStartEvent,
    RankedTool,
    RegisterResponse,
    Message,
    ServerTool,
    ToolDefinition,
)


class Agentified:
    def __init__(self, config: AgentifiedConfig) -> None:
        self._config = config
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> Agentified:
        self._client = httpx.AsyncClient()
        return self

    async def __aexit__(self, *_: Any) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def register(self) -> RegisterResponse:
        data = {"tools": [t.model_dump(exclude_none=True) for t in self._config.tools]}
        resp = await self._http_client.post(
            f"{self._config.server_url}/api/v1/tools", json=data
        )
        return RegisterResponse.model_validate(resp.json())

    async def prefetch(
        self,
        *,
        messages: list[dict[str, str]],
        limit: int | None = None,
        exclude: list[str] | None = None,
        turn_id: str | None = None,
    ) -> list[RankedTool]:
        msg_models = [Message(**m) for m in messages]
        self._emit(PrefetchStartEvent(messages=msg_models))
        start = time.perf_counter()

        query = "\n".join(m["content"] for m in messages)
        tools = await self._discover(query, limit, exclude, turn_id)

        duration_ms = (time.perf_counter() - start) * 1000
        self._emit(PrefetchCompleteEvent(tools=tools, duration_ms=duration_ms))
        return tools

    async def capture_turn(
        self, *, tools_loaded: list[str], message: str
    ) -> CaptureTurnResponse:
        resp = await self._http_client.post(
            f"{self._config.server_url}/api/v1/turns",
            json={"tools_loaded": tools_loaded, "message": message},
        )
        return CaptureTurnResponse.model_validate(resp.json())

    def get_frontend_tools(self) -> list[ServerTool]:
        return [
            t
            for t in self._config.tools
            if t.metadata and t.metadata.get("location") == "frontend"
        ]

    def get_frontend_tool_names(self) -> list[str]:
        return [t.name for t in self.get_frontend_tools()]

    def as_discover_tool(self) -> DiscoverTool:
        async def execute(input: dict[str, Any] | DiscoverToolInput) -> list[RankedTool]:
            if isinstance(input, dict):
                input = DiscoverToolInput(**input)
            self._emit(DiscoverStartEvent(query=input.query))
            start = time.perf_counter()

            tools = await self._discover(input.query, input.limit)

            duration_ms = (time.perf_counter() - start) * 1000
            self._emit(
                DiscoverCompleteEvent(
                    query=input.query, tools=tools, duration_ms=duration_ms
                )
            )
            return tools

        return DiscoverTool(
            definition=ToolDefinition(
                name="agentified_discover",
                description="Find tools relevant to the current task. Call this when you need capabilities you don't have.",
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Natural language description of what you need to do",
                        },
                        "limit": {
                            "type": "number",
                            "description": "Max number of tools to return",
                        },
                    },
                    "required": ["query"],
                },
            ),
            execute=execute,
        )

    # -- private --

    @property
    def _http_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient()
        return self._client

    async def _discover(
        self,
        query: str,
        limit: int | None = None,
        exclude: list[str] | None = None,
        turn_id: str | None = None,
    ) -> list[RankedTool]:
        body: dict[str, Any] = {"query": query}
        if limit is not None:
            body["limit"] = limit
        if exclude is not None:
            body["exclude"] = exclude
        if turn_id is not None:
            body["turn_id"] = turn_id

        resp = await self._http_client.post(
            f"{self._config.server_url}/api/v1/discover", json=body
        )
        data = DiscoverResponse.model_validate(resp.json())
        return data.tools

    def _emit(self, event: AgentifiedEvent) -> None:
        if self._config.on_event:
            self._config.on_event(event)
