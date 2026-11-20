"""Tests for `instrument_mcp_server` — mirrors `src/sdk/ts/src/mcp-server.test.ts` (RC-793).

The wrapper runs against a real MCP client: over a real stdio pipe (a child
process), Streamable HTTP (uvicorn on a loopback socket) and the SDK's in-memory
streams. In-process spans are read back from an in-memory exporter on the global
provider, as a host would wire it. The child process writes its spans as JSON
lines to a file.

mcp 2.x ships its own OpenTelemetry instrumentation (`OpenTelemetryMiddleware`,
on by default), so on 2.x the wrapper's attributes land on that span. The
`native` fixture runs the shared cases with it on and with it removed.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
import re
import sys
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("mcp", reason="mcp not installed")
pytest.importorskip("opentelemetry.sdk.trace", reason="OpenTelemetry SDK not installed")

import anyio  # noqa: E402
from mcp import types  # noqa: E402
from mcp.client.session import ClientSession  # noqa: E402
from mcp.client.stdio import StdioServerParameters, stdio_client  # noqa: E402
from mcp.shared.memory import create_client_server_memory_streams  # noqa: E402
from opentelemetry import trace  # noqa: E402
from opentelemetry.sdk.trace import ReadableSpan  # noqa: E402
from opentelemetry.trace import SpanKind, StatusCode  # noqa: E402
from otel_support import SPAN_EXPORTER  # noqa: E402
from ratel_ai_telemetry import ContentCapture, set_content_capture  # noqa: E402

from ratel_ai import instrument_mcp_server  # noqa: E402

MCP_MAJOR = int(importlib.metadata.version("mcp").split(".", maxsplit=1)[0])
FIXTURE_DIR = Path(__file__).parents[3] / "telemetry" / "conformance" / "mcp-server"
STDIO_APP = Path(__file__).parent / "mcp_server_stdio_app.py"
OTLP_SERVER_KIND = 2  # OTLP SPAN_KIND_SERVER
CLIENT_NAME = "claude-code"
CLIENT_VERSION = "2.1.3"
USER_AGENT = "claude-code/2.1.3 (external, cli)"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TOOLS = ("get_forecast", "search_notes")


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch, otel_exporters: Any) -> Any:
    """Each test reads its spans from the session's shared provider (conftest `otel_exporters`)."""
    monkeypatch.delenv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", raising=False)
    yield
    set_content_capture(None)


@pytest.fixture(params=[True, False], ids=["native-otel", "no-native-otel"])
def native(request: pytest.FixtureRequest) -> bool:
    """On mcp 2.x: keep (True) or remove (False) the SDK's own OpenTelemetry middleware."""
    if request.param and MCP_MAJOR < 2:
        pytest.skip("mcp 1.x has no native OpenTelemetry instrumentation")
    return bool(request.param)


# ---------------------------------------------------------------------------
# Contract: the ratel-cloud client-facts fixtures
# ---------------------------------------------------------------------------


def test_loads_the_copied_fixtures() -> None:
    methods = {span["method"] for span in _fixture_spans()}
    assert sorted(methods) == [
        "initialize",
        "notifications/initialized",
        "tools/call",
        "tools/list",
    ]


@pytest.mark.parametrize("transport", ["http", "stdio"])
async def test_emits_every_fixture_span_shape_and_key(
    transport: str, native: bool, tmp_path: Path
) -> None:
    async def steps(session: ClientSession) -> None:
        await session.call_tool("get_forecast", {"city": "Rome"})
        await session.call_tool("search_notes", {"query": "otel"})
        await session.list_tools()

    if transport == "http":
        async with _http_session(_high_level_server(native)) as (session, _):
            await steps(session)
        spans = [_as_dict(span) for span in _server_spans()]
        prefix = "ts-http-"
    else:
        spans = await _run_stdio(tmp_path, steps, native=native)
        prefix = "py-stdio-"

    for expected in [s for s in _fixture_spans() if s["file"].startswith(prefix)]:
        ours = [span for span in spans if span["name"] == expected["name"]]
        assert len(ours) >= 1, f"{expected['file']}: no span {expected['name']}"
        span = ours[0]
        assert span["kind"] == "SERVER"
        required = [*expected["keys"], "mcp.client.name", "mcp.client.version"]
        if _v1_http_initialize(transport, expected["method"]):
            required.remove("mcp.session.id")
        if expected["method"] == "initialize":
            required += ["mcp.server.name", "mcp.server.version"]
        for key in required:
            assert key in span["attributes"], f"{expected['file']}: {span['name']} lacks {key}"


