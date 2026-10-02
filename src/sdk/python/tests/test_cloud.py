"""Cloud-owned catalogs (ADR-0027, ADR-0028): sync on register, Tool Picker on
search, against a local stand-in for Ratel Cloud."""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from ratel_ai import CloudError, ExecutableTool, ToolCatalog

KEY_ENV = "RATEL_SDK_PY_CLOUD_TEST_KEY"
SNAPSHOT = "/api/v1/catalog/snapshot"
PICK = "/v1/tools/pick"


class MockCloud:
    """``PUT /api/v1/catalog/snapshot`` and ``POST /v1/tools/pick``. Picks answer
    from a script, or with the synced tools in reverse id order."""

    def __init__(self) -> None:
        self.seen: list[dict[str, Any]] = []
        self.picks: list[tuple[int, dict[str, Any], dict[str, str]]] = []
        self.syncs: list[tuple[int, dict[str, Any]]] = []
        self.synced: list[str] = []
        self.pick_delay = 0.0
        mock = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                mock.seen.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "authorization": self.headers.get("authorization"),
                        "body": body,
                    }
                )
                headers: dict[str, str] = {}
                if self.path == SNAPSHOT:
                    if mock.syncs:
                        status, payload = mock.syncs.pop(0)
                    else:
                        status = 200
                        payload = {
                            "sourceId": body["source_id"],
                            "catalogVersion": f"v{len(mock.seen)}",
                            "tools": len(body["tools"]),
                            "unchanged": False,
                        }
                    if status == 200:
                        mock.synced = [t["id"] for t in body["tools"]]
                elif mock.pick_delay:
                    time.sleep(mock.pick_delay)
                    status, payload = 200, {"tools": [], "confident": None}
                elif mock.picks:
                    status, payload, headers = mock.picks.pop(0)
                else:
                    ranked = sorted(mock.synced, reverse=True)[: body["top_k"]]
                    status, payload = 200, {
                        "mode": body["mode"],
                        "tools": [{"id": i, "score": 0.9 - n * 0.1} for n, i in enumerate(ranked)],
                        "confident": None if body["mode"] == "instant" else True,
                    }
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_PUT = _handle  # noqa: N815 - http.server API
            do_POST = _handle  # noqa: N815 - http.server API

            def log_message(self, *_args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def of(self, path: str) -> list[dict[str, Any]]:
        return [s for s in self.seen if s["path"] == path]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def mock() -> Iterator[MockCloud]:
    os.environ[KEY_ENV] = "cloud-token"
    server = MockCloud()
    yield server
    server.close()


def _tool(tool_id: str) -> ExecutableTool:
    return ExecutableTool(
        id=tool_id, name=tool_id, description=f"does {tool_id}", execute=lambda _a: "ok"
    )


def _catalog(mock: MockCloud, **cloud: Any) -> ToolCatalog:
    return ToolCatalog(
        cloud={"url": mock.url, "api_key_env": KEY_ENV, "source_id": "svc", **cloud}
    )


async def test_register_uploads_an_executor_free_snapshot(mock: MockCloud) -> None:
    catalog = _catalog(mock)
    await catalog.register([_tool("refund"), _tool("charge")])

    (put,) = mock.of(SNAPSHOT)
    assert put["method"] == "PUT"
    assert put["authorization"] == "Bearer cloud-token"
    assert put["body"]["source_id"] == "svc"
    assert [t["id"] for t in put["body"]["tools"]] == ["charge", "refund"]
    assert "execute" not in put["body"]["tools"][0]


async def test_unchanged_catalog_is_skipped_and_a_change_resent(mock: MockCloud) -> None:
    catalog = _catalog(mock)
    await catalog.register([_tool("refund")])
    assert (await catalog.sync_now()).skipped is True
    await catalog.register(_tool("charge"))
    assert len(mock.of(SNAPSHOT)) == 2


async def test_failed_sync_raises_a_typed_error(mock: MockCloud) -> None:
    mock.syncs.append((401, {"error": {"message": "bad key"}}))
    catalog = _catalog(mock)
    with pytest.raises(CloudError) as info:
        await catalog.register(_tool("refund"))
    assert info.value.code == "Unauthorized"
    assert info.value.status == 401
    assert catalog.has("refund")


async def test_failed_sync_only_warns_with_on_sync_error_warn(mock: MockCloud) -> None:
    mock.syncs.append((503, {}))
    catalog = _catalog(mock, on_sync_error="warn")
    with pytest.warns(RuntimeWarning, match="sync"):
        await catalog.register(_tool("refund"))


async def test_search_async_ranks_through_the_tool_picker(mock: MockCloud) -> None:
    catalog = _catalog(mock, mode="exhaustive")
    await catalog.register([_tool("a_tool"), _tool("b_tool")])

    hits = await catalog.search_async("do the thing", 5)

    (pick,) = mock.of(PICK)
    assert pick["method"] == "POST"
    assert pick["body"] == {"query": "do the thing", "mode": "exhaustive", "top_k": 5}
    assert [h.tool_id for h in hits] == ["b_tool", "a_tool"]
    assert hits[0].fused is False


async def test_default_mode_per_call_mode_and_top_k_clamp(mock: MockCloud) -> None:
    catalog = _catalog(mock)
    await catalog.register(_tool("a_tool"))
    await catalog.search_async("q", 50)
    await catalog.search_async("q", 5, mode="instant")
    first, second = (p["body"] for p in mock.of(PICK))
    assert (first["mode"], first["top_k"]) == ("precise", 20)
    assert (second["mode"], second["top_k"]) == ("instant", 5)


async def test_picked_ids_not_registered_here_are_dropped_with_a_warning(
    mock: MockCloud,
) -> None:
    catalog = _catalog(mock)
    await catalog.register(_tool("refund"))
    mock.picks.append(
        (200, {"tools": [{"id": "ghost", "score": 0.9}, {"id": "refund", "score": 0.5}]}, {})
    )
    with pytest.warns(RuntimeWarning, match="ghost"):
        hits = await catalog.search_async("q", 5)
    assert [h.tool_id for h in hits] == ["refund"]


async def test_pick_errors_are_typed(mock: MockCloud) -> None:
    catalog = _catalog(mock)
    await catalog.register(_tool("refund"))
    mock.picks.append((409, {"error": {"message": "sync first"}}, {}))
    mock.picks.append((429, {}, {"retry-after": "7"}))

    with pytest.raises(CloudError) as no_tools:
        await catalog.search_async("q", 5)
    assert no_tools.value.code == "NoSyncedTools"
    with pytest.raises(CloudError) as limited:
        await catalog.search_async("q", 5)
    assert limited.value.code == "RateLimited"
    assert limited.value.retry_after_secs == 7


async def test_sync_search_stays_off_the_network(mock: MockCloud) -> None:
    catalog = _catalog(mock)
    await catalog.register(_tool("refund"))
    with pytest.raises(RuntimeError, match="search_async"):
        catalog.search("q", 5)


def test_cloud_with_a_local_method_or_bad_mode_is_rejected(mock: MockCloud) -> None:
    cloud = {"url": mock.url, "api_key_env": KEY_ENV}
    with pytest.raises(ValueError, match="cloud"):
        ToolCatalog(method="semantic", cloud=cloud)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="cloud"):
        ToolCatalog(reranker={"method": "semantic"}, cloud=cloud)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="mode"):
        ToolCatalog(cloud={**cloud, "mode": "fast"})  # type: ignore[typeddict-item]


