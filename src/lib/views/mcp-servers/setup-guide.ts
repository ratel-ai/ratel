import { MCP_SESSION_KEYS } from "@/lib/ingest/otlp/attr-resolve";
import {
  CLIENT_ADDRESS_KEYS,
  CLIENT_NAME_KEY,
  CLIENT_VERSION_KEY,
  PROTOCOL_VERSION_KEY,
  USER_AGENT_KEYS,
} from "@/lib/ingest/otlp/dimensions/client";
import { MCP_METHOD_KEY, SERVER_INFO_KEYS } from "@/lib/ingest/otlp/dimensions/mcp";

/**
 * How an MCP server author sends traces to Ratel with standard OpenTelemetry
 * only, no Ratel SDK (RC-780): the snippets, the fact table, the limits of the
 * standard path and how to send no client IP. The MCP servers page and the
 * Clients tab show it; `get_sdk_setup` returns it.
 *
 * The snippets were run against a local ingest on 2026-11-18: Python with
 * `mcp` 2.3.0 (native OpenTelemetry) and `opentelemetry-instrumentation-asgi`
 * 0.66b2; TypeScript with `@modelcontextprotocol/sdk` 1.32.2 (no native
 * OpenTelemetry, so the server wraps each request in a span) and
 * `@opentelemetry/sdk-node` 0.301.2. The fact table names the attribute keys
 * ingest reads (`lib/otlp/dimensions/`), imported from there so the two cannot
 * drift. Plain text, no em dashes.
 */

export type McpGuideLang = "python" | "typescript";

export interface McpGuideFile {
  /** A file name ("server.py"), or null for shell lines. */
  name: string | null;
  code: string;
}

export interface McpGuideSnippet {
  lang: McpGuideLang;
  label: string;
  install: string;
  files: McpGuideFile[];
  run: string;
}

/** Where a fact comes from: any OpenTelemetry setup, or only the Ratel SDK's MCP server wrapper. */
export type McpFactSource = "standard" | "sdk";

export interface McpFactRow {
  fact: string;
  attributes: string[];
  /** Which span carries it. */
  on: string;
  source: McpFactSource;
}

export interface McpServerGuide {
  env: string;
  snippets: McpGuideSnippet[];
  facts: McpFactRow[];
  limits: string[];
  noClientIp: { text: string; python: string; collector: string };
  whenSdk: string;
}

export interface McpServerGuideTarget {
  /** The full OTLP traces URL, `<origin>/v1/traces`. */
  tracesEndpoint: string;
  /** The `service.name` the snippets set: the MCP server's name in Ratel. */
  serviceName: string;
}

const lines = (...rows: string[]): string => rows.join("\n");

export const MCP_SERVER_FACTS: readonly McpFactRow[] = [
  {
    fact: "MCP server",
    attributes: ["service.name", ...SERVER_INFO_KEYS],
    on: "resource, else the MCP span",
    source: "standard",
  },
  {
    fact: "MCP request",
    attributes: [MCP_METHOD_KEY],
    on: "MCP span, kind SERVER",
    source: "standard",
  },
  {
    fact: "Tool",
    attributes: ["gen_ai.tool.name"],
    on: "MCP span (tools/call)",
    source: "standard",
  },
  { fact: "Session", attributes: [...MCP_SESSION_KEYS], on: "MCP span", source: "standard" },
  {
    fact: "Protocol version",
    attributes: [PROTOCOL_VERSION_KEY],
    on: "MCP span",
    source: "standard",
  },
  {
    fact: "Transport",
    attributes: ["network.transport"],
    on: "MCP span, or an HTTP server span in the trace",
    source: "standard",
  },
  {
    fact: "Client (guessed)",
    attributes: [...USER_AGENT_KEYS],
    on: "HTTP server span of the request",
    source: "standard",
  },
  {
    fact: "Country (from the client IP, which is not kept)",
    attributes: [...CLIENT_ADDRESS_KEYS],
    on: "HTTP server span or MCP span",
    source: "standard",
  },
  {
    fact: "Errors",
    attributes: ["error.type", "status ERROR"],
    on: "MCP span",
    source: "standard",
  },
  {
    fact: "Client (explicit)",
    attributes: [CLIENT_NAME_KEY, CLIENT_VERSION_KEY],
    on: "MCP span or the session's initialize span",
    source: "sdk",
  },
];

