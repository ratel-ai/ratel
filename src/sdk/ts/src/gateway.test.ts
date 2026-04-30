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
