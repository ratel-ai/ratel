import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { INVOKE_TOOL_ID, registerMcpServer, SEARCH_TOOLS_ID, ToolCatalog } from "@ratel-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { createMcpServer } from "./server.js";
import { AUTH_TOOL_ID } from "./tools/auth.js";

interface UpstreamToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  handler?: (args: Record<string, unknown>) => unknown;
}

async function startUpstreamMcp(tools: UpstreamToolSpec[]) {
  const server = new Server(
    { name: "fake-upstream", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: "object" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const spec = tools.find((t) => t.name === req.params.name);
    if (!spec) throw new Error(`unknown upstream tool: ${req.params.name}`);
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const out = await (spec.handler ?? ((a) => a))(args);
    return {
      content: [{ type: "text", text: JSON.stringify(out) }],
      structuredContent: out as Record<string, unknown>,
    };
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport };
}

async function buildClientAgainst(catalog: ToolCatalog) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const handle = await createMcpServer(catalog, {
    name: "ratel-test",
    version: "0.0.0",
    transport: serverTransport,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, handle };
}

function localTool(
  id: string,
  description: string,
  execute: (args: Record<string, unknown>) => unknown,
) {
  return {
    id,
    name: id,
    description,
    inputSchema: {
      type: "object",
      properties: { msg: { type: "string" } },
    } as Record<string, unknown>,
    outputSchema: { type: "object" } as Record<string, unknown>,
    execute,
  };
}

describe("createMcpServer", () => {
  it("includes upstreamServers in the instructions so hosts see what's reachable behind Ratel", async () => {
    const catalog = new ToolCatalog();

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await createMcpServer(catalog, {
      name: "ratel-test",
      version: "0.0.0",
      transport: serverTransport,
      upstreamServers: [
        { name: "ev", description: "everything server", toolCount: 13 },
        { name: "bare" },
      ],
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const instructions = client.getInstructions();
    expect(instructions).toContain("- ev — everything server (13 tools)");
    expect(instructions).toMatch(/- bare\b/);

    await client.close();
    await handle.close();
  });

  it("announces prescriptive server-level instructions even with no upstreams", async () => {
    const catalog = new ToolCatalog();

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await createMcpServer(catalog, {
      name: "ratel-test",
      version: "0.0.0",
      transport: serverTransport,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions).toMatch(/search_tools/);
    expect(instructions?.toLowerCase()).toMatch(/before/);

    await client.close();
    await handle.close();
  });

  it("forwards upstreamServers into the listed search_tools description", async () => {
    const catalog = new ToolCatalog();

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await createMcpServer(catalog, {
      name: "ratel-test",
      version: "0.0.0",
      transport: serverTransport,
      upstreamServers: [
        { name: "ev", description: "everything server", toolCount: 13 },
        { name: "bare" },
      ],
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const searchTool = tools.find((t) => t.name === SEARCH_TOOLS_ID);
    expect(searchTool?.description).toContain("upstream MCP servers");
    expect(searchTool?.description).toContain("- ev — everything server (13 tools)");
    expect(searchTool?.description).toMatch(/- bare\b/);

    await client.close();
    await handle.close();
  });

  it("exposes exactly search_tools and invoke_tool via tools/list", async () => {
    const catalog = new ToolCatalog();
    catalog.register(localTool("echo", "Echo a message back to the caller.", (a) => a));

    const { client, handle } = await buildClientAgainst(catalog);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([SEARCH_TOOLS_ID, INVOKE_TOOL_ID].sort());

    await client.close();
    await handle.close();
  });

  it("search_tools roundtrips BM25 hits grouped by upstream MCP", async () => {
    const catalog = new ToolCatalog();
    catalog.register(
      localTool("wx__weather", "Get the current weather forecast for a city.", () => ({})),
    );
    catalog.register(localTool("util__echo", "Echo a message back to the caller.", (a) => a));

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await createMcpServer(catalog, {
      name: "ratel-test",
      version: "0.0.0",
      transport: serverTransport,
      upstreamServers: [
        { name: "wx", description: "Weather server", toolCount: 1 },
        { name: "util", toolCount: 1 },
      ],
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: SEARCH_TOOLS_ID,
      arguments: { query: "weather forecast" },
    });

    const structured = result.structuredContent as {
      groups: Array<{
        server: { name: string; description?: string; instructions?: string };
        hits: Array<{ toolId: string }>;
      }>;
    };
    expect(structured.groups[0].server.name).toBe("wx");
    expect(structured.groups[0].server.description).toBe("Weather server");
    expect(structured.groups[0].hits[0].toolId).toBe("wx__weather");

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].type).toBe("text");
    const parsed = JSON.parse(content[0].text) as {
      groups: Array<{ server: { name: string }; hits: Array<{ toolId: string }> }>;
    };
    expect(parsed.groups[0].hits[0].toolId).toBe("wx__weather");

    await client.close();
    await handle.close();
  });

  it("search_tools surfaces the upstream's official `instructions` on each group, separately from any user description", async () => {
    const catalog = new ToolCatalog();
    catalog.register(
      localTool("wx__weather", "Get the current weather forecast for a city.", () => ({})),
    );

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await createMcpServer(catalog, {
      name: "ratel-test",
      version: "0.0.0",
      transport: serverTransport,
      upstreamServers: [
        {
          name: "wx",
          description: "Weather server",
          instructions: "Use this for weather. Coordinates must be ISO-6709.",
          toolCount: 1,
        },
      ],
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: SEARCH_TOOLS_ID,
      arguments: { query: "weather forecast" },
    });
    const structured = result.structuredContent as {
      groups: Array<{
        server: { name: string; description?: string; instructions?: string };
      }>;
    };
    expect(structured.groups[0].server.description).toBe("Weather server");
    expect(structured.groups[0].server.instructions).toBe(
      "Use this for weather. Coordinates must be ISO-6709.",
    );

    await client.close();
    await handle.close();
  });

  it("invoke_tool runs a locally-registered tool and returns its output as structuredContent", async () => {
    const catalog = new ToolCatalog();
    catalog.register(
      localTool("upper", "Uppercase a message.", (a) => ({
        upper: ((a as { msg: string }).msg ?? "").toUpperCase(),
      })),
    );

    const { client, handle } = await buildClientAgainst(catalog);
    const result = await client.callTool({
      name: INVOKE_TOOL_ID,
      arguments: { toolId: "upper", args: { msg: "hi" } },
    });

    expect(result.structuredContent).toEqual({ upper: "HI" });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text)).toEqual({ upper: "HI" });

    await client.close();
    await handle.close();
  });

  it("invoke_tool with an unknown toolId returns the gateway's error payload", async () => {
    const catalog = new ToolCatalog();
    const { client, handle } = await buildClientAgainst(catalog);

    const result = await client.callTool({
      name: INVOKE_TOOL_ID,
      arguments: { toolId: "nope", args: {} },
    });

    const payload = result.structuredContent as { error?: string };
    expect(payload.error).toMatch(/unknown toolId: nope/);

    await client.close();
    await handle.close();
  });

  it("invoke_tool surfaces the gateway's wrapped error when the executor throws", async () => {
    const catalog = new ToolCatalog();
    catalog.register(
      localTool("boom", "Always throws.", () => {
        throw new Error("kaboom");
      }),
    );

    const { client, handle } = await buildClientAgainst(catalog);
    const result = await client.callTool({
      name: INVOKE_TOOL_ID,
      arguments: { toolId: "boom", args: {} },
    });

    const payload = result.structuredContent as { error?: string };
    expect(payload.error).toMatch(/boom threw: kaboom/);

    await client.close();
    await handle.close();
  });

  it("close() tears down the connection so subsequent calls reject", async () => {
    const catalog = new ToolCatalog();
    catalog.register(localTool("echo", "Echo.", (a) => a));

    const { client, handle } = await buildClientAgainst(catalog);
    await handle.close();

    await expect(
      client.callTool({ name: SEARCH_TOOLS_ID, arguments: { query: "x" } }),
    ).rejects.toThrow();

    await client.close();
  });

  it("registers the `auth` tool only when runAuthFlow is provided", async () => {
    const catalog = new ToolCatalog();

    // Without runAuthFlow → auth tool absent.
    const a = await buildClientAgainst(catalog);
    const noAuth = await a.client.listTools();
    expect(noAuth.tools.map((t) => t.name)).not.toContain(AUTH_TOOL_ID);
    await a.client.close();
    await a.handle.close();

    // With runAuthFlow → auth tool present.
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await createMcpServer(catalog, {
      name: "ratel-test",
      version: "0.0.0",
      transport: serverTransport,
      runAuthFlow: async () => [],
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain(AUTH_TOOL_ID);
    await client.close();
    await handle.close();
  });

  it("auth tool description reflects upstreams currently flagged needsAuth", async () => {
    const catalog = new ToolCatalog();
    const upstreams = [
      { name: "stripe", needsAuth: true },
      { name: "fs", toolCount: 2 },
    ];

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await createMcpServer(catalog, {
      name: "ratel-test",
      version: "0.0.0",
      transport: serverTransport,
      upstreamServers: upstreams,
      runAuthFlow: async () => [],
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const authToolDescription = tools.find((t) => t.name === AUTH_TOOL_ID)?.description;
    expect(authToolDescription).toMatch(/Currently needs auth: stripe/);
    expect(authToolDescription).not.toMatch(/fs/);

    await client.close();
    await handle.close();
  });

  it("auth tool routes calls to the supplied runAuthFlow and returns its results", async () => {
    const catalog = new ToolCatalog();
    const runAuthFlow = vi.fn(async () => [{ name: "stripe", status: "authorized" as const }]);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await createMcpServer(catalog, {
      name: "ratel-test",
      version: "0.0.0",
      transport: serverTransport,
      runAuthFlow,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: AUTH_TOOL_ID,
      arguments: { name: "stripe" },
    });
    expect(runAuthFlow).toHaveBeenCalledWith({ name: "stripe" });
    const payload = result.structuredContent as {
      results: Array<{ name: string; status: string }>;
    };
    expect(payload.results).toEqual([{ name: "stripe", status: "authorized" }]);

    await client.close();
    await handle.close();
  });

  it("notifyToolListChanged emits notifications/tools/list_changed to connected hosts", async () => {
    const catalog = new ToolCatalog();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await createMcpServer(catalog, {
      name: "ratel-test",
      version: "0.0.0",
      transport: serverTransport,
      runAuthFlow: async () => [],
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const observed: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      observed.push("changed");
    });

    await handle.notifyToolListChanged();
    // Allow event-loop tick for the in-memory transport to deliver the notification.
    await new Promise((r) => setTimeout(r, 5));
    expect(observed).toEqual(["changed"]);

    await client.close();
    await handle.close();
  });

  it("declares tools.listChanged in its server capabilities so hosts know to subscribe", async () => {
    const catalog = new ToolCatalog();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await createMcpServer(catalog, {
      name: "ratel-test",
      version: "0.0.0",
      transport: serverTransport,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const caps = client.getServerCapabilities();
    expect(caps?.tools).toMatchObject({ listChanged: true });

    await client.close();
    await handle.close();
  });

  it("invoke_tool flips needsAuth=true on the upstream and emits list_changed when the underlying tool throws UnauthorizedError", async () => {
    const catalog = new ToolCatalog();
    class UnauthorizedError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "UnauthorizedError";
      }
    }
    catalog.register({
      id: "stripe__charges",
      name: "stripe__charges",
      description: "...",
      inputSchema: {},
      outputSchema: {},
      execute: async () => {
        throw new UnauthorizedError("token expired");
      },
    });
    const upstreams = [{ name: "stripe", toolCount: 1 }];

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await createMcpServer(catalog, {
      name: "ratel-test",
      version: "0.0.0",
      transport: serverTransport,
      upstreamServers: upstreams,
      runAuthFlow: async () => [],
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const observed: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      observed.push("changed");
    });

    const result = await client.callTool({
      name: INVOKE_TOOL_ID,
      arguments: { toolId: "stripe__charges", args: {} },
    });
    const payload = result.structuredContent as { error: string; upstream?: string };
    expect(payload.error).toBe("needs_auth");
    expect(payload.upstream).toBe("stripe");
    expect(upstreams[0].needsAuth).toBe(true);

    await new Promise((r) => setTimeout(r, 5));
    expect(observed).toEqual(["changed"]);

    await client.close();
    await handle.close();
  });

  it("nests the upstream MCP CallToolResult inside structuredContent when invoke_tool drives an MCP-origin tool", async () => {
    // Documents the v0.1.2 wrapping artifact: tools registered via registerMcpServer
    // already return MCP-shaped results; uniform wrapping nests them one level deeper.
    const upstream = await startUpstreamMcp([
      {
        name: "read_file",
        description: "Read a file from disk.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        handler: ({ path }) => ({ contents: `contents of ${path as string}` }),
      },
    ]);

    const catalog = new ToolCatalog();
    const upstreamHandle = await registerMcpServer(catalog, {
      name: "demo",
      transport: upstream.clientTransport,
    });

    const { client, handle } = await buildClientAgainst(catalog);
    const result = await client.callTool({
      name: INVOKE_TOOL_ID,
      arguments: { toolId: "demo__read_file", args: { path: "/etc/hosts" } },
    });

    const nested = result.structuredContent as {
      structuredContent?: { contents?: string };
    };
    expect(nested.structuredContent?.contents).toBe("contents of /etc/hosts");

    await client.close();
    await handle.close();
    await upstreamHandle.close();
    await upstream.server.close();
  });
});
