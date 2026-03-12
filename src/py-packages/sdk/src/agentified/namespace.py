from __future__ import annotations

from typing import TYPE_CHECKING

from .models import BackendTool
from .session import Session

if TYPE_CHECKING:
    from .api_client import ApiClient


class Namespace:
    def __init__(
        self,
        id: str,
        sdk: ApiClient,
        dataset_id: str,
        registered_tools: list[BackendTool],
    ) -> None:
        self.id = id
        self._sdk = sdk
        self._dataset_id = dataset_id
        self._registered_tools = registered_tools

    def session(self, id: str) -> Session:
        return Session(id, self.id, self._sdk, self._dataset_id, self._registered_tools)
