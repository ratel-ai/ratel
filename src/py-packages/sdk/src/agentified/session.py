from __future__ import annotations

from typing import Any, TYPE_CHECKING

from .context_builder import ContextBuilder
from .conversation import Conversation
from .models import (
    AgentifiedTool,
    DiscoverTool,
    GetMessagesOptions,
    GetMessagesResult,
    GetMessagesTool,
)

if TYPE_CHECKING:
    from .api_client import ApiClient


class Session:
    def __init__(
        self,
        id: str,
        namespace_id: str,
        sdk: ApiClient,
        dataset_id: str,
        registered_tools: list[AgentifiedTool],
    ) -> None:
        self.id = id
        self.namespace_id = namespace_id
        self._sdk = sdk
        self._dataset_id = dataset_id
        self._registered_tools = registered_tools
        self.conversation = Conversation(sdk, dataset_id, namespace_id, id)
        self._discover_tool = sdk.as_discover_tool(dataset_id, namespace_id, id)
        self._get_messages_tool: GetMessagesTool | None = None

    @property
    def context(self) -> ContextBuilder:
        return ContextBuilder(
            self._sdk, self._dataset_id, self.namespace_id, self.id,
            registered_tools=self._registered_tools,
            discovered_names=self._discover_tool.discovered_names,
        )

    @property
    def discover_tool(self) -> DiscoverTool:
        return self._discover_tool

    @property
    def get_messages_tool(self) -> GetMessagesTool:
        if self._get_messages_tool is None:
            self._get_messages_tool = self._sdk.as_get_messages_tool(
                self._dataset_id, self.namespace_id, self.id,
            )
        return self._get_messages_tool

    async def get_messages(self, opts: GetMessagesOptions | None = None) -> GetMessagesResult:
        strategy = opts.strategy if opts else None
        max_tokens = opts.max_tokens if opts else None
        max_messages = opts.max_messages if opts else None

        res = await self._sdk.get_context(
            self._dataset_id, self.namespace_id, self.id,
            strategy=strategy, max_tokens=max_tokens,
        )
        messages = res.messages
        included = res.included_messages
        if max_messages and len(messages) > max_messages:
            messages = messages[len(messages) - max_messages:]
            included = len(messages)

        return GetMessagesResult(
            messages=messages,
            total_messages=res.total_messages,
            included_messages=included,
            strategy_used=res.strategy_used,
            fallback=res.fallback,
        )

    async def update_conversation(self, messages: list[dict[str, str]]) -> None:
        if not messages:
            return

        stored = await self._sdk.get_messages(
            self._dataset_id, self.namespace_id, self.id, limit=len(messages)
        )
        tail = stored.messages

        overlap = 0
        for try_len in range(min(len(tail), len(messages)), 0, -1):
            tail_start = len(tail) - try_len
            match = True
            for i in range(try_len):
                if tail[tail_start + i].role != messages[i]["role"] or tail[tail_start + i].content != messages[i]["content"]:
                    match = False
                    break
            if match:
                overlap = try_len
                break

        new_messages = messages[overlap:]
        if not new_messages:
            return

        await self._sdk.append_messages(self._dataset_id, self.namespace_id, self.id, new_messages)