# ---------------------------------------------------------------------------
# Behaviour
# ---------------------------------------------------------------------------


async def test_records_the_initialize_facts(native: bool) -> None:
    async with _memory_session(_high_level_server(native)) as session:
        await session.list_tools()

    init = _span_named("initialize")
    assert init.attributes is not None
    assert init.attributes["mcp.method.name"] == "initialize"
    assert str(init.attributes["jsonrpc.request.id"]).isdigit()
    assert init.attributes["mcp.client.name"] == CLIENT_NAME
    assert init.attributes["mcp.client.version"] == CLIENT_VERSION
    assert init.attributes["mcp.server.name"] == "weather-mcp"
    assert init.attributes["mcp.server.version"]
    assert init.attributes["mcp.protocol.version"]
    notification = _span_named("notifications/initialized")
    assert notification.kind == SpanKind.SERVER
    assert "jsonrpc.request.id" not in (notification.attributes or {})


async def test_puts_the_session_id_and_the_client_on_tools_call(native: bool) -> None:
    async with _memory_session(_high_level_server(native)) as session:
        await session.call_tool("get_forecast", {"city": "Rome"})

    call = _span_named("tools/call get_forecast")
    attributes = dict(call.attributes or {})
    assert attributes["mcp.method.name"] == "tools/call"
    assert attributes["gen_ai.operation.name"] == "execute_tool"
    assert attributes["gen_ai.tool.name"] == "get_forecast"
    assert attributes["mcp.client.name"] == CLIENT_NAME
    assert attributes["mcp.client.version"] == CLIENT_VERSION
    assert attributes["network.transport"] == "pipe"
    assert UUID.match(str(attributes["mcp.session.id"]))
    init = _span_named("initialize")
    assert attributes["mcp.session.id"] == (init.attributes or {})["mcp.session.id"]


async def test_marks_stdio_as_a_pipe_with_one_session_id_per_connection(tmp_path: Path) -> None:
    async def steps(session: ClientSession) -> None:
        await session.list_tools()

    first = await _run_stdio(tmp_path / "first", steps, native=False)
    second = await _run_stdio(tmp_path / "second", steps, native=False)

    spans = first + second
    assert spans
    assert all(span["attributes"]["network.transport"] == "pipe" for span in spans)
    assert all("network.protocol.name" not in span["attributes"] for span in spans)
    sessions = {span["attributes"]["mcp.session.id"] for span in spans}
    assert len(sessions) == 2
    assert all(UUID.match(session) for session in sessions)


async def test_reads_the_http_facts_without_client_address(native: bool) -> None:
    async with _http_session(_high_level_server(native)) as (session, session_id):
        await session.call_tool("get_forecast", {"city": "Rome"})
        expected_session = session_id()

    spans = _server_spans()
    assert len(spans) >= 3
    for span in spans:
        attributes = dict(span.attributes or {})
        assert attributes["network.transport"] == "tcp"
        assert attributes["network.protocol.name"] == "http"
        assert attributes["user_agent.original"] == USER_AGENT
        if not _v1_http_initialize("http", span.name):
            assert attributes["mcp.session.id"] == expected_session
        assert "client.address" not in attributes


async def test_records_client_address_only_with_the_option(native: bool) -> None:
    server = _high_level_server(native, capture_client_address=True)
    async with _http_session(server) as (session, _):
        await session.call_tool("get_forecast", {"city": "Rome"})

    spans = _server_spans()
    assert spans
    for span in spans:
        assert (span.attributes or {})["client.address"] == "127.0.0.1"


async def test_captures_no_tool_arguments_or_results_by_default() -> None:
    async with _memory_session(_low_level_server(native=False)) as session:
        await session.call_tool("echo", {"secret": "s3cr3t"})

    attributes = dict(_span_named("tools/call echo").attributes or {})
    assert "gen_ai.tool.call.arguments" not in attributes
    assert "gen_ai.tool.call.result" not in attributes
    assert "s3cr3t" not in json.dumps(attributes)


