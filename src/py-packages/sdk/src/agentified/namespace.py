from __future__ import annotations

from typing import TYPE_CHECKING

from .events import ObserverEmitter
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
        emitter: ObserverEmitter | None = None,
    ) -> None:
        self.id = id
        self._sdk = sdk
        self._dataset_id = dataset_id
        self._registered_tools = registered_tools
        self._emitter = emitter

    def session(self, id: str) -> Session:
        return Session(
            id, self.id, self._sdk, self._dataset_id, self._registered_tools,
            emitter=self._emitter,
        )
