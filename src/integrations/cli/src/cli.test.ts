import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AUTH_TOOL_ID } from "@ratel-ai/mcp-server";
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

describe("runCli — serve", () => {
  it("reads the config, builds the gateway, and exposes search_tools + invoke_tool over the given downstream transport", async () => {
    const upstream = await fakeUpstream();
    const [downstreamServerTransport, downstreamClientTransport] =
      InMemoryTransport.createLinkedPair();

    const { shutdown } = await runCli(["serve", "/fake/config.json"], {
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
    expect(tools.map((t) => t.name).sort()).toEqual(
      [SEARCH_TOOLS_ID, INVOKE_TOOL_ID, AUTH_TOOL_ID].sort(),
    );

    const search = await client.callTool({
      name: SEARCH_TOOLS_ID,
      arguments: { query: "ping" },
    });
    const text = (search.content as Array<{ text: string }>)[0].text;
    const parsed = JSON.parse(text) as {
      groups: Array<{ server: { name: string }; hits: Array<{ toolId: string }> }>;
    };
    expect(parsed.groups[0].server.name).toBe("up");
    expect(parsed.groups[0].hits[0].toolId).toBe("up__ping");

    await client.close();
    await shutdown?.();
    await upstream.server.close();
  });

  it("threads upstream descriptions and tool counts into search_tools' listed description", async () => {
    const upstream = await fakeUpstream();
    const [downstreamServerTransport, downstreamClientTransport] =
      InMemoryTransport.createLinkedPair();

    const { shutdown } = await runCli(["serve", "/fake/config.json"], {
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
    await shutdown?.();
    await upstream.server.close();
  });

  it("rejects when no config path is provided, with a usage message", async () => {
    await expect(runCli(["serve"], { logger: () => {} })).rejects.toThrow(/usage/i);
  });

  it("propagates a clear error when the config file cannot be read", async () => {
    await expect(
      runCli(["serve", "/missing.json"], {
        readConfig: async () => {
          throw new Error("ENOENT");
        },
        logger: () => {},
      }),
    ).rejects.toThrow(/ENOENT/);
  });

  it("propagates parseConfig errors with the field path when the JSON is malformed", async () => {
    await expect(
      runCli(["serve", "/bad.json"], {
        readConfig: async () => ({ mcpServers: { fs: { type: "stdio" } } }),
        logger: () => {},
      }),
    ).rejects.toThrow(/mcpServers\.fs\.command/);
  });

  it("logs a ready line to the injected logger after wiring", async () => {
    const upstream = await fakeUpstream();
    const [serverTransport] = InMemoryTransport.createLinkedPair();
    const logs: string[] = [];

    const { shutdown } = await runCli(["serve", "/x"], {
      readConfig: async () => ({
        mcpServers: { up: { type: "stdio", command: "noop" } },
      }),
      transportFactory: () => upstream.clientTransport,
      serverTransport,
      logger: (m) => logs.push(m),
    });

    expect(logs.some((m) => /ready/i.test(m))).toBe(true);

    await shutdown?.();
    await upstream.server.close();
  });

  it("merges repeated --config files (right-wins) before running the server", async () => {
    const upstream = await fakeUpstream();
    const [serverTransport] = InMemoryTransport.createLinkedPair();
    const reads: string[] = [];

    const { shutdown } = await runCli(["serve", "--config", "/a.json", "--config", "/b.json"], {
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

    await shutdown?.();
    await upstream.server.close();
  });
});

describe("runCli — help and routing", () => {
  it("--help logs a top-level usage that names the mcp and backup groups", async () => {
    const logs: string[] = [];
    await runCli(["--help"], { logger: (m) => logs.push(m) });
    const out = logs.join("\n");
    expect(out).toMatch(/mcp/);
    expect(out).toMatch(/backup/);
  });

  it("`ratel mcp` (no verb) logs the mcp group usage", async () => {
    const logs: string[] = [];
    await runCli(["mcp"], { logger: (m) => logs.push(m) });
    const out = logs.join("\n");
    expect(out).toMatch(/add/);
    expect(out).toMatch(/import/);
  });

  it("`ratel backup` (no verb) logs the backup group usage", async () => {
    const logs: string[] = [];
    await runCli(["backup"], { logger: (m) => logs.push(m) });
    const out = logs.join("\n");
    expect(out).toMatch(/list/);
  });

  it("rejects an unknown command with ArgError", async () => {
    await expect(runCli(["mcps"], { logger: () => {} })).rejects.toThrow(/mcps/);
  });

  it("rejects an unknown mcp verb", async () => {
    await expect(runCli(["mcp", "fly"], { logger: () => {} })).rejects.toThrow(/fly/);
  });

  it("rejects an unknown backup verb", async () => {
    await expect(runCli(["backup", "purge"], { logger: () => {} })).rejects.toThrow(/purge/);
  });
});
