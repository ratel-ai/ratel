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
});

describe("ToolCatalog observe (tokens saved)", () => {
  const sendEmail: ExecutableTool = {
    id: "send_email",
    name: "send_email",
    description: "Send an email message to one or more recipients with a subject and body.",
    inputSchema: { properties: { to: { type: "string" } } },
    outputSchema: {},
    execute: async () => ({}),
  };

  it("records lastSavings (in-memory only) when observing", () => {
    const catalog = new ToolCatalog({ observe: true, trace: { kind: "memory", sessionId: "t" } });
    catalog.register(readFile);
    catalog.register(sendEmail);
    catalog.drainTraceEvents(); // discard register churn

    catalog.search("read a file from disk", 1);

    const sv = catalog.lastSavings;
    expect(sv).toBeDefined();
    if (!sv) return;
    expect(sv.topK).toBe(1);
    expect(sv.fullCatalogTokens).toBeGreaterThan(sv.selectedTokens);
    expect(sv.tokensSaved).toBeGreaterThan(0);

    // Savings is in-memory only — nothing is emitted to the trace stream.
    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    expect(events.some((e) => e.type === "tokens_saved")).toBe(false);
  });

  it("records nothing extra when not observing", () => {
    const catalog = new ToolCatalog({ trace: { kind: "memory", sessionId: "t" } });
    catalog.register(readFile);
    catalog.register(sendEmail);
    catalog.drainTraceEvents();

    catalog.search("read a file", 1);

    expect(catalog.lastSavings).toBeUndefined();
    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    expect(events.some((e) => e.type === "tokens_saved")).toBe(false);
  });
});