async def test_captures_tool_arguments_and_results_when_content_capture_allows_spans() -> None:
    set_content_capture(ContentCapture.SPAN_ONLY)
    async with _memory_session(_low_level_server(native=False)) as session:
        await session.call_tool("echo", {"secret": "s3cr3t"})

    attributes = dict(_span_named("tools/call echo").attributes or {})
    assert json.loads(str(attributes["gen_ai.tool.call.arguments"])) == {"secret": "s3cr3t"}
    result = json.loads(str(attributes["gen_ai.tool.call.result"]))
    assert result["content"][0]["text"] == '{"secret": "s3cr3t"}'


async def test_works_on_the_low_level_server(native: bool) -> None:
    async with _memory_session(_low_level_server(native)) as session:
        await session.call_tool("echo", {})

    assert (_span_named("initialize").attributes or {})["mcp.server.name"] == "low-level"
    assert (_span_named("tools/call echo").attributes or {})["mcp.client.name"] == CLIENT_NAME


async def test_marks_a_tool_result_with_is_error_as_tool_error(native: bool) -> None:
    async with _memory_session(_low_level_server(native)) as session:
        await session.call_tool("fail", {})

    call = _span_named("tools/call fail")
    assert (call.attributes or {})["error.type"] == "tool_error"
    assert call.status.status_code == StatusCode.ERROR


async def test_marks_a_json_rpc_error_with_its_code(native: bool) -> None:
    async with _memory_session(_low_level_server(native)) as session:
        with pytest.raises(Exception):  # noqa: B017 - McpError (1.x) / MCPError (2.x)
            await session.list_prompts()

    span = _span_named("prompts/list")
    assert (span.attributes or {})["error.type"] == "-32601"
    assert span.status.status_code == StatusCode.ERROR


async def test_makes_the_request_span_the_parent_of_spans_the_handler_starts(
    native: bool,
) -> None:
    async with _memory_session(_low_level_server(native)) as session:
        await session.call_tool("nested", {})

    call = _span_named("tools/call nested")
    child = next(span for span in SPAN_EXPORTER.get_finished_spans() if span.name == "inner work")
    assert child.parent is not None
    assert child.parent.span_id == call.context.span_id


async def test_continues_a_traceparent_sent_in_params_meta(tmp_path: Path) -> None:
    trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
    traceparent = f"00-{trace_id}-00f067aa0ba902b7-01"

    async def steps(session: ClientSession) -> None:
        await session.call_tool("get_forecast", {}, meta={"traceparent": traceparent})

    spans = await _run_stdio(tmp_path, steps, native=False)

    # The mcp 2.x client injects its own CLIENT span's context over the given one.
    sent = next(
        (
            s
            for s in SPAN_EXPORTER.get_finished_spans()
            if s.kind == SpanKind.CLIENT and "tools/call" in s.name
        ),
        None,
    )
    expected_trace = f"{sent.context.trace_id:032x}" if sent else trace_id
    expected_parent = f"{sent.context.span_id:016x}" if sent else "00f067aa0ba902b7"
    call = next(span for span in spans if span["name"] == "tools/call get_forecast")
    assert call["trace_id"] == expected_trace
    assert call["parent_span_id"] == expected_parent


@pytest.mark.skipif(MCP_MAJOR < 2, reason="mcp 1.x has no native OpenTelemetry instrumentation")
async def test_adds_its_attributes_to_the_native_mcp_span_instead_of_a_second_span() -> None:
    async with _memory_session(_high_level_server(native=True)) as session:
        await session.call_tool("get_forecast", {"city": "Rome"})

    spans = _server_spans()
    assert {span.instrumentation_scope.name for span in spans} == {"mcp-python-sdk"}
    assert len([s for s in spans if s.name == "tools/call get_forecast"]) == 1
    assert len([s for s in spans if s.name == "initialize"]) == 1
    call = dict(_span_named("tools/call get_forecast").attributes or {})
    assert call["mcp.client.name"] == CLIENT_NAME
    assert UUID.match(str(call["mcp.session.id"]))
    assert (_span_named("initialize").attributes or {})["mcp.server.name"] == "weather-mcp"


