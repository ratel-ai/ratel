import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import {
  type Attributes,
  type Context,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  CLIENT_ADDRESS,
  ERROR_TYPE,
  EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_TOOL_NAME,
  JSONRPC_REQUEST_ID,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  MCP_METHOD_NAME,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_SESSION_ID,
  NETWORK_PROTOCOL_NAME,
  NETWORK_TRANSPORT,
  NetworkTransport,
  USER_AGENT_ORIGINAL,
} from "@ratel-ai/telemetry";
import { captureContentOnSpan, getTracer } from "./telemetry.js";

/** Options for {@link instrumentMcpServer}. */
export interface InstrumentMcpServerOptions {
  /**
   * Record the caller's IP address as `client.address` on Streamable HTTP
   * spans. Off by default: an IP address is personal data. The address is the
   * socket peer (`req.socket.remoteAddress`) of the Node `IncomingMessage`
   * given to `transport.handleRequest`; `X-Forwarded-For` is not read, so
   * behind a proxy this is the proxy's address.
   */
  captureClientAddress?: boolean;
}

/** One request span waiting for its response, by JSON-RPC id. */
interface PendingRequest {
  span: Span;
  /** The wrapper started the span, so the wrapper ends it. */
  owned: boolean;
  method: string;
}

/** What one transport connection learned, shared by all its spans. */
interface Connection {
  /** The session id of a connection whose transport has none (stdio). */
  generatedSessionId: string;
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
  pending: Map<string | number, PendingRequest>;
}

