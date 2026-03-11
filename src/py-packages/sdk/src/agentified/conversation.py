from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .models import AppendMessagesResponse, GetMessagesOpts, StoredMessage

if TYPE_CHECKING:
    from .api_client import ApiClient


class Conversation:
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

    async def append(self, messages: list[dict[str, Any]]) -> AppendMessagesResponse:
        return await self._sdk.append_messages(
            self._dataset_id, self._namespace_id, self._session_id, messages
        )

    async def messages(
        self,
        limit: int | None = None,
        after_seq: int | None = None,
        around_seq: int | None = None,
    ) -> list[StoredMessage]:
        res = await self._sdk.get_messages(
            self._dataset_id, self._namespace_id, self._session_id,
            limit=limit, after_seq=after_seq, around_seq=around_seq,
        )
        return res.messages
