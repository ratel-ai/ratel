import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { type ExecutableTool, ToolCatalog } from "./index.js";

interface DelayedEmbeddingServer {
  url: string;
  requests: string[][];
  close: () => Promise<void>;
}

async function startDelayedEmbeddingServer(delayMs = 120): Promise<DelayedEmbeddingServer> {
  const source = `
    const http = require("node:http");
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const payload = JSON.parse(body);
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
        process.stdout.write(JSON.stringify(inputs) + "\\n");
        setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            model: payload.model,
            data: inputs.map((_, index) => ({ index, embedding: [index + 1, 1] })),
          }));
        }, ${delayMs});
      });
    });
    server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `;
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const [line] = (await Promise.race([
    once(lines, "line"),
    once(child, "exit").then(([code]) => {
      throw new Error(`embedding test server exited during startup (${String(code)})`);
    }),
    new Promise<never>((_, reject) => {
      startupTimer = setTimeout(
        () => reject(new Error("embedding test server startup timed out")),
        5_000,
      );
    }),
  ]).finally(() => clearTimeout(startupTimer))) as [string];
  const requests: string[][] = [];
  lines.on("line", (requestLine) => requests.push(JSON.parse(requestLine) as string[]));
  return {
    url: `http://127.0.0.1:${Number(line)}/v1/embeddings`,
    requests,
    close: async () => {
      lines.close();
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    },
  };
}

async function expectTimerBefore<T>(operation: Promise<T>): Promise<T> {
  const first = await Promise.race([
    operation.then(() => "operation" as const),
    new Promise<"timer">((resolve) => setTimeout(() => resolve("timer"), 20)),
  ]);
  expect(first).toBe("timer");
  return operation;
}

const huggingFaceHub =
  process.env.HF_HUB_CACHE ??
  join(process.env.HF_HOME ?? join(homedir(), ".cache", "huggingface"), "hub");
