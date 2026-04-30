import { describe, expect, it } from "vitest";
import { type ExecutableTool, ToolCatalog } from "./index.js";

const readFile: ExecutableTool = {
  id: "read_file",
  name: "read_file",
  description: "Read a file from local disk and return its textual contents.",
  inputSchema: {
    properties: {
      path: { type: "string", description: "absolute path to the file" },
    },
  },
  outputSchema: {
    properties: { contents: { type: "string" } },
  },
  execute: async ({ path }) => ({ contents: `contents of ${path}` }),
};

describe("ToolCatalog", () => {
  it("returns no hits from an empty catalog", () => {
    const catalog = new ToolCatalog();
    expect(catalog.search("anything", 5)).toEqual([]);
  });

  it("registers a tool and finds it by name", () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    const hits = catalog.search("read file", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].toolId).toBe("read_file");
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it("invokes a registered tool by id with args", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    const result = await catalog.invoke("read_file", { path: "/tmp/x" });
    expect(result).toEqual({ contents: "contents of /tmp/x" });
  });

  it("throws on invoke of an unknown tool id", async () => {
    const catalog = new ToolCatalog();
    await expect(catalog.invoke("nope", {})).rejects.toThrow(/unknown toolId: nope/);
  });

  it("get(id) returns metadata; has(id) reports membership", () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    expect(catalog.has("read_file")).toBe(true);
    expect(catalog.has("missing")).toBe(false);
    const tool = catalog.get("read_file");
    expect(tool?.description).toContain("Read a file");
  });

  it("getExecutable(id) returns metadata + execute together", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    const exec = catalog.getExecutable("read_file");
    expect(exec).toBeDefined();
    expect(exec?.id).toBe("read_file");
    const result = await exec?.execute({ path: "/etc/hosts" });
    expect(result).toEqual({ contents: "contents of /etc/hosts" });
  });
});