export const MCP_SERVER_LIMITS: readonly string[] = [
  "stdio has no IP and no User-Agent: Ratel shows the server, its tools and sessions, but the client is unknown and there is no country.",
  "Stateless HTTP has no session: each request counts as its own session, and a client is read per request from its User-Agent.",
  "The MCP Python SDK does not record mcp.session.id, so its calls count as one session per trace.",
  "A client guessed from the User-Agent shows the Guessed marker. Only mcp.client.name makes it explicit.",
];

/** The MCP servers guide for one project: the snippets carry its traces endpoint and a service name. */
export function buildMcpServerGuide({
  tracesEndpoint,
  serviceName,
}: McpServerGuideTarget): McpServerGuide {
  return {
    env: lines(
      `export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${tracesEndpoint}`,
      'export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20${RATEL_API_KEY}"',
    ),
    snippets: [pythonSnippet(serviceName), typescriptSnippet(serviceName)],
    facts: [...MCP_SERVER_FACTS],
    limits: [...MCP_SERVER_LIMITS],
    noClientIp: {
      text: "Ratel looks up the country of client.address when it is a public IP, then drops the IP: no table keeps it. To send no IP at all, keep the address off the spans; there is then no country. The client is still read from the User-Agent.",
      python: lines(
        "def without_client_ip(asgi_app):",
        "    async def wrapped(scope, receive, send):",
        '        await asgi_app({**scope, "client": None} if scope["type"] == "http" else scope, receive, send)',
        "",
        "    return wrapped",
        "",
        "",
        "app = without_client_ip(app)",
      ),
      collector: lines(
        "processors:",
        "  attributes/no-client-ip:",
        "    actions:",
        ...[...CLIENT_ADDRESS_KEYS, "network.peer.address"].flatMap((key) => [
          `      - key: ${key}`,
          "        action: delete",
        ]),
      ),
    },
    whenSdk:
      "Add the Ratel SDK's MCP server wrapper when you want the client named explicitly (it sets mcp.client.name and mcp.client.version from the initialize handshake), including over stdio, where no User-Agent exists.",
  };
}

function pythonSnippet(serviceName: string): McpGuideSnippet {
  return {
    lang: "python",
    label: "Python",
    install:
      'pip install "mcp>=2.3" opentelemetry-sdk opentelemetry-exporter-otlp-proto-http opentelemetry-instrumentation-asgi uvicorn',
    files: [
      {
        name: "server.py",
        code: lines(
          "import uvicorn",
          "from opentelemetry import trace",
          "from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter",
          "from opentelemetry.instrumentation.asgi import OpenTelemetryMiddleware",
          "from opentelemetry.sdk.resources import Resource",
          "from opentelemetry.sdk.trace import TracerProvider",
          "from opentelemetry.sdk.trace.export import BatchSpanProcessor",
          "from mcp.server.mcpserver import MCPServer",
          "",
          "# service.name is the MCP server's name in Ratel.",
          `provider = TracerProvider(resource=Resource.create({"service.name": ${JSON.stringify(serviceName)}}))`,
          "# Reads OTEL_EXPORTER_OTLP_TRACES_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS.",
          "provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))",
          "trace.set_tracer_provider(provider)",
          "",
          `mcp = MCPServer(${JSON.stringify(serviceName)})`,
          "",
          "",
          "@mcp.tool()",
          "def search_notes(query: str) -> str:",
          '    """Search the notes."""',
          '    return f"1 note about {query}"',
          "",
          "",
          "# The MCP SDK makes one span per MCP request. The ASGI middleware makes the",
          "# HTTP span around it, with the caller's User-Agent and address.",
          'app = OpenTelemetryMiddleware(mcp.streamable_http_app(), exclude_spans=["receive", "send"])',
          "",
          'if __name__ == "__main__":',
          '    uvicorn.run(app, host="127.0.0.1", port=8000)',
        ),
      },
    ],
    run: "python server.py",
  };
}