const cachedCandleModel = join(
  huggingFaceHub,
  "models--BAAI--bge-small-en-v1.5",
  "snapshots",
  "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a",
);
const hasCachedCandleModel =
  existsSync(join(cachedCandleModel, "config.json")) &&
  existsSync(join(cachedCandleModel, "tokenizer.json")) &&
  (existsSync(join(cachedCandleModel, "model.safetensors")) ||
    existsSync(join(cachedCandleModel, "pytorch_model.bin")));

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

  it("registers many tools as one metadata batch", () => {
    const catalog = new ToolCatalog();
    catalog.registerMany([
      readFile,
      {
        ...readFile,
        id: "send_email",
        name: "send_email",
        description: "Send an email message to a recipient.",
      },
    ]);

    expect(catalog.has("read_file")).toBe(true);
    expect(catalog.has("send_email")).toBe(true);
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
  it("registers semantic metadata without loading the configured model", () => {
    const catalog = new ToolCatalog({
      method: "semantic",
      embedding: { local: "/definitely/missing/ratel-embedding-model" },
    });

    expect(() => catalog.register(readFile)).not.toThrow();
    expect(catalog.has("read_file")).toBe(true);
  });

  it("surfaces embedding load failures through the build Promise", async () => {
    const catalog = new ToolCatalog({
      method: "semantic",
      embedding: { local: "/definitely/missing/ratel-embedding-model" },
    });
    catalog.register(readFile);

    let build: unknown;
    expect(() => {
      build = catalog.buildEmbeddings();
    }).not.toThrow();
    expect(build).toBeInstanceOf(Promise);
    await expect(build).rejects.toThrow(/failed to load embedding model/);
  });

  it("surfaces embedding load failures through the rebuild Promise", async () => {
    const catalog = new ToolCatalog({
      method: "semantic",
      embedding: { local: "/definitely/missing/ratel-embedding-model" },
    });
    catalog.register(readFile);

    let rebuild: unknown;
    expect(() => {
      rebuild = catalog.rebuildEmbeddings();
    }).not.toThrow();
    expect(rebuild).toBeInstanceOf(Promise);
    await expect(rebuild).rejects.toThrow(/failed to load embedding model/);
  });

  it("keeps dense search behind the asynchronous API", async () => {
    const catalog = new ToolCatalog({
      method: "semantic",
      embedding: { local: "/definitely/missing/ratel-embedding-model" },
    });
    catalog.register(readFile);

    expect(() => catalog.search("read", 5)).toThrow(/searchAsync/);
    await expect(catalog.searchAsync("read", 5)).rejects.toThrow(/not computed for semantic/);
  });

  it("keeps Node timers responsive during endpoint build and query", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const catalog = new ToolCatalog({
        method: "semantic",
        embedding: { url: server.url, model: "test-model" },
      });
      catalog.registerMany([
        readFile,
        {
          ...readFile,
          id: "send_email",
          name: "send_email",
          description: "Send an email message to a recipient.",
        },
      ]);

      await expectTimerBefore(catalog.buildEmbeddings());
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).toHaveLength(2);
      expect(server.requests[0]?.[0]).toContain("Read a file");
      expect(server.requests[0]?.[1]).toContain("Send an email");
      const hits = await expectTimerBefore(catalog.searchAsync("read a file", 5));
      expect(hits[0]?.toolId).toBe("read_file");
    } finally {
      await server.close();
    }
  });

  it("serializes queued dense searches and rejects registration until they settle", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const catalog = new ToolCatalog({
        method: "semantic",
        embedding: { url: server.url, model: "test-model" },
      });
      catalog.register(readFile);
      await catalog.buildEmbeddings();

      const started = Date.now();
      const first = catalog.searchAsync("read one", 5);
      const second = catalog.searchAsync("read two", 5);
      expect(() => catalog.register({ ...readFile, id: "later" })).toThrow(/registry busy; await/);
      await Promise.all([first, second]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
      expect(() => catalog.register({ ...readFile, id: "later" })).not.toThrow();
    } finally {
      await server.close();
    }
  });

  it.skipIf(!hasCachedCandleModel)(
    "keeps Node timers responsive during cached Candle model loading and inference",
    async () => {
      const catalog = new ToolCatalog({
        method: "semantic",
        embedding: { local: cachedCandleModel, pooling: "cls" },
      });
      catalog.register(readFile);
      let ticks = 0;
      const heartbeat = setInterval(() => {
        ticks += 1;
      }, 1);
      try {
        await catalog.buildEmbeddings();
      } finally {
        clearInterval(heartbeat);
      }
      expect(ticks).toBeGreaterThan(0);
    },
    60_000,
  );

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
    // Dense behavior is covered separately; this compares the synchronous BM25 path.
    const catalog = new ToolCatalog();
    catalog.register(readFile);
    const viaDefault = catalog.search("read file", 5).map((h) => h.toolId);
    const viaExplicit = catalog.search("read file", 5, "direct", "bm25").map((h) => h.toolId);
    expect(viaExplicit).toEqual(viaDefault);
    expect(viaExplicit[0]).toBe("read_file");
  });

  it("rejects an unknown asynchronous method without making the registry busy", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    const search = catalog.searchAsync("read file", 5, "direct", "keyword" as never);
    const rejection = expect(search).rejects.toThrow(/unknown search method/);
    expect(() => catalog.register({ ...readFile, id: "registered_after_invalid" })).not.toThrow();
    await rejection;
  });

  it("per-call method overrides the catalog default and reroutes the engine", () => {
    // Default is semantic, but with no registrations no model loads. A per-call
    // "bm25" must route to the bm25 engine — provable offline via the trace stage
    // the semantic default (empty corpus) never emits.
    const catalog = new ToolCatalog({
      method: "semantic",
      trace: { kind: "memory", sessionId: "o" },
    });
    expect(() => catalog.search("anything", 5)).toThrow(/searchAsync/);
    catalog.search("anything", 5, "direct", "bm25"); // per-call override: bm25 engine
    const searches = (
      catalog.drainTraceEvents() as Array<{ type: string; stages?: { name: string }[] }>
    ).filter((e) => e.type === "search");
    expect(searches).toHaveLength(1);
    expect(searches[0].stages?.some((s) => s.name === "bm25")).toBe(true);
  });

  it("rejects an unknown method", () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime guard
      catalog.search("read", 5, "direct", "keyword" as any),
    ).toThrow(/unknown search method/);
  });

  it("buildEmbeddings() on an empty catalog is an asynchronous no-op", async () => {
    // The empty corpus short-circuits before any model load.
    const catalog = new ToolCatalog({ method: "semantic" });
    await expect(catalog.buildEmbeddings()).resolves.toBeUndefined();
  });

  it("synchronous semantic override points to searchAsync", () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);
    expect(() => catalog.search("read", 5, "direct", "semantic")).toThrow(/searchAsync/);
  });
});

