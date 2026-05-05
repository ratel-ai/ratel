import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { buildGatewayFromConfig } from "./gateway.js";

interface UpstreamSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

async function startUpstream(tools: UpstreamSpec[], instructions?: string) {
  const server = new Server(
    { name: "fake", version: "0.0.0" },
    { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: "text", text: JSON.stringify({ called: req.params.name }) }],
  }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport };
}

describe("buildGatewayFromConfig", () => {
  it("registers tools from every upstream the factory wires up, namespaced by entry key", async () => {
    const fs = await startUpstream([
      { name: "read_file", description: "Read a file from local disk." },
    ]);
    const remote = await startUpstream([{ name: "fetch", description: "Fetch a URL over HTTP." }]);
    const transports: Record<string, Transport> = {
      fs: fs.clientTransport,
      remote: remote.clientTransport,
    };

    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          fs: { type: "stdio", command: "noop" },
          remote: { type: "http", url: "https://example.com" },
        },
      },
      { transportFactory: (name) => transports[name] },
    );

    expect(handle.catalog.has("fs__read_file")).toBe(true);
    expect(handle.catalog.has("remote__fetch")).toBe(true);

    await handle.close();
    await fs.server.close();
    await remote.server.close();
  });

  it("skips entries with unsupported transport types and logs a warning", async () => {
    const logs: string[] = [];
    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          legacy: { type: "sse", url: "https://x" },
          future: { type: "websocket", url: "ws://x" },
        },
      },
      { transportFactory: () => undefined, logger: (m) => logs.push(m) },
    );

    expect(handle.catalog.has("legacy__anything")).toBe(false);
    expect(logs.join("\n")).toMatch(/legacy/);
    expect(logs.join("\n")).toMatch(/future/);

    await handle.close();
  });

  it("warns and continues when one upstream fails to register, leaving the rest available", async () => {
    const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
    const logs: string[] = [];

    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          broken: { type: "stdio", command: "noop" },
          ok: { type: "stdio", command: "noop" },
        },
      },
      {
        transportFactory: (name) => {
          if (name === "broken") {
            throw new Error("boom");
          }
          return ok.clientTransport;
        },
        logger: (m) => logs.push(m),
      },
    );

    expect(handle.catalog.has("ok__ping")).toBe(true);
    expect(handle.catalog.has("broken__ping")).toBe(false);
    expect(logs.join("\n")).toMatch(/broken.*boom/);

    await handle.close();
    await ok.server.close();
  });

  it("returns an empty catalog when every entry fails to register", async () => {
    const logs: string[] = [];
    const handle = await buildGatewayFromConfig(
      {
        mcpServers: { a: { type: "stdio", command: "noop" } },
      },
      {
        transportFactory: () => {
          throw new Error("nope");
        },
        logger: (m) => logs.push(m),
      },
    );

    expect(handle.catalog.search("anything", 5)).toEqual([]);
    expect(logs.length).toBeGreaterThan(0);

    await handle.close();
  });

  it("exposes upstreamServers with name, description from config, and tool count", async () => {
    const fs = await startUpstream([
      { name: "read_file", description: "Read a file." },
      { name: "write_file", description: "Write a file." },
    ]);
    const remote = await startUpstream([{ name: "fetch", description: "Fetch a URL." }]);
    const transports: Record<string, Transport> = {
      fs: fs.clientTransport,
      remote: remote.clientTransport,
    };

    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          fs: { type: "stdio", command: "noop", description: "filesystem tools" },
          remote: { type: "http", url: "https://example.com" },
        },
      },
      { transportFactory: (name) => transports[name] },
    );

    expect(handle.upstreamServers).toEqual([
      { name: "fs", description: "filesystem tools", toolCount: 2 },
      { name: "remote", toolCount: 1 },
    ]);

    await handle.close();
    await fs.server.close();
    await remote.server.close();
  });

  it("omits failed upstreams from upstreamServers", async () => {
    const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          broken: { type: "stdio", command: "noop", description: "broken one" },
          ok: { type: "stdio", command: "noop" },
          unsupported: { type: "websocket", url: "ws://x" },
        },
      },
      {
        transportFactory: (name) => {
          if (name === "broken") throw new Error("boom");
          if (name === "ok") return ok.clientTransport;
          return undefined;
        },
        logger: () => {},
      },
    );

    expect(handle.upstreamServers).toEqual([{ name: "ok", toolCount: 1 }]);

    await handle.close();
    await ok.server.close();
  });

  it("falls back to the upstream's `instructions` when no description is set on the config entry", async () => {
    const fs = await startUpstream(
      [{ name: "ping", description: "Ping." }],
      "Use this server for filesystem ops.",
    );
    const handle = await buildGatewayFromConfig(
      { mcpServers: { fs: { type: "stdio", command: "noop" } } },
      { transportFactory: () => fs.clientTransport },
    );
    expect(handle.upstreamServers).toEqual([
      {
        name: "fs",
        description: "Use this server for filesystem ops.",
        instructions: "Use this server for filesystem ops.",
        toolCount: 1,
      },
    ]);
    await handle.close();
    await fs.server.close();
  });

  it("prefers the config entry's description over the upstream's `instructions` when both are present, but still surfaces the raw instructions separately", async () => {
    const fs = await startUpstream([{ name: "ping", description: "Ping." }], "from-upstream");
    const handle = await buildGatewayFromConfig(
      {
        mcpServers: { fs: { type: "stdio", command: "noop", description: "from-config" } },
      },
      { transportFactory: () => fs.clientTransport },
    );
    expect(handle.upstreamServers[0].description).toBe("from-config");
    expect(handle.upstreamServers[0].instructions).toBe("from-upstream");
    await handle.close();
    await fs.server.close();
  });

  it("omits both description and instructions when neither config nor upstream provide them", async () => {
    const fs = await startUpstream([{ name: "ping", description: "Ping." }]);
    const handle = await buildGatewayFromConfig(
      { mcpServers: { fs: { type: "stdio", command: "noop" } } },
      { transportFactory: () => fs.clientTransport },
    );
    expect(handle.upstreamServers[0].description).toBeUndefined();
    expect(handle.upstreamServers[0].instructions).toBeUndefined();
    await handle.close();
    await fs.server.close();
  });

  it("close() tears down every upstream handle even if one rejects", async () => {
    const upstream = await startUpstream([{ name: "x", description: "x" }]);
    const handle = await buildGatewayFromConfig(
      { mcpServers: { up: { type: "stdio", command: "noop" } } },
      { transportFactory: () => upstream.clientTransport },
    );

    await expect(handle.close()).resolves.toBeUndefined();
    await upstream.server.close();
  });

  it("flags HTTP upstreams as needsAuth when boot register throws UnauthorizedError, retaining the entry for re-auth", async () => {
    const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
    const logs: string[] = [];

    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          locked: { type: "http", url: "https://locked.example/mcp" },
          fs: { type: "stdio", command: "noop" },
        },
      },
      {
        transportFactory: (name) => {
          if (name === "fs") return ok.clientTransport;
          // For the http entry, return a transport whose start() throws Unauthorized
          return {
            async start() {
              throw new UnauthorizedError("missing tokens");
            },
            async send() {},
            async close() {},
          };
        },
        logger: (m) => logs.push(m),
      },
    );

    expect(handle.upstreamServers).toContainEqual(
      expect.objectContaining({ name: "locked", needsAuth: true }),
    );
    expect(handle.upstreamServers).toContainEqual(
      expect.objectContaining({ name: "fs", toolCount: 1 }),
    );
    expect(handle.catalog.has("fs__ping")).toBe(true);

    await handle.close();
    await ok.server.close();
  });

  it("exposes a runAuthFlow function on the handle", async () => {
    const handle = await buildGatewayFromConfig(
      { mcpServers: {} },
      { transportFactory: () => undefined },
    );
    expect(typeof handle.runAuthFlow).toBe("function");
    // Without any http upstreams, runs no targets and returns empty.
    const results = await handle.runAuthFlow({});
    expect(results).toEqual([]);
    await handle.close();
  });
});