type Instrumentable = McpServer | Server;
type IncomingHandler = (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
type SendFn = (message: JSONRPCMessage, options?: TransportSendOptions) => Promise<void>;

const INSTRUMENTED = Symbol.for("@ratel-ai/sdk.instrumentMcpServer");
const TOOL_ERROR = "tool_error";
const NAME_TARGET_METHODS = new Set(["tools/call", "prompts/get"]);
const URI_TARGET_METHODS = new Set([
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
]);
const ownSpans = new WeakSet<Span>();
const remoteAddress = new AsyncLocalStorage<string | undefined>();

/**
 * Emit an OpenTelemetry SERVER span for every MCP message an MCP server
 * receives, with the attributes Ratel Cloud ingest reads from any MCP
 * instrumentation (`mcp.method.name`, `mcp.session.id`, `mcp.client.name`,
 * ...). Accepts the high-level `McpServer` and the low-level `Server` of the
 * official MCP TypeScript SDK (1.x), on stdio and on Streamable HTTP.
 *
 * Call it before `server.connect(transport)`. It hooks every later
 * connection: the spans read the wire, so the `initialize` request names the
 * client (`mcp.client.name` / `.version`, then on every span of the
 * connection), and the `initialize` result names the server (`mcp.server.name`
 * / `.version`). Each span is active while its handler runs, so spans the
 * handler starts nest under it; a `traceparent` in `params._meta` becomes the
 * parent through the host's registered propagator.
 *
 * Tool arguments and results (`gen_ai.tool.call.arguments` / `.result`) are
 * recorded only when the content-capture gate selects a span mode
 * (`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` or
 * {@link setContentCapture}). If another MCP instrumentation already has an
 * active MCP span for the message, the attributes go on that span and no
 * second span is made. Wrapping the same server twice is a no-op.
 *
 * The SDK registers no OpenTelemetry provider: with none registered, every
 * span is a no-op.
 *
 * @param server - An `McpServer` or a low-level `Server`.
 * @param options - See {@link InstrumentMcpServerOptions}.
 * @returns The same server, instrumented.
 *
 * @example
 * ```ts
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
 * import { instrumentMcpServer } from "@ratel-ai/sdk";
 *
 * const server = instrumentMcpServer(new McpServer({ name: "weather", version: "1.0.0" }));
 * server.registerTool("get_forecast", { description: "Forecast" }, async () => ({
 *   content: [{ type: "text", text: "sunny" }],
 * }));
 * await server.connect(new StdioServerTransport());
 * ```
 */
export function instrumentMcpServer<T extends McpServer | Server>(
  server: T,
  options: InstrumentMcpServerOptions = {},
): T {
  const protocol = lowLevelServer(server) as Server & { [INSTRUMENTED]?: true };
  if (protocol[INSTRUMENTED]) return server;
  protocol[INSTRUMENTED] = true;

  const connect = protocol.connect.bind(protocol);
  protocol.connect = async (transport: Transport) => {
    instrumentOnStart(transport, options);
    return connect(transport);
  };
  if (protocol.transport) instrumentTransport(protocol.transport, options);
  return server;
}

function lowLevelServer(server: Instrumentable): Server {
  const inner = (server as { server?: Server }).server;
  return inner && typeof inner.connect === "function" ? inner : (server as Server);
}

/**
 * `Protocol.connect` sets the transport callbacks, then calls `start()`: wrap
 * them at that point, before the first message can arrive.
 */
function instrumentOnStart(transport: Transport, options: InstrumentMcpServerOptions): void {
  const start = transport.start.bind(transport);
  transport.start = async () => {
    instrumentTransport(transport, options);
    return start();
  };
}

function instrumentTransport(
  transport: Transport & { [INSTRUMENTED]?: true },
  options: InstrumentMcpServerOptions,
): void {
  if (transport[INSTRUMENTED]) return;
  transport[INSTRUMENTED] = true;
  const connection: Connection = { generatedSessionId: randomUUID(), pending: new Map() };

  const deliver = transport.onmessage as IncomingHandler | undefined;
  transport.onmessage = ((message: JSONRPCMessage, extra?: MessageExtraInfo) =>
    onIncoming(connection, transport, options, message, extra, deliver)) as Transport["onmessage"];

  const send = transport.send.bind(transport) as SendFn;
  transport.send = (message: JSONRPCMessage, sendOptions?: TransportSendOptions) => {
    onOutgoing(connection, message);
    return send(message, sendOptions);
  };

  const onclose = transport.onclose;
  transport.onclose = () => {
    endPending(connection);
    onclose?.();
  };

  if (options.captureClientAddress) captureRemoteAddress(transport);
}

function onIncoming(
  connection: Connection,
  transport: Transport,
  options: InstrumentMcpServerOptions,
  message: JSONRPCMessage,
  extra: MessageExtraInfo | undefined,
  deliver: IncomingHandler | undefined,
): void {
  if (!("method" in message)) {
    deliver?.(message, extra);
    return;
  }
  const id = "id" in message ? message.id : undefined;
  const params = record(message.params);
  if (message.method === "initialize") rememberClient(connection, params);
  if (message.method === "notifications/cancelled") endCancelled(connection, params);
  const attributes = messageAttributes(
    connection,
    transport,
    options,
    message.method,
    id,
    params,
    extra,
  );

  const active = trace.getActiveSpan();
  if (active && isForeignMcpSpan(active)) {
    active.setAttributes(attributes);
    if (id !== undefined)
      connection.pending.set(id, { span: active, owned: false, method: message.method });
    deliver?.(message, extra);
    return;
  }

  const parent = parentContext(params);
  const span = getTracer().startSpan(
    spanName(message.method, params),
    { kind: SpanKind.SERVER, attributes },
    parent,
  );
  ownSpans.add(span);
  if (id !== undefined) connection.pending.set(id, { span, owned: true, method: message.method });
  try {
    context.with(trace.setSpan(parent, span), () => deliver?.(message, extra));
  } catch (err) {
    connection.pending.delete(id ?? "");
    span.setAttribute(ERROR_TYPE, err instanceof Error ? err.name : typeof err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    span.end();
    throw err;
  }
  if (id === undefined) span.end();
}

function onOutgoing(connection: Connection, message: JSONRPCMessage): void {
  // An error response to an unparseable request has no id.
  if ("method" in message || !("id" in message) || message.id === undefined) return;
  const pending = connection.pending.get(message.id);
  if (!pending) return;
  connection.pending.delete(message.id);
  const { span } = pending;
  if ("error" in message) {
    span.setAttribute(ERROR_TYPE, String(message.error.code));
    span.setStatus({ code: SpanStatusCode.ERROR, message: message.error.message });
  } else if ("result" in message) {
    recordResult(connection, pending, record(message.result));
  }
  if (pending.owned) span.end();
}

function recordResult(
  connection: Connection,
  pending: PendingRequest,
  result: Record<string, unknown>,
): void {
  const { span, method } = pending;
  if (method === "initialize") {
    const serverInfo = record(result.serverInfo);
    const version = stringOf(result.protocolVersion);
    if (version) connection.protocolVersion = version;
    span.setAttributes(
      definedAttributes({
        [MCP_SERVER_NAME]: stringOf(serverInfo.name),
        [MCP_SERVER_VERSION]: stringOf(serverInfo.version),
        [MCP_PROTOCOL_VERSION]: version,
      }),
    );
  }
  if (method !== "tools/call") return;
  if (captureContentOnSpan()) span.setAttribute(GEN_AI_TOOL_CALL_RESULT, safeJson(result));
  if (result.isError === true) {
    span.setAttribute(ERROR_TYPE, TOOL_ERROR);
    span.setStatus({ code: SpanStatusCode.ERROR, message: TOOL_ERROR });
  }
}

/** The client of the connection, from the `initialize` request's `clientInfo`. */
function rememberClient(connection: Connection, params: Record<string, unknown>): void {
  const clientInfo = record(params.clientInfo);
  connection.clientName = stringOf(clientInfo.name);
  connection.clientVersion = stringOf(clientInfo.version);
  connection.protocolVersion = stringOf(params.protocolVersion);
}

function messageAttributes(
  connection: Connection,
  transport: Transport,
  options: InstrumentMcpServerOptions,
  method: string,
  id: string | number | undefined,
  params: Record<string, unknown>,
  extra: MessageExtraInfo | undefined,
): Attributes {
  const headers = extra?.requestInfo?.headers;
  const http = headers !== undefined;
  const attributes: Record<string, string | undefined> = {
    [MCP_METHOD_NAME]: method,
    [JSONRPC_REQUEST_ID]: id === undefined ? undefined : String(id),
    // Stateless HTTP has no session: the per-connection id would name one request only.
    [MCP_SESSION_ID]: transport.sessionId ?? (http ? undefined : connection.generatedSessionId),
    [MCP_PROTOCOL_VERSION]: connection.protocolVersion ?? header(headers, "mcp-protocol-version"),
    [MCP_CLIENT_NAME]: connection.clientName,
    [MCP_CLIENT_VERSION]: connection.clientVersion,
    [NETWORK_TRANSPORT]: http ? NetworkTransport.Tcp : NetworkTransport.Pipe,
    [NETWORK_PROTOCOL_NAME]: http ? "http" : undefined,
    [USER_AGENT_ORIGINAL]: header(headers, "user-agent"),
    [CLIENT_ADDRESS]: http && options.captureClientAddress ? remoteAddress.getStore() : undefined,
  };
  if (method === "tools/call") {
    attributes[GEN_AI_OPERATION_NAME] = EXECUTE_TOOL;
    attributes[GEN_AI_TOOL_NAME] = stringOf(params.name);
    if (captureContentOnSpan()) {
      attributes[GEN_AI_TOOL_CALL_ARGUMENTS] = safeJson(params.arguments ?? {});
    }
  }
  return definedAttributes(attributes);
}

/** `<method> <target>`: the tool or prompt name, or the resource uri, when the method has one. */
function spanName(method: string, params: Record<string, unknown>): string {
  const target = NAME_TARGET_METHODS.has(method)
    ? stringOf(params.name)
    : URI_TARGET_METHODS.has(method)
      ? stringOf(params.uri)
      : undefined;
  return target ? `${method} ${target}` : method;
}

/** A recording MCP span another instrumentation made (it carries `mcp.method.name`). */
function isForeignMcpSpan(span: Span): boolean {
  if (ownSpans.has(span) || !span.isRecording()) return false;
  const attributes = (span as { attributes?: Attributes }).attributes;
  return attributes?.[MCP_METHOD_NAME] !== undefined;
}

/** The caller's trace context from `params._meta` (`traceparent`), else the active context. */
function parentContext(params: Record<string, unknown>): Context {
  const meta = record(params._meta);
  if (meta.traceparent === undefined) return context.active();
  return propagation.extract(context.active(), meta);
}

/** A cancelled request gets no response: end its span now. */
function endCancelled(connection: Connection, params: Record<string, unknown>): void {
  const requestId = params.requestId;
  if (typeof requestId !== "string" && typeof requestId !== "number") return;
  const pending = connection.pending.get(requestId);
  if (!pending) return;
  connection.pending.delete(requestId);
  if (pending.owned) pending.span.end();
}

function endPending(connection: Connection): void {
  for (const pending of connection.pending.values()) {
    if (pending.owned) pending.span.end();
  }
  connection.pending.clear();
}

/**
 * Carry the socket peer of each `handleRequest(req, res, body)` call down to
 * the `onmessage` it causes. Only Node `IncomingMessage` requests have one.
 */
function captureRemoteAddress(transport: Transport): void {
  const target = transport as { handleRequest?: (req: unknown, ...rest: unknown[]) => unknown };
  const handleRequest = target.handleRequest?.bind(transport);
  if (!handleRequest) return;
  target.handleRequest = (req: unknown, ...rest: unknown[]) =>
    remoteAddress.run(socketAddress(req), () => handleRequest(req, ...rest));
}

function socketAddress(req: unknown): string | undefined {
  const socket = (req as { socket?: { remoteAddress?: unknown } } | null)?.socket;
  return stringOf(socket?.remoteAddress);
}

function header(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  const value = headers?.[name];
  return Array.isArray(value) ? value.join(", ") : stringOf(value);
}

function definedAttributes(attributes: Record<string, string | undefined>): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