describe("ToolCatalog embedding config", () => {
  it("accepts a bm25 catalog with no embedding (default model, no load)", () => {
    // Construction must not load a model; offline-safe.
    expect(() => new ToolCatalog()).not.toThrow();
  });

  it("rejects an explicitly empty embedding string", () => {
    expect(() => new ToolCatalog({ embedding: "" })).toThrow(/must not be blank/);
  });

  it("throws at construction on an invalid embedding config (bare url, no model)", () => {
    expect(
      () =>
        new ToolCatalog({ method: "semantic", embedding: "https://api.openai.com/v1/embeddings" }),
    ).toThrow(/model/);
  });

  it("rejects a bare repo-id string, pointing to the huggingface object", () => {
    // A string is a local path only; a repo id must use { huggingface }.
    expect(
      () => new ToolCatalog({ method: "semantic", embedding: "BAAI/bge-base-en-v1.5" }),
    ).toThrow(/huggingface/);
  });

  it("throws at construction on a conflicting endpoint config", () => {
    expect(
      () =>
        new ToolCatalog({
          method: "semantic",
          // ollama shorthand and an explicit url are contradictory
          embedding: {
            ollama: "nomic",
            url: "http://h:11434/v1/embeddings",
            model: "nomic",
          } as never,
        }),
    ).toThrow(/conflicting/);
  });

  it("accepts a pooling override and doc prefix on an in-process model", () => {
    expect(
      () =>
        new ToolCatalog({
          method: "semantic",
          embedding: { huggingface: "org/m", pooling: "mean", docPrefix: "passage: " },
        }),
    ).not.toThrow();
  });

  it("rejects an invalid pooling value at construction", () => {
    expect(
      () =>
        new ToolCatalog({
          method: "semantic",
          embedding: { huggingface: "org/m", pooling: "median" as never },
        }),
    ).toThrow(/pooling/);
  });

  it("rejects pooling on an endpoint (server pools)", () => {
    expect(
      () =>
        new ToolCatalog({
          method: "semantic",
          embedding: { ollama: "nomic", pooling: "mean" } as never,
        }),
    ).toThrow(/pooling/);
  });

  it("accepts an explicit download opt-in on a huggingface model", () => {
    expect(
      () =>
        new ToolCatalog({
          method: "semantic",
          embedding: { huggingface: "org/m", download: true },
        }),
    ).not.toThrow();
  });

  it("rejects download on a non-huggingface source", () => {
    expect(
      () =>
        new ToolCatalog({
          method: "semantic",
          embedding: { local: "/opt/models/x", download: true } as never,
        }),
    ).toThrow(/download/);
  });

  it("retains and validates embedding configuration for a bm25 catalog", async () => {
    const catalog = new ToolCatalog({
      embedding: { local: "/definitely/missing/ratel-embedding-model" },
    });
    catalog.register(readFile);

    expect(catalog.search("read", 5)[0]?.toolId).toBe("read_file");
    await expect(catalog.buildEmbeddings()).rejects.toThrow(/failed to load embedding model/);
    expect(() => new ToolCatalog({ embedding: {} as never })).toThrow(/embedding source/);
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
