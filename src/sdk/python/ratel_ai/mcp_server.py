"""OpenTelemetry SERVER spans for an MCP server (RC-793).

The Python twin of `src/sdk/ts/src/mcp-server.ts`: `instrument_mcp_server` wraps
a server of the official MCP Python SDK and emits one SERVER span per MCP message
it receives, with the attributes Ratel Cloud ingest reads from any MCP
instrumentation. The keys come from the OTel-free `ratel_ai_telemetry` vocabulary.

Two seams, one span shape:

- mcp 2.x: a `Server.middleware` entry. It wraps every inbound request and
  notification (``initialize`` included) and sees the result before it is sent.
  The SDK's own `OpenTelemetryMiddleware` is on by default and runs outside it, so
  its span is the active one: the wrapper adds its attributes to that span and
  makes no second span.
- mcp 1.x (no middleware): the message streams `Server.run` gets, per connection.
  The incoming request starts the span, the outgoing response ends it, and
  `Server._handle_request` makes it current while the handler runs.
"""

from __future__ import annotations

import contextvars
import uuid
import weakref
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, TypeVar

import ratel_ai_telemetry as _vocabulary
from ratel_ai_telemetry import (
    EXECUTE_TOOL,
    GEN_AI_OPERATION_NAME,
    GEN_AI_TOOL_CALL_ARGUMENTS,
    GEN_AI_TOOL_CALL_RESULT,
    GEN_AI_TOOL_NAME,
)

from . import telemetry as _telemetry

try:  # optional: without OpenTelemetry, instrument_mcp_server returns the server unchanged
    from opentelemetry import propagate as _propagate
    from opentelemetry import trace as _otel_trace
    from opentelemetry.trace import SpanKind, Status, StatusCode

    _OTEL = True
except ModuleNotFoundError:
    _OTEL = False

# The MCP keys shipped in ratel-ai-telemetry 0.6; the literals keep an older
# telemetry helper working (the SDK and the helper ship on separate trains).
MCP_METHOD_NAME: str = getattr(_vocabulary, "MCP_METHOD_NAME", "mcp.method.name")
MCP_SESSION_ID: str = getattr(_vocabulary, "MCP_SESSION_ID", "mcp.session.id")
MCP_PROTOCOL_VERSION: str = getattr(_vocabulary, "MCP_PROTOCOL_VERSION", "mcp.protocol.version")
MCP_CLIENT_NAME: str = getattr(_vocabulary, "MCP_CLIENT_NAME", "mcp.client.name")
MCP_CLIENT_VERSION: str = getattr(_vocabulary, "MCP_CLIENT_VERSION", "mcp.client.version")
MCP_SERVER_NAME: str = getattr(_vocabulary, "MCP_SERVER_NAME", "mcp.server.name")
MCP_SERVER_VERSION: str = getattr(_vocabulary, "MCP_SERVER_VERSION", "mcp.server.version")
JSONRPC_REQUEST_ID: str = getattr(_vocabulary, "JSONRPC_REQUEST_ID", "jsonrpc.request.id")
NETWORK_TRANSPORT: str = getattr(_vocabulary, "NETWORK_TRANSPORT", "network.transport")
NETWORK_PROTOCOL_NAME: str = getattr(_vocabulary, "NETWORK_PROTOCOL_NAME", "network.protocol.name")
USER_AGENT_ORIGINAL: str = getattr(_vocabulary, "USER_AGENT_ORIGINAL", "user_agent.original")
CLIENT_ADDRESS: str = getattr(_vocabulary, "CLIENT_ADDRESS", "client.address")
ERROR_TYPE: str = getattr(_vocabulary, "ERROR_TYPE", "error.type")

ServerT = TypeVar("ServerT")

_INSTRUMENTED = "_ratel_instrument_mcp_server"
_TOOL_ERROR = "tool_error"
_INVALID_PARAMS = "-32602"
#: Where a 2026-07-28 result's `_meta` stamps the server's `serverInfo`.
_SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo"
_PIPE = "pipe"
_TCP = "tcp"
_NAME_TARGET_METHODS = frozenset({"tools/call", "prompts/get"})
_URI_TARGET_METHODS = frozenset({"resources/read", "resources/subscribe", "resources/unsubscribe"})


@dataclass(frozen=True)
class _Options:
    capture_client_address: bool


@dataclass
class _PendingRequest:
    """One request span waiting for its response (mcp 1.x)."""

    span: Any
    #: The wrapper started the span, so the wrapper ends it.
    owned: bool
    method: str