def test_cloud_with_system_one_is_rejected(mock: MockCloud) -> None:
    cloud = {"url": mock.url, "api_key_env": KEY_ENV}
    with pytest.raises(ValueError, match="cloud"):
        ToolCatalog(system_one={}, cloud=cloud)  # type: ignore[arg-type]


async def test_concurrent_picks_run_in_parallel(mock: MockCloud) -> None:
    catalog = _catalog(mock)
    await catalog.register(_tool("refund"))
    mock.pick_delay = 0.4

    started = time.monotonic()
    await asyncio.gather(*(catalog.search_async("q", 5) for _ in range(3)))
    elapsed = time.monotonic() - started

    # Serialized behind one lock, three 0.4 s picks would take >= 1.2 s.
    assert elapsed < 0.9, f"picks ran one at a time ({elapsed:.2f}s)"


async def test_register_during_a_pick_fails_fast(mock: MockCloud) -> None:
    catalog = _catalog(mock)
    await catalog.register(_tool("refund"))
    mock.pick_delay = 0.4
    pick = asyncio.ensure_future(catalog.search_async("q", 5))
    await asyncio.sleep(0.1)
    with pytest.raises(RuntimeError, match="busy"):
        await catalog.register(_tool("charge"))
    await pick



async def test_a_pick_after_an_unawaited_register_raises(mock: MockCloud) -> None:
    catalog = _catalog(mock)
    pending = catalog.register(_tool("refund"))  # the await was forgotten
    with pytest.raises(RuntimeError, match="await"):
        await catalog.search_async("q", 5)
    assert mock.of(SNAPSHOT) == [], "nothing was synced"

    await pending
    assert len(mock.of(SNAPSHOT)) == 1
    hits = await catalog.search_async("q", 5)
    assert [h.tool_id for h in hits] == ["refund"]


def test_cloud_with_an_embedding_artifact_is_rejected(mock: MockCloud) -> None:
    with pytest.raises(ValueError, match="artifact"):
        ToolCatalog(
            cloud={"url": mock.url, "api_key_env": KEY_ENV},
            experimental_embedding_artifact={"path": "/nonexistent.rat1"},  # type: ignore[typeddict-item]
        )


def test_a_reranker_without_a_method_is_a_value_error() -> None:
    with pytest.raises(ValueError, match="method"):
        ToolCatalog(reranker={"depth": 10})  # type: ignore[typeddict-item]


def test_an_unknown_on_sync_error_is_rejected(mock: MockCloud) -> None:
    with pytest.raises(ValueError, match="on_sync_error"):
        ToolCatalog(
            cloud={"url": mock.url, "api_key_env": KEY_ENV, "on_sync_error": "warning"}  # type: ignore[typeddict-item]
        )

