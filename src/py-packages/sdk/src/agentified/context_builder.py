from __future__ import annotations

from typing import Any, TYPE_CHECKING

from .models import AssembledContext, BackendTool, ContextStrategy

if TYPE_CHECKING:
    from .api_client import ApiClient


class ContextBuilder:
    def __init__(
        self,
        sdk: ApiClient,
        dataset_id: str,
        namespace_id: str,
        session_id: str,
        registered_tools: list[BackendTool] | None = None,
        discovered_names: set[str] | None = None,
    ) -> None:
        self._sdk = sdk
        self._dataset_id = dataset_id
        self._namespace_id = namespace_id
        self._session_id = session_id
        self._registered_tools = registered_tools or []
        self._discovered_names = discovered_names or set()
        self._strategy: ContextStrategy | None = None
        self._max_tokens: int | None = None
        self._explicit_tools: dict[str, Any] = {}

    def messages(
        self,
        strategy: ContextStrategy | None = None,
        max_tokens: int | None = None,
    ) -> ContextBuilder:
        self._strategy = strategy
        self._max_tokens = max_tokens
        return self

    def tools(self, tools: dict[str, Any]) -> ContextBuilder:
        self._explicit_tools.update(tools)
        return self

    def recall(self, **_kwargs: object) -> ContextBuilder:
        return self

    async def assemble(self) -> AssembledContext:
        res = await self._sdk.get_context(
            self._dataset_id, self._namespace_id, self._session_id,
            strategy=self._strategy, max_tokens=self._max_tokens,
        )

        resolved: dict[str, Any] = {**self._explicit_tools}
        for tool in self._registered_tools:
            if tool.name in self._discovered_names and tool.name not in resolved:
                resolved[tool.name] = tool

        return AssembledContext(
            messages=res.messages,
            recalled=res.recalled,
            strategy_used=res.strategy_used,
            fallback=res.fallback,
            token_estimate=res.token_estimate,
            conversation_messages=res.conversation_messages,
            total_messages=res.total_messages,
            included_messages=res.included_messages,
            tools=resolved,
        )
