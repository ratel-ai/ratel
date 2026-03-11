from __future__ import annotations

from typing import TYPE_CHECKING

from .models import AssembledContext, ContextStrategy

if TYPE_CHECKING:
    from .api_client import ApiClient


class ContextBuilder:
    def __init__(
        self,
        sdk: ApiClient,
        dataset_id: str,
        namespace_id: str,
        session_id: str,
    ) -> None:
        self._sdk = sdk
        self._dataset_id = dataset_id
        self._namespace_id = namespace_id
        self._session_id = session_id
        self._strategy: ContextStrategy | None = None
        self._max_tokens: int | None = None

    def messages(
        self,
        strategy: ContextStrategy | None = None,
        max_tokens: int | None = None,
    ) -> ContextBuilder:
        self._strategy = strategy
        self._max_tokens = max_tokens
        return self

    def recall(self, **_kwargs: object) -> ContextBuilder:
        return self

    async def assemble(self) -> AssembledContext:
        res = await self._sdk.get_context(
            self._dataset_id, self._namespace_id, self._session_id,
            strategy=self._strategy, max_tokens=self._max_tokens,
        )
        return AssembledContext(
            messages=res.messages,
            recalled=res.recalled,
            strategy_used=res.strategy_used,
            fallback=res.fallback,
            token_estimate=res.token_estimate,
            conversation_messages=res.conversation_messages,
            total_messages=res.total_messages,
            included_messages=res.included_messages,
        )