@dataclass
class _Connection:
    """What one connection learned, shared by all its spans."""

    #: The session id of a connection whose transport has none (stdio).
    generated_session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str | None = None
    client_version: str | None = None
    protocol_version: str | None = None
    pending: dict[Any, _PendingRequest] = field(default_factory=dict)


#: The connection of the `Server.run` call a mcp 1.x handler task runs under.
_V1_CONNECTION: contextvars.ContextVar[_Connection | None] = contextvars.ContextVar(
    "ratel_mcp_server_connection", default=None
)
#: mcp 2.x: connection state by the SDK's own connection (or its stream channel).
_V2_CONNECTIONS: weakref.WeakKeyDictionary[Any, _Connection] = weakref.WeakKeyDictionary()


def instrument_mcp_server(server: ServerT, *, capture_client_address: bool = False) -> ServerT:
    """Emit an OpenTelemetry SERVER span for every MCP message an MCP server receives.

    Accepts the high-level server (`MCPServer` on mcp 2.x, `FastMCP` on 1.x) and the
    low-level `Server` of the official MCP Python SDK, on stdio and on Streamable
    HTTP. Call it before the server runs; it hooks every later connection. Wrapping
    the same server twice is a no-op.

    The span name is `<method> <target>` (`tools/call get_forecast`, `initialize`).
    The `initialize` request names the client (`mcp.client.name` / `.version`, then
    on every span of the connection), and its result names the server
    (`mcp.server.name` / `.version`). `mcp.session.id` is the transport session id on
    HTTP and one generated id per connection on stdio. Each span is active while its
    handler runs, so spans the handler starts nest under it; a `traceparent` in
    `params._meta` becomes the parent.

    Tool arguments and results (`gen_ai.tool.call.arguments` / `.result`) are
    recorded only when content capture selects a span mode
    (`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` or `set_content_capture`).
    If another MCP instrumentation already has an active MCP span for the message
    (the mcp 2.x SDK's own `OpenTelemetryMiddleware`, on by default), the
    attributes go on that span and no second span is made.

    The SDK registers no OpenTelemetry provider: with none registered, every span
    is a no-op. Without OpenTelemetry installed, the server is returned unchanged.

    Args:
        server: An `MCPServer` / `FastMCP` or a low-level `Server`.
        capture_client_address: Record the caller's IP address as `client.address`
            on Streamable HTTP spans. Off by default: an IP address is personal
            data. It is the socket peer of the HTTP request; `X-Forwarded-For` is
            not read, so behind a proxy this is the proxy's address.

    Returns:
        The same server, instrumented.

    Example:
        ```python
        from mcp.server.mcpserver import MCPServer
        from ratel_ai import instrument_mcp_server

        server = instrument_mcp_server(MCPServer("weather", version="1.0.0"))

        @server.tool()
        def get_forecast(city: str) -> str:
            return "sunny"

        server.run("stdio")
        ```
    """
    lowlevel = _lowlevel_server(server)
    if not (_OTEL and _telemetry._ENABLED) or getattr(lowlevel, _INSTRUMENTED, False):
        return server
    setattr(lowlevel, _INSTRUMENTED, True)
    options = _Options(capture_client_address=capture_client_address)
    middleware = getattr(lowlevel, "middleware", None)
    if isinstance(middleware, list):
        middleware.append(_McpServerMiddleware(options))
    else:
        _instrument_run(lowlevel, options)
    return server


def _lowlevel_server(server: Any) -> Any:
    for attribute in ("_lowlevel_server", "_mcp_server"):  # MCPServer (2.x), FastMCP (1.x)
        inner = getattr(server, attribute, None)
        if inner is not None and callable(getattr(inner, "run", None)):
            return inner
    return server


# ---------------------------------------------------------------------------
# mcp 2.x: a Server.middleware entry
# ---------------------------------------------------------------------------


class _McpServerMiddleware:
    """`ServerMiddleware`: one span (or the native span) around each inbound message."""

    def __init__(self, options: _Options) -> None:
        self._options = options

    async def __call__(self, ctx: Any, call_next: Any) -> Any:
        method: str = ctx.method
        params = _record(ctx.params)
        request = getattr(ctx, "request", None)
        sdk_connection = getattr(ctx.session, "_connection", None)
        connection = _v2_connection(sdk_connection, request)
        if method == "initialize":
            _remember_client(connection, params)
        else:
            _remember_client_params(connection, getattr(ctx.session, "client_params", None))
            connection.protocol_version = connection.protocol_version or _string(
                getattr(ctx, "protocol_version", None)
            )
        session_id = _string(getattr(sdk_connection, "session_id", None))
        attributes = _message_attributes(
            connection, self._options, method, ctx.request_id, params, request, session_id
        )
        span, owned = _open_span(method, params, attributes)
        with _otel_trace.use_span(
            span, end_on_exit=owned, record_exception=False, set_status_on_exception=False
        ):
            try:
                result = await call_next(ctx)
            except Exception as error:
                _record_failure(span, error)
                raise
            if ctx.request_id is not None:
                _record_result(connection, span, method, _record(result))
            return result


