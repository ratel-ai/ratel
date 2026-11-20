import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type JSONRPCMessage,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type Context,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TextMapPropagator,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContentCapture, instrumentMcpServer, setContentCapture } from "./index.js";

/**
 * RC-792: `instrumentMcpServer` against a real MCP client, over a real stdio
 * transport (on in-process pipes), Streamable HTTP (on a loopback socket) and
 * the SDK's in-memory pair. Spans are read back from an in-memory exporter on
 * the global provider, as a host would wire it.
 */

interface FixtureSpan {
  file: string;
  name: string;
  kind: number;
  method: string;
  keys: string[];
}

const FIXTURE_DIR = fileURLToPath(
  new URL("../../../telemetry/conformance/mcp-server/", import.meta.url),
);
const SERVER_KIND = 2; // OTLP SPAN_KIND_SERVER
const CLIENT_NAME = "claude-code";
const CLIENT_VERSION = "2.1.3";
const USER_AGENT = "claude-code/2.1.3 (external, cli)";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let exporter: InMemorySpanExporter;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setContentCapture(null);
  trace.disable();
  context.disable();
  propagation.disable();
});

describe("instrumentMcpServer contract (ratel-cloud client-facts fixtures)", () => {
  const fixtures = loadFixtureSpans();

  it("loads the copied fixtures", () => {
    const methods = new Set(fixtures.map((span) => span.method));
    expect([...methods].sort()).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/list",
    ]);
  });

  for (const transport of ["http", "stdio"] as const) {
    const prefix = transport === "http" ? "ts-http-" : "py-stdio-";
    it(`emits every fixture MCP span shape and key over ${transport}`, async () => {
      const client =
        transport === "http"
          ? await connectHttp(buildMcpServer())
          : await connectStdio(buildMcpServer());
      await client.callTool({ name: "get_forecast", arguments: { city: "Rome" } });
      await client.callTool({ name: "search_notes", arguments: { query: "otel" } });
      await client.listTools();

      for (const expected of fixtures.filter((span) => span.file.startsWith(prefix))) {
        const ours = mcpSpans().find((span) => span.name === expected.name);
        expect(ours, `${expected.file}: span ${expected.name}`).toBeDefined();
        expect(ours?.kind).toBe(SpanKind.SERVER);
        expect(SpanKind.SERVER).toBe(expected.kind - 1); // OTLP kind is API kind + 1
        const keys = Object.keys(ours?.attributes ?? {});
        for (const key of [...expected.keys, "mcp.client.name", "mcp.client.version"]) {
          expect(keys, `${expected.file}: ${expected.name} lacks ${key}`).toContain(key);
        }
        if (expected.method === "initialize") {
          expect(keys).toEqual(expect.arrayContaining(["mcp.server.name", "mcp.server.version"]));
        }
      }
    });
  }
});

