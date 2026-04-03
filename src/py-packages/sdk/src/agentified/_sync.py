from __future__ import annotations

import asyncio

from .client import Agentified
from .dataset_ref import DatasetRef
from .instance import Instance
from .models import RegisterInput, SearchStrategy


class SyncAgentified:
    def __init__(self) -> None:
        self._async = Agentified()

    def connect(
        self,
        server_url: str,
        *,
        headers: dict[str, str] | None = None,
        strategy: SearchStrategy | None = None,
    ) -> None:
        asyncio.run(self._async.connect(server_url, headers=headers, strategy=strategy))

    def disconnect(self) -> None:
        asyncio.run(self._async.disconnect())

    def dataset(self, name: str) -> DatasetRef:
        return self._async.dataset(name)

    def register(self, input: RegisterInput) -> Instance:
        return asyncio.run(self._async.register(input))
