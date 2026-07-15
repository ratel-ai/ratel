import { describe, expect, it } from "vitest";
import { type SearchHit, type Skill, SkillRegistry, type Tool, ToolRegistry } from "./index.js";

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

const BM25_CONCURRENCY_CORPUS_SIZE = 50_000;

describe("ToolRegistry", () => {
  it("normalizes a public bare string embedding spec", () => {
    expect(() => new ToolRegistry("")).toThrow(/must not be blank/);
  });

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

  it("exposes the non-blocking dense contract directly", async () => {
    const registry = new ToolRegistry({ local: "/definitely/missing/ratel-embedding-model" });
    registry.registerMany([readFile, writeFile]);

    expect(() => registry.searchWithMethod("read", 5, "direct", "semantic")).toThrow(
      /searchWithMethodAsync/,
    );
    await expect(registry.searchWithMethodAsync("read", 5, "direct", "semantic")).rejects.toThrow(
      /not computed for semantic/,
    );
    await expect(registry.buildEmbeddings()).rejects.toThrow(/failed to load embedding model/);
    await expect(registry.rebuildEmbeddings()).rejects.toThrow(/failed to load embedding model/);
  });

  it("serializes the raw dense method alias as semantic work", async () => {
    const registry = new ToolRegistry({ local: "/definitely/missing/ratel-embedding-model" });
    registry.register(readFile);

    const search = registry.searchWithMethodAsync("read", 5, "direct", "dense");
    const rejection = expect(search).rejects.toThrow(/not computed for semantic/);
    expect(() => registry.register(writeFile)).toThrow(/registry busy; await/);
    await rejection;
  });

  it("rejects registration promptly instead of blocking behind active asynchronous bm25 reads", async () => {
    const registry = new ToolRegistry();
    registry.registerMany(
      Array.from({ length: BM25_CONCURRENCY_CORPUS_SIZE }, (_, index) => ({
        id: `concurrent_${index}`,
        name: `concurrent_${index}`,
        description: `Deploy database file search operation ${index}`,
        inputSchema: {},
        outputSchema: {},
      })),
    );

    const searches = Array.from({ length: 4 }, () =>
      registry.searchWithMethodAsync("deploy database file", 10, "direct", "bm25"),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    const startedAt = performance.now();
    expect(() => registry.register(writeFile)).toThrow(/registry busy; await/);
    expect(performance.now() - startedAt).toBeLessThan(100);

    await Promise.all(searches);
  }, 15_000);
});

describe("SkillRegistry", () => {
  it("exposes rebuild as an asynchronous native operation", async () => {
    const registry = new SkillRegistry({
      local: "/definitely/missing/ratel-embedding-model",
    });
    const skill: Skill = {
      id: "api-design",
      name: "api-design",
      description: "Design a REST API.",
    };
    registry.register(skill);

    const rebuild = registry.rebuildEmbeddings();
    expect(rebuild).toBeInstanceOf(Promise);
    await expect(rebuild).rejects.toThrow(/failed to load embedding model/);
  });
});