describe("instrumentMcpServer", () => {
  it("records the initialize facts: client, server and protocol version", async () => {
    const client = await connectInMemory(buildMcpServer());
    await client.listTools();

    const init = spanNamed("initialize");
    expect(init.attributes).toMatchObject({
      "mcp.method.name": "initialize",
      "jsonrpc.request.id": "0",
      "mcp.client.name": CLIENT_NAME,
      "mcp.client.version": CLIENT_VERSION,
      "mcp.server.name": "weather-mcp",
      "mcp.server.version": "1.0.0",
      "mcp.protocol.version": expect.any(String),
    });
    const notification = spanNamed("notifications/initialized");
    expect(notification.attributes["jsonrpc.request.id"]).toBeUndefined();
    expect(notification.kind).toBe(SpanKind.SERVER);
  });

  it("puts the session id and the client name and version on tools/call", async () => {
    const client = await connectInMemory(buildMcpServer());
    await client.callTool({ name: "get_forecast", arguments: {} });

    const call = spanNamed("tools/call get_forecast");
    expect(call.attributes).toMatchObject({
      "mcp.method.name": "tools/call",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "get_forecast",
      "mcp.client.name": CLIENT_NAME,
      "mcp.client.version": CLIENT_VERSION,
      "mcp.session.id": expect.stringMatching(UUID),
    });
    expect(call.attributes["mcp.session.id"]).toBe(
      spanNamed("initialize").attributes["mcp.session.id"],
    );
  });

  it("marks stdio as a pipe with one generated session id per connection", async () => {
    const first = await connectStdio(buildMcpServer());
    await first.listTools();
    const second = await connectStdio(buildMcpServer());
    await second.listTools();

    const spans = mcpSpans();
    expect(spans.every((span) => span.attributes["network.transport"] === "pipe")).toBe(true);
    expect(spans.every((span) => span.attributes["network.protocol.name"] === undefined)).toBe(
      true,
    );
    const sessions = new Set(spans.map((span) => span.attributes["mcp.session.id"]));
    expect(sessions.size).toBe(2);
    for (const session of sessions) expect(session).toMatch(UUID);
  });

  it("reads HTTP facts: transport session id, tcp, http and the User-Agent, no client.address", async () => {
    const client = await connectHttp(buildMcpServer());
    await client.callTool({ name: "get_forecast", arguments: {} });

    const spans = mcpSpans();
    expect(spans.length).toBeGreaterThanOrEqual(3);
    for (const span of spans) {
      expect(span.attributes).toMatchObject({
        "network.transport": "tcp",
        "network.protocol.name": "http",
        "user_agent.original": USER_AGENT,
        "mcp.session.id": (client.transport as StreamableHTTPClientTransport).sessionId,
      });
      expect(span.attributes["client.address"]).toBeUndefined();
    }
  });

  it("records client.address only with captureClientAddress", async () => {
    const client = await connectHttp(buildMcpServer(), { captureClientAddress: true });
    await client.callTool({ name: "get_forecast", arguments: {} });

    for (const span of mcpSpans()) {
      expect(span.attributes["client.address"]).toBe("127.0.0.1");
    }
  });

  it("captures no tool arguments or results by default", async () => {
    const client = await connectInMemory(buildLowLevelServer());
    await client.callTool({ name: "echo", arguments: { secret: "s3cr3t" } });

    const call = spanNamed("tools/call echo");
    expect(call.attributes["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(call.attributes["gen_ai.tool.call.result"]).toBeUndefined();
    expect(JSON.stringify(call.attributes)).not.toContain("s3cr3t");
  });

  it("captures tool arguments and results when content capture allows spans", async () => {
    setContentCapture(ContentCapture.SpanOnly);
    const client = await connectInMemory(buildLowLevelServer());
    await client.callTool({ name: "echo", arguments: { secret: "s3cr3t" } });

    const call = spanNamed("tools/call echo");
    expect(JSON.parse(String(call.attributes["gen_ai.tool.call.arguments"]))).toEqual({
      secret: "s3cr3t",
    });
    expect(JSON.parse(String(call.attributes["gen_ai.tool.call.result"]))).toMatchObject({
      content: [{ type: "text", text: '{"secret":"s3cr3t"}' }],
    });
  });

  it("works on the low-level Server", async () => {
    const client = await connectInMemory(buildLowLevelServer());
    await client.callTool({ name: "echo", arguments: {} });

    expect(spanNamed("initialize").attributes["mcp.server.name"]).toBe("low-level");
    expect(spanNamed("tools/call echo").attributes["mcp.client.name"]).toBe(CLIENT_NAME);
  });

  it("marks a tool result with isError as tool_error", async () => {
    const client = await connectInMemory(buildLowLevelServer());
    await client.callTool({ name: "fail", arguments: {} });

    const call = spanNamed("tools/call fail");
    expect(call.attributes["error.type"]).toBe("tool_error");
    expect(call.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("marks a JSON-RPC error with its code", async () => {
    const client = await connectInMemory(buildLowLevelServer());
    await expect(client.listPrompts()).rejects.toThrow();

    const span = spanNamed("prompts/list");
    expect(span.attributes["error.type"]).toBe("-32601");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("makes the request span the parent of spans the handler starts", async () => {
    const client = await connectInMemory(buildLowLevelServer());
    await client.callTool({ name: "nested", arguments: {} });

    const call = spanNamed("tools/call nested");
    const child = exporter.getFinishedSpans().find((span) => span.name === "inner work");
    expect(child?.parentSpanContext?.spanId).toBe(call.spanContext().spanId);
  });

  it("continues a traceparent sent in params._meta", async () => {
    propagation.setGlobalPropagator(traceparentPropagator());
    const client = await connectInMemory(buildLowLevelServer());
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    await client.callTool({
      name: "echo",
      arguments: {},
      _meta: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });

    const call = spanNamed("tools/call echo");
    expect(call.spanContext().traceId).toBe(traceId);
    expect(call.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
  });

  it("adds its attributes to another instrumentation's active MCP span instead of a second span", async () => {
    const server = instrumentMcpServer(buildMcpServer());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    otherInstrumentation(serverTransport);
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
    await client.connect(clientTransport);
    cleanups.push(() => client.close());
    await client.callTool({ name: "get_forecast", arguments: {} });

    const spans = exporter.getFinishedSpans();
    expect(spans.filter((span) => span.instrumentationScope.name === "@ratel-ai/sdk")).toEqual([]);
    const call = spans.find((span) => span.name === "other tools/call");
    expect(call?.attributes).toMatchObject({
      "mcp.client.name": CLIENT_NAME,
      "mcp.session.id": expect.stringMatching(UUID),
      "gen_ai.tool.name": "get_forecast",
    });
    const init = spans.find((span) => span.name === "other initialize");
    expect(init?.attributes["mcp.server.name"]).toBe("weather-mcp");
  });

  it("is idempotent: wrapping twice emits one span per message", async () => {
    const server = buildMcpServer();
    instrumentMcpServer(server);
    expect(instrumentMcpServer(server)).toBe(server);
    const client = await connectInMemory(server, { skipInstrument: true });
    await client.listTools();

    expect(mcpSpans().filter((span) => span.name === "tools/list")).toHaveLength(1);
    expect(mcpSpans().filter((span) => span.name === "initialize")).toHaveLength(1);
  });
});

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "weather-mcp", version: "1.0.0" });
  for (const name of ["get_forecast", "search_notes"]) {
    server.registerTool(name, { description: `The ${name} tool.` }, async () => ({
      content: [{ type: "text", text: "sunny" }],
    }));
  }
  return server;
}

function buildLowLevelServer(): Server {
  const server = new Server(
    { name: "low-level", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ["echo", "fail", "nested"].map((name) => ({
      name,
      inputSchema: { type: "object" as const },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "fail") return { content: [{ type: "text", text: "no" }], isError: true };
    if (name === "nested") {
      trace.getTracer("test").startSpan("inner work").end();
    }
    return { content: [{ type: "text", text: JSON.stringify(args ?? {}) }] };
  });
  return server;
}

async function connectInMemory(
  server: McpServer | Server,
  { skipInstrument = false } = {},
): Promise<Client> {
  const wrapped = skipInstrument ? server : instrumentMcpServer(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await wrapped.connect(serverTransport);
  return connectClient(clientTransport);
}

async function connectStdio(server: McpServer): Promise<Client> {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  await instrumentMcpServer(server).connect(new StdioServerTransport(toServer, toClient));
  return connectClient(new PipeClientTransport(toClient, toServer));
}

async function connectHttp(
  server: McpServer,
  options: Parameters<typeof instrumentMcpServer>[1] = {},
): Promise<Client> {
  let transport: StreamableHTTPServerTransport | undefined;
  const httpServer: HttpServer = createServer(async (req, res) => {
    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
      await instrumentMcpServer(server, options).connect(transport);
    }
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await transport?.close();
    httpServer.closeAllConnections();
    await new Promise((resolve) => httpServer.close(resolve));
  });
  const { port } = httpServer.address() as AddressInfo;
  return connectClient(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { "User-Agent": USER_AGENT } },
    }),
  );
}

async function connectClient(transport: Transport): Promise<Client> {
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

/** The client half of a stdio connection, on in-process streams instead of a child process. */
class PipeClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly buffer = new ReadBuffer();

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  async start(): Promise<void> {
    this.input.on("data", (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage()) {
        this.onmessage?.(message);
      }
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.output.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

/**
 * A fake third-party MCP instrumentation: it wraps the transport after the
 * Ratel wrapper did, so its SERVER span is active when Ratel sees the message,
 * and ends the span when the response goes out.
 */
function otherInstrumentation(transport: Transport): void {
  const tracer = trace.getTracer("other-mcp-instrumentation");
  const open = new Map<string | number, Span>();
  const deliver = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if (!("method" in message)) return deliver?.(message, extra);
    const span = tracer.startSpan(`other ${message.method}`, {
      kind: SpanKind.SERVER,
      attributes: { "mcp.method.name": message.method },
    });
    context.with(trace.setSpan(context.active(), span), () => deliver?.(message, extra));
    if ("id" in message) open.set(message.id, span);
    else span.end();
  };
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    await send(message, options);
    if ("id" in message && !("method" in message)) {
      open.get(message.id)?.end();
      open.delete(message.id);
    }
  };
}

/** The W3C `traceparent` half of a propagator, enough for the test host. */
function traceparentPropagator(): TextMapPropagator {
  return {
    inject: () => {},
    extract(ctx: Context, carrier: unknown): Context {
      const header = (carrier as Record<string, unknown>).traceparent;
      const match =
        typeof header === "string" &&
        /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header);
      if (!match) return ctx;
      return trace.setSpanContext(ctx, {
        traceId: match[1] as string,
        spanId: match[2] as string,
        traceFlags: Number.parseInt(match[3] as string, 16),
        isRemote: true,
      });
    },
    fields: () => ["traceparent"],
  };
}

function mcpSpans(): ReadableSpan[] {
  return exporter
    .getFinishedSpans()
    .filter((span) => span.instrumentationScope.name === "@ratel-ai/sdk")
    .filter((span) => span.attributes["mcp.method.name"] !== undefined);
}

function spanNamed(name: string): ReadableSpan {
  const span = mcpSpans().find((candidate) => candidate.name === name);
  if (!span) throw new Error(`no MCP span named ${name}: ${mcpSpans().map((s) => s.name)}`);
  return span;
}

function loadFixtureSpans(): FixtureSpan[] {
  const out: FixtureSpan[] = [];
  for (const file of readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".otlp.json"))) {
    const body = JSON.parse(readFileSync(`${FIXTURE_DIR}${file}`, "utf8")) as OtlpBody;
    for (const span of body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((s) => s.spans))) {
      const method = span.attributes.find((attr) => attr.key === "mcp.method.name");
      if (span.kind !== SERVER_KIND || !method) continue;
      out.push({
        file,
        name: span.name,
        kind: span.kind,
        method: String(method.value.stringValue),
        keys: span.attributes.map((attr) => attr.key),
      });
    }
  }
  return out;
}

interface OtlpBody {
  resourceSpans: Array<{
    scopeSpans: Array<{
      spans: Array<{
        name: string;
        kind: number;
        attributes: Array<{ key: string; value: { stringValue?: string } }>;
      }>;
    }>;
  }>;
}
