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

describe("ToolCatalog search methods", () => {
  // Semantic/hybrid load a real model (network) and are covered in Rust; these
  // stay offline and assert the selection plumbing + the model-free default.
  it("defaults to bm25 and never loads a model", () => {
    const catalog = new ToolCatalog({ trace: { kind: "memory", sessionId: "m" } });
    catalog.register(readFile);
    const hits = catalog.search("read file", 5);
    expect(hits[0]?.toolId).toBe("read_file");
    const events = catalog.drainTraceEvents() as Array<{
      type: string;
      stages?: { name: string }[];
    }>;
    const search = events.find((e) => e.type === "search");
    expect(search?.stages?.some((s) => s.name === "bm25")).toBe(true);
  });

  it("accepts an explicit per-call bm25 method matching the default", () => {
    // Stays on a BM25 catalog so no model loads. (Registering into a semantic
    // catalog eagerly builds embeddings and would download the model — the override
    // behaviour proper is covered offline in the Rust core tests.)
    const catalog = new ToolCatalog();
    catalog.register(readFile);
    const viaDefault = catalog.search("read file", 5).map((h) => h.toolId);
    const viaExplicit = catalog.search("read file", 5, "direct", "bm25").map((h) => h.toolId);
    expect(viaExplicit).toEqual(viaDefault);
    expect(viaExplicit[0]).toBe("read_file");
  });

  it("per-call method overrides the catalog default and reroutes the engine", () => {
    // Default is semantic, but with no registrations no model loads. A per-call
    // "bm25" must route to the bm25 engine — provable offline via the trace stage
    // the semantic default (empty corpus) never emits.
    const catalog = new ToolCatalog({
      method: "semantic",
      trace: { kind: "memory", sessionId: "o" },
    });
    catalog.search("anything", 5); // default: semantic engine
    catalog.search("anything", 5, "direct", "bm25"); // per-call override: bm25 engine
    const searches = (
      catalog.drainTraceEvents() as Array<{ type: string; stages?: { name: string }[] }>
    ).filter((e) => e.type === "search");
    expect(searches).toHaveLength(2);
    expect(searches[0].stages?.some((s) => s.name === "bm25")).toBe(false);
    expect(searches[1].stages?.some((s) => s.name === "bm25")).toBe(true);
  });

  it("rejects an unknown method", () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime guard
      catalog.search("read", 5, "direct", "keyword" as any),
    ).toThrow(/unknown search method/);
  });

  it("buildEmbeddings() on an empty catalog is a no-op and loads no model", () => {
    // Empty corpus short-circuits before any embedder load — the incremental
    // eager path proper is proven in the Rust core tests (counting embedder).
    const catalog = new ToolCatalog({ method: "semantic" });
    expect(() => catalog.buildEmbeddings()).not.toThrow();
  });

  it("semantic on a BM25 catalog with no embeddings errors (no model load)", () => {
    // A BM25 catalog never built embeddings → a per-call semantic search refuses with a
    // clear error instead of silently embedding the corpus. The guard runs
    // before any model load, so this is offline-safe.
    const catalog = new ToolCatalog();
    catalog.register(readFile);
    expect(() => catalog.search("read", 5, "direct", "semantic")).toThrow(
      /not computed for semantic/,
    );
  });
});

describe("ToolCatalog tracing", () => {
  it("does not capture events when no trace sink is configured (default noop)", () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);
    catalog.search("read", 5);
    expect(catalog.drainTraceEvents()).toEqual([]);
  });

  it("captures index_churn on register and search on search via memory sink", () => {
    const catalog = new ToolCatalog({ trace: { kind: "memory", sessionId: "t" } });
    catalog.register(readFile);
    catalog.search("read", 5);

    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const types = events.map((e) => e.type);
    expect(types).toContain("index_churn");
    expect(types).toContain("search");

    const search = events.find((e) => e.type === "search");
    expect(search?.origin).toBe("direct");
    expect((search?.hits as unknown[]).length).toBeGreaterThan(0);
  });

  it("emits invoke_start + invoke_end around a successful invoke", async () => {
    const catalog = new ToolCatalog({ trace: { kind: "memory", sessionId: "t" } });
    catalog.register(readFile);
    catalog.drainTraceEvents(); // discard register/search noise

    await catalog.invoke("read_file", { path: "/x" });

    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const types = events.map((e) => e.type);
    expect(types).toContain("invoke_start");
    expect(types).toContain("invoke_end");
    const start = events.find((e) => e.type === "invoke_start");
    expect(start?.tool_id).toBe("read_file");
    expect(typeof start?.args_size_bytes).toBe("number");
  });

  it("emits invoke_error when the executor throws and re-throws to the caller", async () => {
    const catalog = new ToolCatalog({ trace: { kind: "memory", sessionId: "t" } });
    catalog.register({
      id: "boom",
      name: "boom",
      description: "x",
      inputSchema: {},
      outputSchema: {},
      execute: async () => {
        throw new Error("kaboom");
      },
    });
    catalog.drainTraceEvents();

    await expect(catalog.invoke("boom", {})).rejects.toThrow(/kaboom/);

    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const err = events.find((e) => e.type === "invoke_error");
    expect(err?.tool_id).toBe("boom");
    expect(err?.error).toMatch(/kaboom/);
  });

  it("search() defaults origin=direct; explicit origin=agent flows through to the event", () => {
    const catalog = new ToolCatalog({ trace: { kind: "memory", sessionId: "t" } });
    catalog.register(readFile);
    catalog.drainTraceEvents();

    catalog.search("read", 5, "agent");
    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const search = events.find((e) => e.type === "search");
    expect(search?.origin).toBe("agent");
  });

  it("re-registering an id replaces it in place — one hit, latest content wins", async () => {
    const catalog = new ToolCatalog();
    catalog.register({
      ...readFile,
      description: "Read a file from local disk.",
      execute: async () => ({ contents: "v1" }),
    });
    catalog.register({
      ...readFile,
      description: "Fetch and return a document over the network.",
      execute: async () => ({ contents: "v2" }),
    });

    // Native corpus is deduped by id: the id ranks once, not twice (RAT-378).
    const hits = catalog.search("fetch a document over the network", 10);
    expect(hits.filter((h) => h.toolId === "read_file")).toHaveLength(1);
    // The latest executor wins.
    expect(await catalog.invoke("read_file", { path: "/x" })).toEqual({ contents: "v2" });
  });
});
