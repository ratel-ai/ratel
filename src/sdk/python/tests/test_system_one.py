"""System-one ranking and the two-stage reranker (ADR-0027), against a local
stand-in for Jev's ``POST /v1/systemone``."""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from ratel_ai import ExecutableTool, Skill, SkillCatalog, SystemOneError, ToolCatalog

KEY_ENV = "RATEL_SDK_PY_SYSTEM_ONE_TEST_KEY"


class MockSystemOne:
    """A Jev stand-in. Answers each request with the next scripted reply, or —
    when none is queued — with probabilities that rank the options in reverse
    (``tN`` highest), or favour one preferred id; records what it was sent."""

    def __init__(self) -> None:
        self.seen: list[dict[str, Any]] = []
        self.replies: list[tuple[int, dict[str, Any]]] = []
        self.preferred: tuple[str, float] | None = None
        mock = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - http.server API
                length = int(self.headers["content-length"])
                body = json.loads(self.rfile.read(length))
                mock.seen.append(
                    {
                        "path": self.path,
                        "authorization": self.headers.get("authorization"),
                        "body": body,
                    }
                )
                if mock.replies:
                    status, payload = mock.replies.pop(0)
                else:
                    criteria = body["questions"]["tool"]["criteria"]
                    keys = list(criteria)
                    probs = {}
                    for i, key in enumerate(keys):
                        if mock.preferred is None:
                            probs[key] = (i + 1) / (len(keys) + 1)
                        else:
                            pid, p = mock.preferred
                            probs[key] = p if criteria[key].split(" ")[0] == pid else 0.0
                    status, payload = 200, {
                        "model": "jev-1.13.0",
                        "answers": {"tool": {"type": "choice", "probabilities": probs}},
                    }
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def reply(self, status: int, payload: dict[str, Any] | None = None) -> None:
        self.replies.append((status, payload or {}))

    def offered(self, call: int = 0) -> list[str]:
        # A candidate's searchable text starts with its full name, and these
        # fixtures name every item after its id.
        criteria = self.seen[call]["body"]["questions"]["tool"]["criteria"]
        return [text.split(" ")[0] for text in criteria.values()]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def mock() -> Iterator[MockSystemOne]:
    os.environ[KEY_ENV] = "s1-token"
    server = MockSystemOne()
    yield server
    server.close()


def _tool(tool_id: str, description: str) -> ExecutableTool:
    return ExecutableTool(
        id=tool_id, name=tool_id, description=description, execute=lambda _a: "ok"
    )


TOOLS = [
    _tool("read_file", "read a file from disk"),
    _tool("delete_file", "delete a file from disk"),
    _tool("list_files", "list the files in a directory"),
    _tool("send_email", "send an email message"),
]


async def _bm25_order(query: str, top_k: int) -> list[str]:
    plain = ToolCatalog()
    await plain.register(TOOLS)
    return [h.tool_id for h in plain.search(query, top_k)]


def _catalog(mock: MockSystemOne, **kwargs: Any) -> ToolCatalog:
    return ToolCatalog(system_one={"url": mock.url, "api_key_env": KEY_ENV}, **kwargs)


async def test_system_one_ranks_the_whole_catalog(mock: MockSystemOne) -> None:
    mock.preferred = ("send_email", 0.8)
    catalog = _catalog(mock, method="systemOne")
    await catalog.register(TOOLS)

    hits = await catalog.search_async("email my boss", 5)

    assert hits[0].tool_id == "send_email"
    assert hits[0].score == pytest.approx(0.8)
    assert all(h.score == 0 for h in hits[1:])
    assert hits[0].fused is False
    assert mock.seen[0]["path"] == "/v1/systemone"
    assert mock.seen[0]["authorization"] == "Bearer s1-token"
    assert mock.seen[0]["body"]["state"] == "email my boss"
    assert mock.seen[0]["body"]["model"] == "jev-latest"
    assert mock.seen[0]["body"]["questions"]["tool"]["type"] == "choice"
    assert sorted(mock.offered()) == sorted(t.id for t in TOOLS)


async def test_standalone_failure_raises_a_typed_error(mock: MockSystemOne) -> None:
    mock.reply(401)
    catalog = _catalog(mock, method="systemOne")
    await catalog.register(TOOLS)

    with pytest.raises(SystemOneError) as info:
        await catalog.search_async("email my boss", 5)

    assert info.value.code == "Unauthorized"
    assert info.value.status == 401
    assert isinstance(info.value, RuntimeError)


async def test_rerank_sees_only_first_stage_candidates(mock: MockSystemOne) -> None:
    catalog = _catalog(mock, reranker={"method": "systemOne", "depth": 10})
    await catalog.register(TOOLS)

    hits = await catalog.search_async("file", 10)

    offered = mock.offered()
    assert offered == await _bm25_order("file", 10)
    assert "send_email" not in offered
    assert [h.tool_id for h in hits] == list(reversed(offered))


async def test_failed_rerank_falls_back_to_first_stage(mock: MockSystemOne) -> None:
    mock.reply(503)
    catalog = _catalog(mock, reranker={"method": "systemOne"})
    await catalog.register(TOOLS)

    hits = await catalog.search_async("file", 3)

    assert [h.tool_id for h in hits] == await _bm25_order("file", 3)


async def test_per_call_reranker_override(mock: MockSystemOne) -> None:
    catalog = _catalog(mock, reranker={"method": "systemOne"})
    await catalog.register(TOOLS)

    plain = await catalog.search_async("file", 3, reranker=False)
    assert mock.seen == []
    assert [h.tool_id for h in plain] == await _bm25_order("file", 3)

    await catalog.search_async("file", 3, method="systemOne", reranker=False)
    assert len(mock.seen) == 1


def test_reranker_repeating_the_first_stage_is_rejected(mock: MockSystemOne) -> None:
    with pytest.raises(ValueError, match="same"):
        _catalog(mock, method="bm25", reranker={"method": "bm25"})


def test_non_positive_depth_is_rejected(mock: MockSystemOne) -> None:
    with pytest.raises(ValueError, match="depth"):
        _catalog(mock, reranker={"method": "systemOne", "depth": 0})


async def test_sync_search_stays_off_the_network(mock: MockSystemOne) -> None:
    standalone = _catalog(mock, method="systemOne")
    await standalone.register(TOOLS)
    with pytest.raises(RuntimeError, match="asynchronous"):
        standalone.search("file", 3)

    reranked = _catalog(mock, reranker={"method": "systemOne"})
    await reranked.register(TOOLS)
    with pytest.raises(RuntimeError, match="search_async"):
        reranked.search("file", 3)


async def test_skill_catalog_reranks_the_same_way(mock: MockSystemOne) -> None:
    skills = SkillCatalog(
        reranker={"method": "systemOne"},
        system_one={"url": mock.url, "api_key_env": KEY_ENV},
    )
    await skills.register(
        [
            Skill(id="pdf_forms", name="pdf_forms", description="fill pdf forms"),
            Skill(id="pdf_merge", name="pdf_merge", description="merge pdf files"),
            Skill(id="slides", name="slides", description="build slide decks"),
        ]
    )

    hits = await skills.search_async("pdf", 5)

    offered = mock.offered()
    assert "slides" not in offered
    assert [h.skill_id for h in hits] == list(reversed(offered))
