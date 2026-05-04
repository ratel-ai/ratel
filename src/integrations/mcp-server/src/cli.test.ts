import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { INVOKE_TOOL_ID, SEARCH_TOOLS_ID } from "@ratel-ai/sdk";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

async function fakeUpstream() {
  const server = new Server({ name: "fake", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "ping", description: "Ping.", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport };
}

describe("runCli", () => {
  it("reads the config, builds the gateway, and exposes search_tools + invoke_tool over the given downstream transport", async () => {
    const upstream = await fakeUpstream();
    const [downstreamServerTransport, downstreamClientTransport] =
      InMemoryTransport.createLinkedPair();

    const { shutdown } = await runCli(["/fake/config.json"], {
      readConfig: async () => ({
        mcpServers: { up: { type: "stdio", command: "noop" } },
      }),
      transportFactory: () => upstream.clientTransport,
      serverTransport: downstreamServerTransport,
      logger: () => {},
    });

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(downstreamClientTransport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([SEARCH_TOOLS_ID, INVOKE_TOOL_ID].sort());

    const search = await client.callTool({
      name: SEARCH_TOOLS_ID,
      arguments: { query: "ping" },
    });
    const text = (search.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text)[0].toolId).toBe("up__ping");

    await client.close();
    await shutdown();
    await upstream.server.close();
  });

  it("threads upstream descriptions and tool counts into search_tools' listed description", async () => {
    const upstream = await fakeUpstream();
    const [downstreamServerTransport, downstreamClientTransport] =
      InMemoryTransport.createLinkedPair();

    const { shutdown } = await runCli(["/fake/config.json"], {
      readConfig: async () => ({
        mcpServers: {
          up: { type: "stdio", command: "noop", description: "ping server" },
        },
      }),
      transportFactory: () => upstream.clientTransport,
      serverTransport: downstreamServerTransport,
      logger: () => {},
    });

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(downstreamClientTransport);
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === SEARCH_TOOLS_ID);
    expect(search?.description).toContain("upstream MCP servers");
    expect(search?.description).toContain("- up — ping server (1 tools)");

    await client.close();
    if (shutdown) await shutdown();
    await upstream.server.close();
  });

  it("rejects when no config path is provided, with a usage message", async () => {
    await expect(runCli([])).rejects.toThrow(/usage/i);
  });

  it("propagates a clear error when the config file cannot be read", async () => {
    await expect(
      runCli(["/missing.json"], {
        readConfig: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toThrow(/ENOENT/);
  });

  it("propagates parseConfig errors with the field path when the JSON is malformed", async () => {
    await expect(
      runCli(["/bad.json"], {
        readConfig: async () => ({ mcpServers: { fs: { type: "stdio" } } }),
      }),
    ).rejects.toThrow(/mcpServers\.fs\.command/);
  });

  it("logs a ready line to the injected logger after wiring", async () => {
    const upstream = await fakeUpstream();
    const [serverTransport] = InMemoryTransport.createLinkedPair();
    const logs: string[] = [];

    const { shutdown } = await runCli(["/x"], {
      readConfig: async () => ({
        mcpServers: { up: { type: "stdio", command: "noop" } },
      }),
      transportFactory: () => upstream.clientTransport,
      serverTransport,
      logger: (m) => logs.push(m),
    });

    expect(logs.some((m) => /ready/i.test(m))).toBe(true);

    if (shutdown) await shutdown();
    await upstream.server.close();
  });

  it("merges repeated --config files (right-wins) before running the server", async () => {
    const upstream = await fakeUpstream();
    const [serverTransport] = InMemoryTransport.createLinkedPair();
    const reads: string[] = [];

    const { shutdown } = await runCli(["--config", "/a.json", "--config", "/b.json"], {
      readConfig: async (path) => {
        reads.push(path);
        if (path === "/a.json") {
          return { mcpServers: { up: { type: "stdio", command: "from-a" } } };
        }
        return { mcpServers: { up: { type: "stdio", command: "from-b" } } };
      },
      transportFactory: () => upstream.clientTransport,
      serverTransport,
      logger: () => {},
    });

    expect(reads).toEqual(["/a.json", "/b.json"]);

    if (shutdown) await shutdown();
    await upstream.server.close();
  });

  it("--help logs usage including every subcommand", async () => {
    const logs: string[] = [];
    await runCli(["--help"], { logger: (m) => logs.push(m) });
    const out = logs.join("\n");
    expect(out).toMatch(/import/);
    expect(out).toMatch(/add/);
    expect(out).toMatch(/remove/);
    expect(out).toMatch(/list/);
    expect(out).toMatch(/undo/);
  });

  it("rejects an unknown subcommand with ArgError", async () => {
    await expect(runCli(["importt"], { logger: () => {} })).rejects.toThrow(/importt/);
  });
});
