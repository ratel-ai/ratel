import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerMcpServer, ToolCatalog } from "./index.js";

interface ServerToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  handler?: (args: Record<string, unknown>) => unknown;
}

interface FakeMcp {
  server: Server;
  clientTransport: InMemoryTransport;
}

async function startFakeMcpServer(
  tools: ServerToolSpec[],
  serverOptions?: { instructions?: string },
): Promise<FakeMcp> {
  const server = new Server(
    { name: "fake-mcp", version: "0.0.0" },
    {
      capabilities: { tools: {} },
      ...(serverOptions?.instructions ? { instructions: serverOptions.instructions } : {}),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: "object" },
      ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const spec = tools.find((t) => t.name === req.params.name);
    if (!spec) {
      throw new Error(`unknown tool: ${req.params.name}`);
    }
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

describe("registerMcpServer", () => {
  let fake: FakeMcp;

  beforeEach(async () => {
    fake = await startFakeMcpServer([
      {
        name: "read_file",
        description: "Read a file from the local disk and return its textual contents.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "absolute path to the file" } },
          required: ["path"],
        },
        outputSchema: {
          type: "object",
          properties: { contents: { type: "string" } },
        },
        handler: ({ path }) => ({ contents: `contents of ${path as string}` }),
      },
    ]);
  });

  afterEach(async () => {
    await fake.server.close();
  });

  it("registers each upstream tool with a server-namespaced id", async () => {
    const catalog = new ToolCatalog();

    const handle = await registerMcpServer(catalog, {
      name: "demo",
      transport: fake.clientTransport,
    });

    expect(handle.toolIds).toEqual(["demo__read_file"]);
    expect(catalog.has("demo__read_file")).toBe(true);

    await handle.close();
  });

  it("makes upstream tools discoverable via catalog.search using their description", async () => {
    const catalog = new ToolCatalog();
    const handle = await registerMcpServer(catalog, {
      name: "demo",
      transport: fake.clientTransport,
    });

    const hits = catalog.search("read a file from disk", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].toolId).toBe("demo__read_file");

    await handle.close();
  });

  it("namespaces by server label so two servers with overlapping tool names don't collide", async () => {
    const otherFake = await startFakeMcpServer([
      {
        name: "read_file",
        description: "Read a remote file from the cloud bucket.",
        handler: ({ path }) => ({ remoteContents: `cloud:${path as string}` }),
      },
    ]);

    const catalog = new ToolCatalog();
    const localHandle = await registerMcpServer(catalog, {
      name: "local",
      transport: fake.clientTransport,
    });
    const cloudHandle = await registerMcpServer(catalog, {
      name: "cloud",
      transport: otherFake.clientTransport,
    });

    expect(catalog.has("local__read_file")).toBe(true);
    expect(catalog.has("cloud__read_file")).toBe(true);

    const localResult = (await catalog.invoke("local__read_file", {
      path: "/etc/hosts",
    })) as { structuredContent?: { contents?: string } };
    const cloudResult = (await catalog.invoke("cloud__read_file", {
      path: "/etc/hosts",
    })) as { structuredContent?: { remoteContents?: string } };

    expect(localResult.structuredContent?.contents).toBe("contents of /etc/hosts");
    expect(cloudResult.structuredContent?.remoteContents).toBe("cloud:/etc/hosts");

    await localHandle.close();
    await cloudHandle.close();
    await otherFake.server.close();
  });

  it("disconnects on handle.close() so subsequent invokes reject", async () => {
    const catalog = new ToolCatalog();
    const handle = await registerMcpServer(catalog, {
      name: "demo",
      transport: fake.clientTransport,
    });

    await handle.close();

    await expect(catalog.invoke("demo__read_file", { path: "/x" })).rejects.toThrow();
  });

  it("rejects from catalog.invoke when the upstream tool handler throws", async () => {
    const failing = await startFakeMcpServer([
      {
        name: "boom",
        description: "always fails",
        handler: () => {
          throw new Error("kaboom");
        },
      },
    ]);
    const catalog = new ToolCatalog();
    const handle = await registerMcpServer(catalog, {
      name: "demo",
      transport: failing.clientTransport,
    });

    await expect(catalog.invoke("demo__boom", {})).rejects.toThrow(/kaboom/);

    await handle.close();
    await failing.server.close();
  });

  it("surfaces the upstream server's `instructions` field on the handle", async () => {
    const withInstructions = await startFakeMcpServer([{ name: "x", description: "anything" }], {
      instructions: "Use this server for filesystem ops.",
    });
    const catalog = new ToolCatalog();
    const handle = await registerMcpServer(catalog, {
      name: "fs",
      transport: withInstructions.clientTransport,
    });
    expect(handle.serverInstructions).toBe("Use this server for filesystem ops.");
    await handle.close();
    await withInstructions.server.close();
  });

  it("returns serverInstructions as undefined when the upstream did not supply any", async () => {
    const catalog = new ToolCatalog();
    const handle = await registerMcpServer(catalog, {
      name: "demo",
      transport: fake.clientTransport,
    });
    expect(handle.serverInstructions).toBeUndefined();
    await handle.close();
  });

  it("invokes the upstream tool via tools/call and returns its structured payload", async () => {
    const catalog = new ToolCatalog();
    const handle = await registerMcpServer(catalog, {
      name: "demo",
      transport: fake.clientTransport,
    });

    const result = (await catalog.invoke("demo__read_file", {
      path: "/etc/hosts",
    })) as { structuredContent?: { contents?: string } };

    expect(result.structuredContent).toEqual({ contents: "contents of /etc/hosts" });

    await handle.close();
  });
});
