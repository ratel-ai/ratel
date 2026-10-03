import { describe, expect, it } from "vitest";
import {
  type ExecutableTool,
  type RankCandidate,
  type RankFn,
  RetrieverError,
  ratel,
  SkillCatalog,
  ToolCatalog,
} from "./index.js";

function tool(id: string, description: string): ExecutableTool {
  return {
    id,
    name: id,
    description,
    inputSchema: {},
    outputSchema: {},
    execute: async () => "ok",
  };
}

const TOOLS = [
  tool("read_file", "read a file from disk"),
  tool("delete_file", "delete a file from disk"),
  tool("list_files", "list the files in a directory"),
  tool("send_email", "send an email message"),
];

/** A ranking function that scores ids from a table and records every call. */
function scripted(scores: Record<string, number>) {
  const calls: { query: string; candidates: RankCandidate[]; topK: number }[] = [];
  const fn: RankFn = async (query, candidates, topK) => {
    calls.push({ query, candidates, topK });
    return candidates.filter((c) => c.id in scores).map((c) => ({ id: c.id, score: scores[c.id] }));
  };
  return { fn, calls };
}

type TraceEvent = { type: string; stages?: { name: string }[]; hits?: { tool_id: string }[] };

function searches(catalog: ToolCatalog): TraceEvent[] {
  return (catalog.drainTraceEvents() as TraceEvent[]).filter((e) => e.type === "search");
}

async function bm25Order(query: string, topK: number): Promise<string[]> {
  const plain = new ToolCatalog();
  await plain.register(TOOLS);
  return plain.search(query, topK).map((h) => h.toolId);
}

