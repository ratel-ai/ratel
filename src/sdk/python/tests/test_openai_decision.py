"""The OpenAI Decisions plugin (ADR-0027) against a local stand-in for
OpenAI's ``POST /v1/decisions``."""

from __future__ import annotations

import json
import threading
import warnings
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from ratel_ai import (
    ExecutableTool,
    RetrieverError,
    Skill,
    SkillCatalog,
    ToolCatalog,
    openai_decision,
    ratel_openai_decision_plugin,
)
from ratel_ai.experimental import ExperimentalWarning

KEY_ENV = "RATEL_SDK_PY_OPENAI_DECISION_TEST_KEY"


class MockDecisions:
    """A Decisions stand-in. Answers each request with the next scripted reply,
    or — when none is queued — with probabilities that rank the choices in
    reverse (``tN`` highest), or favour one preferred id; records what it was
    sent."""

    def __init__(self) -> None:
        self.seen: list[dict[str, Any]] = []
        self.replies: list[tuple[int, dict[str, Any], dict[str, str]]] = []
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
                headers: dict[str, str] = {}
                if mock.replies:
                    status, payload, headers = mock.replies.pop(0)
                else:
                    question = body["questions"][0]
                    choices = question["choices"]
                    probabilities = []
                    for i, choice in enumerate(choices):
                        if mock.preferred is None:
                            p = (i + 1) / (len(choices) + 1)
                        else:
                            pid, pp = mock.preferred
                            p = pp if choice["description"].split(" ")[0] == pid else 0.0
                        probabilities.append({"value": choice["value"], "probability": p})
                    status, payload = (
                        200,
                        {
                            "answers": [
                                {
                                    "type": "choice",
                                    "name": question["name"],
                                    "probabilities": probabilities,
                                    "confidence": 0.9,
                                }
                            ]
                        },
                    )
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def reply(
        self,
        status: int,
        payload: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.replies.append((status, payload or {}, headers or {}))

    def offered(self, call: int = 0) -> list[str]:
        choices = self.seen[call]["body"]["questions"][0]["choices"]
        return [c["description"].split(" ")[0] for c in choices]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def mock(monkeypatch: pytest.MonkeyPatch) -> Iterator[MockDecisions]:
    monkeypatch.setenv(KEY_ENV, "sk-test")
    monkeypatch.setenv("RATEL_EXPERIMENTAL_SILENCE", "1")
    server = MockDecisions()
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


def _decision(mock: MockDecisions) -> Any:
    return ratel_openai_decision_plugin(url=mock.url, api_key_env=KEY_ENV)


async def test_retrieve_asks_one_tool_choice_question_over_every_tool(
    mock: MockDecisions,
) -> None:
    mock.preferred = ("send_email", 0.93)
    catalog = ToolCatalog(method="custom", retrieve_fn=_decision(mock).retrieve)
    await catalog.register(TOOLS)

    hits = await catalog.search_async("tell my boss I'm late", 1)

    assert [h.tool_id for h in hits] == ["send_email"]
    assert hits[0].score == pytest.approx(0.93)
    [request] = mock.seen
    assert request["path"] == "/v1/decisions"
    assert request["authorization"] == "Bearer sk-test"
    assert request["body"]["model"] == "gpt-6-luna"
    assert request["body"]["input"] == "tell my boss I'm late"
    assert [(q["type"], q["name"]) for q in request["body"]["questions"]] == [("choice", "tool")]
    assert sorted(mock.offered()) == sorted(t.id for t in TOOLS)


async def test_rerank_sees_only_stage_one_candidates(mock: MockDecisions) -> None:
    query = "read a file from disk"
    stage_one = await _bm25_order(query, 50)
    mock.preferred = (stage_one[-1], 0.9)
    catalog = ToolCatalog(reranker_fn=_decision(mock).rerank, reranker_depth=20)
    await catalog.register(TOOLS)

    hits = await catalog.search_async(query, 2)

    assert hits[0].tool_id == stage_one[-1]
    assert mock.offered() == stage_one


async def test_skills_get_a_skill_question(mock: MockDecisions) -> None:
    mock.preferred = ("api_design", 0.8)
    skills = SkillCatalog(method="custom", retrieve_fn=_decision(mock).retrieve)
    await skills.register(
        [
            Skill(
                id="api_design", name="api_design", description="design rest endpoints", body="b"
            ),
            Skill(id="deploy", name="deploy", description="deploy a service", body="b"),
        ]
    )
    hits = await skills.search_async("design an api", 1)
    assert hits[0].skill_id == "api_design"
    assert mock.seen[0]["body"]["questions"][0]["name"] == "skill"


async def test_a_rejected_key_raises_even_as_a_reranker(mock: MockDecisions) -> None:
    mock.reply(401, {"error": {"message": "bad key"}})
    catalog = ToolCatalog(reranker_fn=_decision(mock).rerank)
    await catalog.register(TOOLS)
    with pytest.raises(RetrieverError) as caught:
        await catalog.search_async("file", 2)
    assert (caught.value.code, caught.value.status, caught.value.transient) == (
        "Unauthorized",
        401,
        False,
    )
    assert "openai decisions" in str(caught.value)


async def test_a_refusal_falls_back_as_a_reranker_and_raises_as_a_retriever(
    mock: MockDecisions,
) -> None:
    refusal = {"answers": [{"type": "refusal", "name": "tool"}]}
    mock.reply(200, refusal)
    reranked = ToolCatalog(reranker_fn=_decision(mock).rerank)
    await reranked.register(TOOLS)
    hits = await reranked.search_async("delete a file", 3)
    assert [h.tool_id for h in hits] == await _bm25_order("delete a file", 3)

    mock.reply(200, refusal)
    custom = ToolCatalog(method="custom", retrieve_fn=_decision(mock).retrieve)
    await custom.register(TOOLS)
    with pytest.raises(RetrieverError) as caught:
        await custom.search_async("delete a file", 3)
    assert (caught.value.code, caught.value.transient) == ("Refused", True)


async def test_a_rate_limit_carries_retry_after(mock: MockDecisions) -> None:
    mock.reply(429, {}, {"retry-after": "7"})
    catalog = ToolCatalog(method="custom", retrieve_fn=_decision(mock).retrieve)
    await catalog.register(TOOLS)
    with pytest.raises(RetrieverError) as caught:
        await catalog.search_async("q", 2)
    assert (caught.value.code, caught.value.retry_after_secs) == ("RateLimited", 7)


async def test_an_unset_key_fails_before_any_request(mock: MockDecisions) -> None:
    plugin = ratel_openai_decision_plugin(
        url=mock.url, api_key_env="RATEL_SDK_PY_OPENAI_DECISION_UNSET_KEY"
    )
    catalog = ToolCatalog(method="custom", retrieve_fn=plugin.retrieve)
    await catalog.register(TOOLS)
    with pytest.raises(RetrieverError) as caught:
        await catalog.search_async("q", 2)
    assert (caught.value.code, caught.value.transient) == ("Config", False)
    assert mock.seen == []


def test_the_beta_warning_prints_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RATEL_EXPERIMENTAL_SILENCE", raising=False)
    monkeypatch.setattr(openai_decision, "_warned", False)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        ratel_openai_decision_plugin()
        ratel_openai_decision_plugin()
    beta = [w for w in caught if issubclass(w.category, ExperimentalWarning)]
    assert len(beta) == 1
    message = str(beta[0].message)
    for part in ("beta", "gpt-6-luna", "sent to OpenAI", "RATEL_EXPERIMENTAL_SILENCE"):
        assert part in message


def test_the_beta_warning_names_an_overridden_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RATEL_EXPERIMENTAL_SILENCE", raising=False)
    monkeypatch.setattr(openai_decision, "_warned", False)
    with pytest.warns(ExperimentalWarning, match="gpt-6-luna-preview"):
        ratel_openai_decision_plugin(model="gpt-6-luna-preview")


def test_the_beta_warning_stays_quiet_when_silenced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RATEL_EXPERIMENTAL_SILENCE", "1")
    monkeypatch.setattr(openai_decision, "_warned", False)
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        ratel_openai_decision_plugin()
