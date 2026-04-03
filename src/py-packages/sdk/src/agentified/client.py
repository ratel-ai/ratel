from __future__ import annotations

from typing import Any

import httpx

from .api_client import ApiClient
from .dataset_ref import DatasetRef
from .instance import Instance
from .models import ApiClientConfig, RegisterInput, SearchStrategy


class Agentified:
    def __init__(self) -> None:
        self._sdk: ApiClient | None = None
        self._server_url: str | None = None
        self._connected = False
        self._http_client: httpx.AsyncClient | None = None

    async def connect(
        self,
        server_url: str,
        *,
        headers: dict[str, str] | None = None,
        strategy: SearchStrategy | None = None,
    ) -> None:
        if self._connected:
            raise RuntimeError("Already connected")

        self._http_client = httpx.AsyncClient(headers=headers or {})
        resp = await self._http_client.get(f"{server_url}/health", timeout=5.0)
        if resp.status_code != 200:
            raise RuntimeError(f"Health check failed: {resp.status_code}")

        self._server_url = server_url
        self._sdk = ApiClient(ApiClientConfig(
            server_url=server_url, tools=[], headers=headers, strategy=strategy,
        ))
        self._connected = True

    async def disconnect(self) -> None:
        if not self._connected:
            return
        if self._sdk:
            await self._sdk.close()
        if self._http_client:
            await self._http_client.aclose()
            self._http_client = None
        self._sdk = None
        self._server_url = None
        self._connected = False

    def dataset(self, name: str) -> DatasetRef:
        return DatasetRef(self, name)

    async def register(self, input: RegisterInput) -> Instance:
        return await self.dataset("default").register(input)

    async def __aenter__(self) -> Agentified:
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.disconnect()