@pytest.mark.skipif(MCP_MAJOR < 2, reason="the 2026-07-28 protocol needs mcp 2.x")
async def test_keeps_one_session_and_the_server_on_the_2026_protocol_without_initialize(
    native: bool,
) -> None:
    from mcp.client.client import Client

    async with Client(_high_level_server(native), client_info=_client_info()) as client:
        await client.call_tool("get_forecast", {"city": "Rome"})
        await client.call_tool("search_notes", {"query": "otel"})

    spans = _server_spans()
    assert "initialize" not in {span.name for span in spans}
    discover = dict(_span_named("server/discover").attributes or {})
    assert discover["mcp.server.name"] == "weather-mcp"
    assert discover["mcp.server.version"] == "1.0.0"
    call = dict(_span_named("tools/call search_notes").attributes or {})
    assert call["mcp.client.name"] == CLIENT_NAME
    assert call["mcp.client.version"] == CLIENT_VERSION
    sessions = {(span.attributes or {})["mcp.session.id"] for span in spans}
    assert len(sessions) == 1
    assert UUID.match(str(next(iter(sessions))))


async def test_is_idempotent_wrapping_twice_emits_one_span_per_message() -> None:
    server = _high_level_server(native=False)
    assert instrument_mcp_server(server) is server
    async with _memory_session(server) as session:
        await session.list_tools()

    assert len([s for s in _server_spans() if s.name == "tools/list"]) == 1
    assert len([s for s in _server_spans() if s.name == "initialize"]) == 1


def _v1_http_initialize(transport: str, method: str) -> bool:
    """Known gap: mcp 1.x makes the HTTP session id outside the server, after `initialize`."""
    return MCP_MAJOR < 2 and transport == "http" and method == "initialize"


# ---------------------------------------------------------------------------
# Servers (the high-level class and the low-level Server of mcp 1.x and 2.x)
# ---------------------------------------------------------------------------


def _high_level_server(native: bool, *, capture_client_address: bool = False) -> Any:
    if MCP_MAJOR >= 2:
        from mcp.server.mcpserver import MCPServer

        server: Any = MCPServer("weather-mcp", version="1.0.0")
    else:
        from mcp.server.fastmcp import FastMCP

        server = FastMCP("weather-mcp")

    for name in TOOLS:
        server.tool(name=name, description=f"The {name} tool.")(_sunny)
    _set_native(_lowlevel(server), native)
    return instrument_mcp_server(server, capture_client_address=capture_client_address)


def _sunny(city: str = "", query: str = "") -> str:
    return "sunny"


def _low_level_server(native: bool) -> Any:
    tools = [types.Tool(name=name, inputSchema={"type": "object"}) for name in ("echo", "fail")]
    tools.append(types.Tool(name="nested", inputSchema={"type": "object"}))

    def call(name: str, arguments: dict[str, Any] | None) -> types.CallToolResult:
        if name == "fail":
            return types.CallToolResult(
                content=[types.TextContent(type="text", text="no")], isError=True
            )
        if name == "nested":
            trace.get_tracer("test").start_span("inner work").end()
        text = json.dumps(arguments or {})
        return types.CallToolResult(content=[types.TextContent(type="text", text=text)])

    if MCP_MAJOR >= 2:
        from mcp.server.lowlevel.server import Server

        async def on_list_tools(_ctx: Any, _params: Any) -> types.ListToolsResult:
            return types.ListToolsResult(tools=tools)

        async def on_call_tool(_ctx: Any, params: Any) -> types.CallToolResult:
            return call(params.name, params.arguments)

        server: Any = Server(
            "low-level", version="0.1.0", on_list_tools=on_list_tools, on_call_tool=on_call_tool
        )
    else:
        from mcp.server.lowlevel.server import Server

        server = Server("low-level", version="0.1.0")

        @server.list_tools()  # type: ignore[misc]
        async def _list_tools() -> list[types.Tool]:
            return tools

        @server.call_tool(validate_input=False)  # type: ignore[misc]
        async def _call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
            return call(name, arguments)

    _set_native(server, native)
    return instrument_mcp_server(server)


def _lowlevel(server: Any) -> Any:
    return getattr(server, "_lowlevel_server", None) or getattr(server, "_mcp_server", server)


def _set_native(lowlevel: Any, native: bool) -> None:
    middleware = getattr(lowlevel, "middleware", None)
    if native or middleware is None:
        return
    lowlevel.middleware[:] = [
        m for m in middleware if type(m).__name__ != "OpenTelemetryMiddleware"
    ]


# ---------------------------------------------------------------------------
# Transports
# ---------------------------------------------------------------------------


def _client_info() -> Any:
    return types.Implementation(name=CLIENT_NAME, version=CLIENT_VERSION)


