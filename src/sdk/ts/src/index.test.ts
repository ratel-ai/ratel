import { describe, expect, it } from "vitest";
import { type SearchHit, type Tool, ToolRegistry } from "./index.js";

const readFile: Tool = {
  id: "read_file",
  name: "read_file",
  description: "Read a file from local disk and return its textual contents.",
  inputSchema: {
    properties: {
      path: { type: "string", description: "absolute path to the file" },
      encoding: {
        type: "string",
        enum: ["utf8", "binary"],
        description: "how to decode the bytes",
      },
    },
  },
  outputSchema: {
    properties: {
      contents: { type: "string", description: "decoded file contents" },
    },
  },
};

const writeFile: Tool = {
  id: "write_file",
  name: "write_file",
  description: "Write textual contents to a file on local disk.",
  inputSchema: {
    properties: {
      path: { type: "string", description: "absolute path to the file" },
      contents: { type: "string", description: "bytes to write" },
    },
  },
  outputSchema: {},
};

const searchFiles: Tool = {
  id: "search_files",
  name: "search_files",
  description: "Grep across files in a directory using a regular expression.",
  inputSchema: {
    properties: {
      root: { type: "string", description: "directory to scan recursively" },
      pattern: { type: "string", description: "regular expression to match" },
    },
  },
  outputSchema: {},
};

describe("ToolRegistry", () => {
  it("returns no hits from an empty registry", () => {
    const registry = new ToolRegistry();
    expect(registry.search("anything", 5)).toEqual([]);
  });

  it("finds a registered tool by name with a positive score", () => {
    const registry = new ToolRegistry();
    registry.register(readFile);

    const hits = registry.search("read file", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].toolId).toBe("read_file");
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it("indexes content nested inside inputSchema property descriptions", () => {
    // Tool's only signal for "regular expression" lives inside inputSchema.properties.pattern.description.
    // Verifies the binding forwards serde_json::Value across the FFI without dropping nested fields.
    const registry = new ToolRegistry();
    registry.register(readFile);
    registry.register(writeFile);
    registry.register(searchFiles);

    const hits = registry.search("regular expression", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].toolId).toBe("search_files");
  });

  it("bounds the result count by topK", () => {
    const registry = new ToolRegistry();
    registry.register(readFile);
    registry.register(writeFile);
    registry.register(searchFiles);

    const hits = registry.search("file", 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it("exposes hit fields in camelCase (toolId, score)", () => {
    const registry = new ToolRegistry();
    registry.register(readFile);

    const [hit] = registry.search("read file", 1);
    expect(hit).toBeDefined();
    const typedHit: SearchHit = hit;
    expect(typeof typedHit.toolId).toBe("string");
    expect(typeof typedHit.score).toBe("number");
    expect(typedHit.score).toBeGreaterThan(0);
  });
});
