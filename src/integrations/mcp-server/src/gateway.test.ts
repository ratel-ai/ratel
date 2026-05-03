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

async function startUpstream(tools: UpstreamSpec[]) {
  const server = new Server({ name: "fake", version: "0.0.0" }, { capabilities: { tools: {} } });
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

  it("close() tears down every upstream handle even if one rejects", async () => {
    const upstream = await startUpstream([{ name: "x", description: "x" }]);
    const handle = await buildGatewayFromConfig(
      { mcpServers: { up: { type: "stdio", command: "noop" } } },
      { transportFactory: () => upstream.clientTransport },
    );

    await expect(handle.close()).resolves.toBeUndefined();
    await upstream.server.close();
  });
});