def _v2_connection(sdk_connection: Any, request: Any) -> _Connection:
    """The state of one connection: the SDK's `Connection`, or on stdio its stream channel.

    A 2026-07-28 (stateless) message gets a fresh SDK `Connection` per request, but on
    stdio its stream channel (`outbound`) lives as long as the pipe, so the
    generated session id does too.
    """
    key = sdk_connection
    if request is None and sdk_connection is not None:
        key = getattr(sdk_connection, "outbound", None) or sdk_connection
    if key is None:
        return _Connection()
    try:
        return _V2_CONNECTIONS.setdefault(key, _Connection())
    except TypeError:  # not weak-referenceable
        return _Connection()


def _remember_client_params(connection: _Connection, client_params: Any) -> None:
    if connection.client_name is not None or client_params is None:
        return
    client_info = getattr(client_params, "client_info", None) or getattr(
        client_params, "clientInfo", None
    )
    connection.client_name = _string(getattr(client_info, "name", None))
    connection.client_version = _string(getattr(client_info, "version", None))


# ---------------------------------------------------------------------------
# mcp 1.x: the message streams of Server.run
# ---------------------------------------------------------------------------


def _instrument_run(lowlevel: Any, options: _Options) -> None:
    run = lowlevel.run
    handle_request = getattr(lowlevel, "_handle_request", None)

    async def instrumented_run(
        read_stream: Any, write_stream: Any, *args: Any, **kwargs: Any
    ) -> Any:
        connection = _Connection()
        token = _V1_CONNECTION.set(connection)
        try:
            return await run(
                _ObservedReadStream(read_stream, connection, options),
                _ObservedWriteStream(write_stream, connection),
                *args,
                **kwargs,
            )
        finally:
            _V1_CONNECTION.reset(token)
            _end_pending(connection)

    lowlevel.run = instrumented_run
    if handle_request is None:
        return

    async def instrumented_handle_request(message: Any, *args: Any, **kwargs: Any) -> Any:
        connection = _V1_CONNECTION.get()
        request_id = getattr(message, "request_id", None)
        pending = connection.pending.get(request_id) if connection is not None else None
        if pending is None:
            return await handle_request(message, *args, **kwargs)
        with _otel_trace.use_span(
            pending.span, end_on_exit=False, record_exception=False, set_status_on_exception=False
        ):
            return await handle_request(message, *args, **kwargs)

    lowlevel._handle_request = instrumented_handle_request


class _ObservedReadStream:
    """The server's read stream: each incoming request or notification starts a span."""

    def __init__(self, inner: Any, connection: _Connection, options: _Options) -> None:
        self._inner = inner
        self._connection = connection
        self._options = options

    async def receive(self) -> Any:
        item = await self._inner.receive()
        try:
            self._observe(item)
        except Exception:  # telemetry must never break the server
            pass
        return item

    def __aiter__(self) -> _ObservedReadStream:
        return self

    async def __anext__(self) -> Any:
        try:
            return await self.receive()
        except (_end_of_stream(), _closed_resource()):
            raise StopAsyncIteration from None

    async def __aenter__(self) -> _ObservedReadStream:
        await self._inner.__aenter__()
        return self

    async def __aexit__(self, *exc_info: Any) -> Any:
        return await self._inner.__aexit__(*exc_info)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def _observe(self, item: Any) -> None:
        message = _jsonrpc(item)
        method = _string(getattr(message, "method", None))
        if method is None:
            return
        connection = self._connection
        request_id = getattr(message, "id", None)
        params = _record(getattr(message, "params", None))
        request = getattr(getattr(item, "metadata", None), "request_context", None)
        if method == "initialize":
            _remember_client(connection, params)
        if method == "notifications/cancelled":
            _end_cancelled(connection, params)
        session_id = _header(request, "mcp-session-id")
        attributes = _message_attributes(
            connection, self._options, method, request_id, params, request, session_id
        )
        span, owned = _open_span(method, params, attributes)
        if request_id is None:
            if owned:
                span.end()
            return
        connection.pending[request_id] = _PendingRequest(span=span, owned=owned, method=method)


