from __future__ import annotations

import time
from typing import Any

import httpx

from .models import (
    AgentifiedEvent,
    ApiClientConfig,
    AppendMessagesResponse,
    CaptureTurnResponse,
    ContextResponse,
    ContextStrategy,
    DiscoverResponse,
    DiscoverStartEvent,
    DiscoverCompleteEvent,
    DiscoverTool,
    DiscoverToolInput,
    GetMessagesResponse,
    Message,
    PrefetchCompleteEvent,
    PrefetchOptions,
    PrefetchStartEvent,
    RankedTool,
    RegisterResponse,
    ServerTool,
    StoredMessage,
    ToolDefinition,
)


class ApiClient:
    def __init__(self, config: ApiClientConfig) -> None:
        self._config = config
        self._client: httpx.AsyncClient | None = None

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def register(self, dataset_id: str) -> RegisterResponse:
        data = {"tools": [t.model_dump(exclude_none=True) for t in self._config.tools]}
        resp = await self._http.post(
            f"{self._config.server_url}/api/v1/datasets/{dataset_id}/tools", json=data
        )
        resp.raise_for_status()
        return RegisterResponse.model_validate(resp.json())

    async def discover(
        self,
        dataset_id: str,
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

        resp = await self._http.post(
            f"{self._config.server_url}/api/v1/datasets/{dataset_id}/discover", json=body
        )
        resp.raise_for_status()
        data = DiscoverResponse.model_validate(resp.json())
        return data.tools

    async def prefetch(self, dataset_id: str, options: PrefetchOptions) -> list[RankedTool]:
        self._emit(PrefetchStartEvent(messages=options.messages))
        start = time.perf_counter()

        query = "\n".join(m.content for m in options.messages)
        tools = await self.discover(dataset_id, query, options.limit, options.exclude, options.turn_id)

        duration_ms = (time.perf_counter() - start) * 1000
        self._emit(PrefetchCompleteEvent(tools=tools, duration_ms=duration_ms))
        return tools

    async def capture_turn(
        self,
        namespace: str,
        session: str,
        *,
        tools_loaded: list[str],
        message: str,
    ) -> CaptureTurnResponse:
        resp = await self._http.post(
            f"{self._config.server_url}/api/v1/turns",
            json={
                "namespace_id": namespace,
                "session_id": session,
                "tools_loaded": tools_loaded,
                "message": message,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return CaptureTurnResponse(turn_id=data["turn_id"])

    async def append_messages(
        self,
        dataset: str,
        namespace: str,
        session: str,
        messages: list[dict[str, Any]],
    ) -> AppendMessagesResponse:
        resp = await self._http.post(
            f"{self._config.server_url}/api/v1/messages",
            json={"dataset": dataset, "namespace": namespace, "session": session, "messages": messages},
        )
        resp.raise_for_status()
        data = resp.json()
        return AppendMessagesResponse(
            appended=data["appended"],
            first_seq=data["first_seq"],
            last_seq=data["last_seq"],
        )

    async def get_messages(
        self,
        dataset: str,
        namespace: str,
        session: str,
        limit: int | None = None,
        after_seq: int | None = None,
        around_seq: int | None = None,
    ) -> GetMessagesResponse:
        params: dict[str, str] = {"dataset": dataset, "namespace": namespace, "session": session}
        if limit is not None:
            params["limit"] = str(limit)
        if after_seq is not None:
            params["after_seq"] = str(after_seq)
        if around_seq is not None:
            params["around_seq"] = str(around_seq)

        resp = await self._http.get(f"{self._config.server_url}/api/v1/messages", params=params)
        resp.raise_for_status()
        data = resp.json()
        messages = [
            StoredMessage(
                id=m["id"],
                role=m["role"],
                content=m["content"],
                tool_call_id=m.get("tool_call_id"),
                tool_calls=m.get("tool_calls"),
                created_at=m["created_at"],
                seq=m["seq"],
            )
            for m in data["messages"]
        ]
        return GetMessagesResponse(messages=messages, has_more=data["has_more"], max_seq=data["max_seq"])

    async def get_context(
        self,
        dataset: str,
        namespace: str,
        session: str,
        strategy: ContextStrategy | None = None,
        max_tokens: int | None = None,
        prune_threshold: int | None = None,
    ) -> ContextResponse:
        messages_config: dict[str, Any] = {}
        if strategy is not None:
            messages_config["strategy"] = strategy
        if max_tokens is not None:
            messages_config["max_tokens"] = max_tokens
        if prune_threshold is not None:
            messages_config["prune_threshold"] = prune_threshold

        resp = await self._http.post(
            f"{self._config.server_url}/api/v1/context",
            json={"dataset": dataset, "namespace": namespace, "session": session, "messages": messages_config},
        )
        resp.raise_for_status()
        data = resp.json()
        messages = [
            StoredMessage(
                id=m["id"],
                role=m["role"],
                content=m["content"],
                tool_call_id=m.get("tool_call_id"),
                tool_calls=m.get("tool_calls"),
                created_at=m["created_at"],
                seq=m["seq"],
            )
            for m in data["messages"]
        ]
        return ContextResponse(
            messages=messages,
            strategy_used=data["strategy_used"],
            total_messages=data["total_messages"],
            included_messages=data["included_messages"],
            recalled=data["recalled"],
            token_estimate=data["token_estimate"],
            conversation_messages=data["conversation_messages"],
            fallback=data["fallback"],
        )

    def get_frontend_tools(self) -> list[ServerTool]:
        return [t for t in self._config.tools if t.metadata and t.metadata.get("location") == "frontend"]

    def get_frontend_tool_names(self) -> list[str]:
        return [t.name for t in self.get_frontend_tools()]

    def as_discover_tool(self, dataset_id: str) -> DiscoverTool:
        discovered_names: set[str] = set()

        async def execute(inp: dict[str, Any] | DiscoverToolInput) -> list[RankedTool]:
            if isinstance(inp, dict):
                inp = DiscoverToolInput(**inp)
            self._emit(DiscoverStartEvent(query=inp.query))
            start = time.perf_counter()
            tools = await self.discover(dataset_id, inp.query, inp.limit)
            duration_ms = (time.perf_counter() - start) * 1000
            self._emit(DiscoverCompleteEvent(query=inp.query, tools=tools, duration_ms=duration_ms))
            for t in tools:
                discovered_names.add(t.name)
            return tools

        return DiscoverTool(
            definition=ToolDefinition(
                name="agentified_discover",
                description="Find tools relevant to the current task. Call this when you need capabilities you don't have.",
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Natural language description of what you need to do"},
                        "limit": {"type": "number", "description": "Max number of tools to return"},
                    },
                    "required": ["query"],
                },
            ),
            execute=execute,
            discovered_names=discovered_names,
        )

    # -- private --

    @property
    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(headers=self._config.headers or {})
        return self._client

    def _emit(self, event: AgentifiedEvent) -> None:
        if self._config.on_event:
            self._config.on_event(event)