function typescriptSnippet(serviceName: string): McpGuideSnippet {
  return {
    lang: "typescript",
    label: "TypeScript",
    install:
      "npm install @modelcontextprotocol/sdk zod @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto @opentelemetry/instrumentation @opentelemetry/instrumentation-http",
    files: [
      {
        name: "tracing.ts",
        code: lines(
          'import { register } from "node:module";',
          'import { NodeSDK } from "@opentelemetry/sdk-node";',
          'import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";',
          'import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";',
          "",
          "// Lets the instrumentation patch modules loaded with `import`.",
          'register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);',
          "",
          "const sdk = new NodeSDK({",
          "  // service.name is the MCP server's name in Ratel.",
          `  serviceName: ${JSON.stringify(serviceName)},`,
          "  // Reads OTEL_EXPORTER_OTLP_TRACES_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS.",
          "  traceExporter: new OTLPTraceExporter(),",
          "  // The HTTP server span: the caller's User-Agent and address.",
          "  instrumentations: [new HttpInstrumentation()],",
          "});",
          "sdk.start();",
          'process.on("SIGTERM", () => sdk.shutdown().finally(() => process.exit(0)));',
        ),
      },
      {
        name: "server.ts",
        code: lines(
          'import http from "node:http";',
          'import { randomUUID } from "node:crypto";',
          'import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";',
          'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
          'import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";',
          'import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";',
          'import { z } from "zod";',
          "",
          `const tracer = trace.getTracer(${JSON.stringify(serviceName)});`,
          "const sessions = new Map<string, StreamableHTTPServerTransport>();",
          "",
          "function buildServer() {",
          `  const server = new McpServer({ name: ${JSON.stringify(serviceName)}, version: "1.0.0" });`,
          '  server.registerTool("get_forecast", { inputSchema: { city: z.string() } }, async ({ city }) => ({',
          '    content: [{ type: "text", text: `Sunny in ${city}` }],',
          "  }));",
          "  return server;",
          "}",
          "",
          "// One SERVER span per MCP request, named and tagged per the OTel MCP semantic conventions.",
          "function mcpSpan(req: http.IncomingMessage, res: http.ServerResponse, message: any, sessionId?: string) {",
          '  if (typeof message?.method !== "string") return;',
          '  const tool = message.method === "tools/call" ? message.params?.name : undefined;',
          '  const protocol = req.headers["mcp-protocol-version"] ?? message.params?.protocolVersion;',
          "  const span = tracer.startSpan(tool ? `tools/call ${tool}` : message.method, {",
          "    kind: SpanKind.SERVER,",
          "    attributes: {",
          '      "mcp.method.name": message.method,',
          '      "network.transport": "tcp",',
          '      ...(tool ? { "gen_ai.tool.name": tool, "gen_ai.operation.name": "execute_tool" } : {}),',
          '      ...(message.id !== undefined ? { "jsonrpc.request.id": String(message.id) } : {}),',
          '      ...(sessionId ? { "mcp.session.id": sessionId } : {}),',
          '      ...(protocol ? { "mcp.protocol.version": String(protocol) } : {}),',
          "    },",
          "  });",
          '  res.on("close", () => {',
          "    if (res.statusCode >= 400) span.setStatus({ code: SpanStatusCode.ERROR });",
          "    span.end();",
          "  });",
          "}",
          "",
          "const readBody = (req: http.IncomingMessage) =>",
          "  new Promise<any>((ok) => {",
          "    const chunks: Buffer[] = [];",
          '    req.on("data", (c) => chunks.push(c));',
          '    req.on("end", () => ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined));',
          "  });",
          "",
          "http",
          "  .createServer(async (req, res) => {",
          '    const body = req.method === "POST" ? await readBody(req) : undefined;',
          '    let sessionId = req.headers["mcp-session-id"] as string | undefined;',
          "    let transport = sessionId ? sessions.get(sessionId) : undefined;",
          "    if (!transport && isInitializeRequest(body)) {",
          "      const id = (sessionId = randomUUID());",
          "      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id, onsessioninitialized: (sid) => sessions.set(sid, transport!) });",
          "      await buildServer().connect(transport);",
          "    }",
          "    if (!transport) return void res.writeHead(400).end();",
          "    for (const message of [body].flat()) mcpSpan(req, res, message, sessionId);",
          "    await transport.handleRequest(req, res, body);",
          "  })",
          "  .listen(8001);",
        ),
      },
    ],
    run: "npx tsx --import ./tracing.ts server.ts",
  };
}