class _ObservedWriteStream:
    """The server's write stream: each outgoing response ends its request's span."""

    def __init__(self, inner: Any, connection: _Connection) -> None:
        self._inner = inner
        self._connection = connection

    async def send(self, item: Any) -> None:
        try:
            self._observe(item)
        except Exception:  # telemetry must never break the server
            pass
        await self._inner.send(item)

    async def __aenter__(self) -> _ObservedWriteStream:
        await self._inner.__aenter__()
        return self

    async def __aexit__(self, *exc_info: Any) -> Any:
        return await self._inner.__aexit__(*exc_info)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def _observe(self, item: Any) -> None:
        message = _jsonrpc(item)
        if getattr(message, "method", None) is not None:
            return
        request_id = getattr(message, "id", None)
        pending = self._connection.pending.pop(request_id, None)
        if pending is None:
            return
        error = getattr(message, "error", None)
        if error is not None:
            _record_error(pending.span, getattr(error, "code", None), getattr(error, "message", ""))
        else:
            result = _record(getattr(message, "result", None))
            _record_result(self._connection, pending.span, pending.method, result)
        if pending.owned:
            pending.span.end()


def _end_cancelled(connection: _Connection, params: dict[str, Any]) -> None:
    """A cancelled request gets no response: end its span now."""
    pending = connection.pending.pop(params.get("requestId"), None)
    if pending is not None and pending.owned:
        pending.span.end()


def _end_pending(connection: _Connection) -> None:
    for pending in connection.pending.values():
        if pending.owned:
            pending.span.end()
    connection.pending.clear()


def _jsonrpc(item: Any) -> Any:
    """The JSON-RPC message of a `SessionMessage` (a `JSONRPCMessage` root model on 1.x)."""
    message = getattr(item, "message", None)
    return getattr(message, "root", message)


def _end_of_stream() -> type[BaseException]:
    import anyio

    return anyio.EndOfStream


def _closed_resource() -> type[BaseException]:
    import anyio

    return anyio.ClosedResourceError


# ---------------------------------------------------------------------------
# Shared: attributes, span, result
# ---------------------------------------------------------------------------


def _remember_client(connection: _Connection, params: dict[str, Any]) -> None:
    """The client of the connection, from the `initialize` request's `clientInfo`."""
    client_info = _record(params.get("clientInfo"))
    connection.client_name = _string(client_info.get("name"))
    connection.client_version = _string(client_info.get("version"))
    connection.protocol_version = _string(params.get("protocolVersion"))


def _message_attributes(
    connection: _Connection,
    options: _Options,
    method: str,
    request_id: Any,
    params: dict[str, Any],
    request: Any,
    transport_session_id: str | None,
) -> dict[str, str]:
    http = request is not None
    attributes: dict[str, str | None] = {
        MCP_METHOD_NAME: method,
        JSONRPC_REQUEST_ID: None if request_id is None else str(request_id),
        # Stateless HTTP has no session: a per-connection id would name one request only.
        MCP_SESSION_ID: transport_session_id or (None if http else connection.generated_session_id),
        MCP_PROTOCOL_VERSION: connection.protocol_version
        or _header(request, "mcp-protocol-version"),
        MCP_CLIENT_NAME: connection.client_name,
        MCP_CLIENT_VERSION: connection.client_version,
        NETWORK_TRANSPORT: _TCP if http else _PIPE,
        NETWORK_PROTOCOL_NAME: "http" if http else None,
        USER_AGENT_ORIGINAL: _header(request, "user-agent"),
        CLIENT_ADDRESS: _client_host(request) if http and options.capture_client_address else None,
    }
    if method == "tools/call":
        attributes[GEN_AI_OPERATION_NAME] = EXECUTE_TOOL
        attributes[GEN_AI_TOOL_NAME] = _string(params.get("name"))
        if _telemetry._capture_content_on_span():
            arguments = params.get("arguments")
            attributes[GEN_AI_TOOL_CALL_ARGUMENTS] = _telemetry._safe_json(
                {} if arguments is None else arguments
            )
    return {key: value for key, value in attributes.items() if value is not None}


