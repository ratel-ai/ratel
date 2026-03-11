from __future__ import annotations

from typing import TYPE_CHECKING

from .session import Session

if TYPE_CHECKING:
    from .api_client import ApiClient


class Namespace:
    def __init__(
        self,
        id: str,
        sdk: ApiClient,
        dataset_id: str,
        tool_names: list[str],
    ) -> None:
        self.id = id
        self._sdk = sdk
        self._dataset_id = dataset_id
        self._tool_names = tool_names

    def session(self, id: str) -> Session:
        return Session(id, self.id, self._sdk, self._dataset_id, self._tool_names)
