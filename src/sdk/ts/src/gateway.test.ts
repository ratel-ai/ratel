import { describe, expect, it } from "vitest";
import {
  type ExecutableTool,
  INVOKE_TOOL_ID,
  invokeToolTool,
  SEARCH_TOOLS_ID,
  searchToolsTool,
  ToolCatalog,
} from "./index.js";

const readFile: ExecutableTool = {
  id: "read_file",
  name: "read_file",
  description: "Read a file from local disk.",
  inputSchema: {
    properties: { path: { type: "string", description: "path to read" } },
  },
  outputSchema: {},
  execute: async ({ path }) => ({ contents: `contents of ${path}` }),
};

const sendEmail: ExecutableTool = {
  id: "send_email",
  name: "send_email",
  description: "Send an email via SMTP.",
  inputSchema: {
    properties: {
      to: { type: "string" },
      body: { type: "string" },
    },
  },
  outputSchema: {},
  execute: async ({ to }) => ({ messageId: "abc", to }),
};

describe("searchToolsTool", () => {
  it("uses the canonical id and name", () => {
    const catalog = new ToolCatalog();
    const tool = searchToolsTool(catalog);
    expect(tool.id).toBe(SEARCH_TOOLS_ID);
    expect(tool.name).toBe(SEARCH_TOOLS_ID);
    expect(SEARCH_TOOLS_ID).toBe("search_tools");
  });

  it("returns hits enriched with description and inputSchema from the catalog", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);
    catalog.register(sendEmail);

    const tool = searchToolsTool(catalog);
    const hits = (await tool.execute({ query: "read a file", topK: 5 })) as Array<{
      toolId: string;
      score: number;
      description: string;
      inputSchema: Record<string, unknown>;
    }>;

    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0];
    expect(top.toolId).toBe("read_file");
    expect(top.description).toContain("Read");
    expect(top.inputSchema).toBeDefined();
  });

  it("defaults topK to 5 when not provided", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    const tool = searchToolsTool(catalog);
    const hits = (await tool.execute({ query: "read a file" })) as Array<unknown>;
    expect(Array.isArray(hits)).toBe(true);
  });

  it("description is unchanged when upstreamServers is empty or omitted", () => {
    const catalog = new ToolCatalog();
    const baseline = searchToolsTool(catalog).description;
    expect(searchToolsTool(catalog, {}).description).toBe(baseline);
    expect(searchToolsTool(catalog, { upstreamServers: [] }).description).toBe(baseline);
  });

  it("description appends a list of upstream MCP servers with name, optional desc, optional tool count", () => {
    const catalog = new ToolCatalog();
    const baseline = searchToolsTool(catalog).description;

    const tool = searchToolsTool(catalog, {
      upstreamServers: [
        { name: "ev", description: "file & shell utilities", toolCount: 12 },
        { name: "linear", description: "Linear ticket ops" },
        { name: "metrics", toolCount: 3 },
        { name: "bare" },
      ],
    });

    expect(tool.description.startsWith(baseline)).toBe(true);
    expect(tool.description).toContain("upstream MCP servers");
    expect(tool.description).toContain("- ev — file & shell utilities (12 tools)");
    expect(tool.description).toContain("- linear — Linear ticket ops");
    expect(tool.description).not.toContain("- linear — Linear ticket ops (");
    expect(tool.description).toContain("- metrics (3 tools)");
    expect(tool.description).toMatch(/- bare\b/);
    expect(tool.description).not.toContain("- bare —");
    expect(tool.description).not.toContain("- bare (");
  });
});

describe("invokeToolTool", () => {
  it("uses the canonical id and name", () => {
    const catalog = new ToolCatalog();
    const tool = invokeToolTool(catalog);
    expect(tool.id).toBe(INVOKE_TOOL_ID);
    expect(tool.name).toBe(INVOKE_TOOL_ID);
    expect(INVOKE_TOOL_ID).toBe("invoke_tool");
  });

  it("invokes a registered tool by id with nested args", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    const tool = invokeToolTool(catalog);
    const result = await tool.execute({ toolId: "read_file", args: { path: "/tmp/x" } });
    expect(result).toEqual({ contents: "contents of /tmp/x" });
  });

  it("tolerates flattened args (model serialization quirk)", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    const tool = invokeToolTool(catalog);
    const result = await tool.execute({ toolId: "read_file", path: "/tmp/y" });
    expect(result).toEqual({ contents: "contents of /tmp/y" });
  });

  it("returns an error object for unknown toolId", async () => {
    const catalog = new ToolCatalog();

    const tool = invokeToolTool(catalog);
    const result = (await tool.execute({ toolId: "nope", args: {} })) as { error: string };
    expect(result.error).toMatch(/unknown toolId: nope/);
  });

  it("returns an error object when the underlying tool throws", async () => {
    const catalog = new ToolCatalog();
    catalog.register({
      id: "boom",
      name: "boom",
      description: "always throws",
      inputSchema: {},
      outputSchema: {},
      execute: async () => {
        throw new Error("kaboom");
      },
    });

    const tool = invokeToolTool(catalog);
    const result = (await tool.execute({ toolId: "boom", args: {} })) as { error: string };
    expect(result.error).toMatch(/boom threw: kaboom/);
  });
});
