from __future__ import annotations

from typing import TYPE_CHECKING

from .models import BackendTool, DiscoverTool
from .namespace import Namespace
from .session import Session

if TYPE_CHECKING:
    from .api_client import ApiClient


class Instance:
    def __init__(
        self,
        instance_id: str,
        dataset_id: str,
        sdk: ApiClient,
        registered_tools: list[BackendTool],
    ) -> None:
        self.instance_id = instance_id
        self.dataset_id = dataset_id
        self._sdk = sdk
        self._registered_tools = registered_tools
        self.discover_tool: DiscoverTool = sdk.as_discover_tool(dataset_id)

    def session(self, id: str) -> Session:
        return Session(id, "default", self._sdk, self.dataset_id, self._registered_tools)

    def namespace(self, id: str) -> Namespace:
        return Namespace(id, self._sdk, self.dataset_id, self._registered_tools)