@asynccontextmanager
async def _memory_session(server: Any) -> AsyncIterator[ClientSession]:
    lowlevel = _lowlevel(server)
    async with create_client_server_memory_streams() as (client_streams, server_streams):
        async with anyio.create_task_group() as tg:
            tg.start_soon(
                lambda: lowlevel.run(
                    server_streams[0],
                    server_streams[1],
                    lowlevel.create_initialization_options(),
                )
            )
            async with ClientSession(
                client_streams[0], client_streams[1], client_info=_client_info()
            ) as session:
                await session.initialize()
                yield session
            tg.cancel_scope.cancel()


@asynccontextmanager
async def _http_session(
    server: Any,
) -> AsyncIterator[tuple[ClientSession, Callable[[], str | None]]]:
    import uvicorn

    config = uvicorn.Config(
        server.streamable_http_app(), host="127.0.0.1", port=0, log_level="warning"
    )
    http_server = uvicorn.Server(config)
    async with anyio.create_task_group() as tg:
        tg.start_soon(http_server.serve)
        while not http_server.started:
            await anyio.sleep(0.01)
        port = http_server.servers[0].sockets[0].getsockname()[1]
        url = f"http://127.0.0.1:{port}/mcp"
        try:
            async with _http_client(url) as (read, write, session_id):
                async with ClientSession(read, write, client_info=_client_info()) as session:
                    await session.initialize()
                    yield session, session_id
        finally:
            http_server.should_exit = True


@asynccontextmanager
async def _http_client(url: str) -> AsyncIterator[tuple[Any, Any, Callable[[], str | None]]]:
    from mcp.client.streamable_http import streamable_http_client

    if MCP_MAJOR >= 2:
        import httpx2 as httpx
    else:
        import httpx  # type: ignore[no-redef]

    seen: dict[str, str] = {}

    async def remember_session_id(response: Any) -> None:
        session_id = response.headers.get("mcp-session-id")
        if session_id:
            seen["id"] = session_id

    async with httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT},
        timeout=30,
        event_hooks={"response": [remember_session_id]},
    ) as http:
        async with streamable_http_client(url, http_client=http) as streams:
            yield streams[0], streams[1], lambda: seen.get("id")


async def _run_stdio(
    folder: Path, steps: Callable[[ClientSession], Any], *, native: bool
) -> list[dict[str, Any]]:
    """Run the wrapped server as a child process on stdio; return its spans."""
    folder.mkdir(parents=True, exist_ok=True)
    spans_file = folder / "spans.jsonl"
    env = {
        **os.environ,
        "MCP_SPANS_FILE": str(spans_file),
        "MCP_NATIVE_OTEL": "1" if native else "0",
    }
    params = StdioServerParameters(command=sys.executable, args=[str(STDIO_APP)], env=env)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write, client_info=_client_info()) as session:
            await session.initialize()
            await steps(session)
    return [json.loads(line) for line in spans_file.read_text().splitlines() if line]


# ---------------------------------------------------------------------------
# Span readers
# ---------------------------------------------------------------------------


def _server_spans() -> list[ReadableSpan]:
    return [
        span
        for span in SPAN_EXPORTER.get_finished_spans()
        if span.kind == SpanKind.SERVER and "mcp.method.name" in (span.attributes or {})
    ]


def _span_named(name: str) -> ReadableSpan:
    for span in _server_spans():
        if span.name == name:
            return span
    raise AssertionError(f"no MCP span named {name}: {[s.name for s in _server_spans()]}")


def _as_dict(span: ReadableSpan) -> dict[str, Any]:
    return {"name": span.name, "kind": span.kind.name, "attributes": dict(span.attributes or {})}


def _fixture_spans() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for path in sorted(FIXTURE_DIR.glob("*.otlp.json")):
        body = json.loads(path.read_text())
        for resource in body["resourceSpans"]:
            for scope in resource["scopeSpans"]:
                for span in scope["spans"]:
                    keys = [attribute["key"] for attribute in span["attributes"]]
                    method = next(
                        (
                            a["value"]["stringValue"]
                            for a in span["attributes"]
                            if a["key"] == "mcp.method.name"
                        ),
                        None,
                    )
                    if span["kind"] != OTLP_SERVER_KIND or method is None:
                        continue
                    out.append(
                        {"file": path.name, "name": span["name"], "method": method, "keys": keys}
                    )
    return out