describe("retrieveFn (method: custom)", () => {
  it("ranks the whole catalog with the function and returns only what it returned", async () => {
    const { fn, calls } = scripted({ send_email: 0.9, list_files: 0.4 });
    const catalog = new ToolCatalog({
      method: "custom",
      retrieveFn: fn,
      trace: { kind: "memory", sessionId: "c" },
    });
    await catalog.register(TOOLS);

    const hits = await catalog.searchAsync("tell my boss", 3);

    expect(hits.map((h) => h.toolId)).toEqual(["send_email", "list_files"]);
    expect(hits[0].score).toBeCloseTo(0.9);
    expect(calls).toHaveLength(1);
    expect(calls[0].topK).toBe(3);
    expect(calls[0].candidates.map((c) => c.id)).toEqual(TOOLS.map((t) => t.id));
    expect(calls[0].candidates.every((c) => c.kind === "tool")).toBe(true);
    expect(calls[0].candidates[0].text).toContain("read a file from disk");
    const [event] = searches(catalog);
    expect(event.stages?.map((s) => s.name)).toEqual(["custom"]);
  });

  it("drops unknown and duplicate ids and clamps scores", async () => {
    const fn: RankFn = () => [
      { id: "ghost", score: 1 },
      { id: "read_file", score: 7 },
      { id: "read_file", score: 0.1 },
      { id: "send_email", score: Number.NaN },
    ];
    const catalog = new ToolCatalog({ method: "custom", retrieveFn: fn });
    await catalog.register(TOOLS);
    const hits = await catalog.searchAsync("q", 5);
    expect(hits.map((h) => [h.toolId, h.score])).toEqual([
      ["read_file", 1],
      ["send_email", 0],
    ]);
  });

  it("propagates whatever the function throws", async () => {
    const fn: RankFn = async () => {
      throw new RetrieverError("down", "Timeout", { transient: true });
    };
    const catalog = new ToolCatalog({ method: "custom", retrieveFn: fn });
    await catalog.register(TOOLS);
    await expect(catalog.searchAsync("q", 3)).rejects.toMatchObject({
      name: "RetrieverError",
      code: "Timeout",
    });
  });

  it("rejects a ranking that is not a list of { id, score }", async () => {
    const fn = (async () => ({ id: "read_file" })) as unknown as RankFn;
    const catalog = new ToolCatalog({ method: "custom", retrieveFn: fn });
    await catalog.register(TOOLS);
    await expect(catalog.searchAsync("q", 3)).rejects.toThrow(/retrieveFn must return an array/);
  });

  it("does not call the function for an empty catalog or topK 0", async () => {
    const { fn, calls } = scripted({ read_file: 1 });
    const empty = new ToolCatalog({ method: "custom", retrieveFn: fn });
    expect(await empty.searchAsync("q", 3)).toEqual([]);
    const full = new ToolCatalog({ method: "custom", retrieveFn: fn });
    await full.register(TOOLS);
    expect(await full.searchAsync("q", 0)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("is async only", async () => {
    const catalog = new ToolCatalog({ method: "custom", retrieveFn: scripted({}).fn });
    await catalog.register(TOOLS);
    expect(() => catalog.search("q", 3)).toThrow(/searchAsync/);
  });

  it("lets a per-call built-in method bypass the function", async () => {
    const { fn, calls } = scripted({ send_email: 1 });
    const catalog = new ToolCatalog({ method: "custom", retrieveFn: fn });
    await catalog.register(TOOLS);
    const hits = await catalog.searchAsync("read a file", 2, { method: "bm25" });
    expect(hits[0].toolId).toBe("read_file");
    expect(calls).toHaveLength(0);
  });
});

describe("rerankerFn", () => {
  it("reranks stage 1's candidates only and fills topK in stage-1 order", async () => {
    const query = "read a file from disk";
    const stageOne = await bm25Order(query, 50);
    const last = stageOne[stageOne.length - 1];
    const { fn, calls } = scripted({ [last]: 0.9, not_a_tool: 1 });
    const catalog = new ToolCatalog({ rerankerFn: fn, trace: { kind: "memory", sessionId: "r" } });
    await catalog.register(TOOLS);

    const hits = await catalog.searchAsync(query, 3);

    expect(calls[0].candidates.map((c) => c.id)).toEqual(stageOne);
    expect(hits[0].toolId).toBe(last);
    expect(hits.map((h) => h.toolId).slice(1)).toEqual(
      stageOne.filter((id) => id !== last).slice(0, 2),
    );
    const [event] = searches(catalog);
    expect(event.stages?.map((s) => s.name)).toEqual(["bm25", "rerank"]);
  });

  it("offers at most rerankerDepth candidates, raised to topK", async () => {
    const { fn, calls } = scripted({});
    const shallow = new ToolCatalog({ rerankerFn: fn, rerankerDepth: 1 });
    await shallow.register(TOOLS);
    await shallow.searchAsync("file", 2);
    expect(calls[0].candidates).toHaveLength(2);
  });

  it("falls back to stage 1 on a transient RetrieverError and records why", async () => {
    const query = "delete a file";
    const fn: RankFn = async () => {
      throw new RetrieverError("jev is overloaded", "Overloaded", { transient: true });
    };
    const catalog = new ToolCatalog({ rerankerFn: fn, trace: { kind: "memory", sessionId: "f" } });
    await catalog.register(TOOLS);
    const hits = await catalog.searchAsync(query, 3);
    expect(hits.map((h) => h.toolId)).toEqual(await bm25Order(query, 3));
    const [event] = searches(catalog);
    expect(event.stages?.map((s) => s.name)).toEqual(["bm25", "rerank_fallback:Overloaded"]);
  });

  it("throws anything else — a non-transient RetrieverError or a plain error", async () => {
    for (const error of [
      new RetrieverError("bad key", "Unauthorized", { status: 401 }),
      new Error("boom"),
    ]) {
      const fn: RankFn = async () => {
        throw error;
      };
      const catalog = new ToolCatalog({ rerankerFn: fn });
      await catalog.register(TOOLS);
      await expect(catalog.searchAsync("file", 3)).rejects.toBe(error);
    }
  });

  it("is turned off per call by reranker: null", async () => {
    const { fn, calls } = scripted({ send_email: 1 });
    const catalog = new ToolCatalog({ rerankerFn: fn });
    await catalog.register(TOOLS);
    const hits = await catalog.searchAsync("read a file", 3, { reranker: null });
    expect(hits.map((h) => h.toolId)).toEqual(await bm25Order("read a file", 3));
    expect(calls).toHaveLength(0);
  });

  it("makes synchronous search throw", async () => {
    const catalog = new ToolCatalog({ rerankerFn: scripted({}).fn });
    await catalog.register(TOOLS);
    expect(() => catalog.search("q", 3)).toThrow(/searchAsync/);
  });
});

describe("turn ids", () => {
  it("stamp custom and reranked searches, from the call or the turn scope", async () => {
    const { fn } = scripted({ send_email: 1 });
    const custom = new ToolCatalog({
      method: "custom",
      retrieveFn: fn,
      trace: { kind: "memory", sessionId: "t" },
    });
    await custom.register(TOOLS);
    await custom.searchAsync("q", 2, { turnId: "turn-a" });
    await custom.turn(() => custom.searchAsync("q", 2));
    const [explicit, scoped] = (
      custom.drainTraceEvents() as { type: string; turn_id?: string }[]
    ).filter((e) => e.type === "search");
    expect(explicit.turn_id).toBe("turn-a");
    expect(scoped.turn_id).toEqual(expect.any(String));

    const reranked = new ToolCatalog({ rerankerFn: fn, trace: { kind: "memory", sessionId: "t" } });
    await reranked.register(TOOLS);
    await reranked.searchAsync("file", 2, { turnId: "turn-b" });
    const events = reranked.drainTraceEvents() as { type: string; turn_id?: string }[];
    expect(events.find((e) => e.type === "search")?.turn_id).toBe("turn-b");
  });
});

describe("validation", () => {
  const fn = scripted({}).fn;
  it.each([
    [{ method: "custom" as const }, /needs a retrieveFn/],
    [{ retrieveFn: fn }, /retrieveFn needs method "custom"/],
    [
      { rerankerFn: fn, reranker: { method: "semantic" as const } },
      /either reranker or rerankerFn/,
    ],
    [{ method: "custom" as const, retrieveFn: fn, rerankerFn: fn }, /rerankerFn needs/],
    [{ rerankerDepth: 5 }, /rerankerDepth needs a rerankerFn/],
    [{ rerankerFn: fn, rerankerDepth: 0 }, /rerankerDepth must be a positive integer/],
    [{ rerankerFn: "jev" as unknown as RankFn }, /rerankerFn must be a function/],
    [{ reranker: { method: "custom" as never } }, /for your own model use rerankerFn/],
  ])("rejects %o", (options, message) => {
    expect(() => new ToolCatalog(options)).toThrow(message);
    expect(() => new SkillCatalog(options)).toThrow(message);
  });

  it("rejects a per-call custom method on a catalog without a retrieveFn", async () => {
    const catalog = new ToolCatalog();
    await catalog.register(TOOLS);
    await expect(catalog.searchAsync("q", 3, { method: "custom" })).rejects.toThrow(
      /needs a catalog constructed with a retrieveFn/,
    );
  });
});

describe("skills and ratel()", () => {
  it("offers skills as kind skill", async () => {
    const { fn, calls } = scripted({ api_design: 0.8 });
    const skills = new SkillCatalog({ method: "custom", retrieveFn: fn });
    await skills.register([
      { id: "api_design", name: "api_design", description: "design rest endpoints", body: "b" },
      { id: "deploy", name: "deploy", description: "deploy a service", body: "b" },
    ]);
    const hits = await skills.searchAsync("design an api", 2);
    expect(hits.map((h) => h.skillId)).toEqual(["api_design"]);
    expect(calls[0].candidates.every((c) => c.kind === "skill")).toBe(true);
  });

  it("forwards the hooks to tools and skills, and ranks facts with BM25", async () => {
    const { fn, calls } = scripted({ send_email: 1 });
    const r = ratel({ method: "custom", retrieveFn: fn });
    await r.tools.register(...TOOLS);
    const hits = await r.tools.searchAsync("tell my boss", 2);
    expect(hits.map((h) => h.toolId)).toEqual(["send_email"]);
    expect(calls).toHaveLength(1);
  });
});