def _open_span(method: str, params: dict[str, Any], attributes: dict[str, str]) -> tuple[Any, bool]:
    """The span for one message: the active MCP span of another instrumentation, or a new one.

    Returns the span and whether the wrapper owns it (so ends it).
    """
    active = _otel_trace.get_current_span()
    if _is_foreign_mcp_span(active):
        active.set_attributes(attributes)
        return active, False
    span = _telemetry._tracer().start_span(
        _span_name(method, params),
        context=_parent_context(params),
        kind=SpanKind.SERVER,
        attributes=attributes,
    )
    return span, True


def _record_result(connection: _Connection, span: Any, method: str, result: dict[str, Any]) -> None:
    if method == "initialize":
        server_info = _record(result.get("serverInfo"))
        version = _string(result.get("protocolVersion"))
        if version:
            connection.protocol_version = version
        negotiated = {
            MCP_SERVER_NAME: _string(server_info.get("name")),
            MCP_SERVER_VERSION: _string(server_info.get("version")),
            MCP_PROTOCOL_VERSION: version,
        }
        span.set_attributes({key: value for key, value in negotiated.items() if value})
    if method == "server/discover":
        # The 2026-07-28 protocol has no initialize: its discover result names the server.
        server_info = _record(_record(result.get("_meta")).get(_SERVER_INFO_META_KEY))
        stamped = {
            MCP_SERVER_NAME: _string(server_info.get("name")),
            MCP_SERVER_VERSION: _string(server_info.get("version")),
        }
        span.set_attributes({key: value for key, value in stamped.items() if value})
    if method != "tools/call":
        return
    if _telemetry._capture_content_on_span():
        span.set_attribute(GEN_AI_TOOL_CALL_RESULT, _telemetry._safe_json(result))
    if result.get("isError") is True:
        span.set_attribute(ERROR_TYPE, _TOOL_ERROR)
        span.set_status(Status(StatusCode.ERROR, _TOOL_ERROR))


def _record_failure(span: Any, error: Exception) -> None:
    """A handler raised: a JSON-RPC error keeps its code, anything else its type."""
    error_data = getattr(error, "error", None)  # McpError (1.x) / MCPError (2.x)
    code = getattr(error_data, "code", None)
    if code is not None:
        _record_error(span, code, str(getattr(error_data, "message", "")))
    elif type(error).__name__ == "ValidationError":  # pydantic: the wire says INVALID_PARAMS
        _record_error(span, _INVALID_PARAMS, "Invalid request parameters")
    else:
        span.set_attribute(ERROR_TYPE, type(error).__qualname__)
        span.set_status(Status(StatusCode.ERROR, str(error)))


def _record_error(span: Any, code: Any, message: str) -> None:
    span.set_attribute(ERROR_TYPE, str(code))
    span.set_status(Status(StatusCode.ERROR, message))


def _span_name(method: str, params: dict[str, Any]) -> str:
    """`<method> <target>`: the tool or prompt name, or the resource uri, if the method has one."""
    target = None
    if method in _NAME_TARGET_METHODS:
        target = _string(params.get("name"))
    elif method in _URI_TARGET_METHODS:
        target = _string(params.get("uri"))
    return f"{method} {target}" if target else method


def _is_foreign_mcp_span(span: Any) -> bool:
    """A recording MCP SERVER span another instrumentation made (it carries `mcp.method.name`).

    SERVER only: an in-process MCP client's CLIENT span can be the active one too.
    """
    if not span.is_recording() or getattr(span, "kind", None) != SpanKind.SERVER:
        return False
    scope = getattr(getattr(span, "instrumentation_scope", None), "name", None)
    if scope == _telemetry._TRACER_NAME:
        return False
    attributes = getattr(span, "attributes", None) or {}
    return MCP_METHOD_NAME in attributes


def _parent_context(params: dict[str, Any]) -> Any:
    """The caller's trace context from `params._meta` (`traceparent`), else the active one."""
    meta = _record(params.get("_meta"))
    if "traceparent" not in meta:
        return None
    return _propagate.extract(meta)


def _header(request: Any, name: str) -> str | None:
    headers = getattr(request, "headers", None)
    if headers is None:
        return None
    return _string(headers.get(name))


def _client_host(request: Any) -> str | None:
    return _string(getattr(getattr(request, "client", None), "host", None))


def _record(value: Any) -> dict[str, Any]:
    """A JSON object as a dict: a mapping, or a pydantic model dumped by its wire aliases."""
    if isinstance(value, Mapping):
        return dict(value)
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        dumped = model_dump(by_alias=True, mode="json", exclude_none=True)
        return dumped if isinstance(dumped, dict) else {}
    return {}


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) and value != "" else None
