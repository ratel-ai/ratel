import { describe, expect, it } from "vitest";
import { type Skill, SkillCatalog } from "./index.js";
import { startDelayedEmbeddingServer } from "./test-support/delayed-embedding-server.js";

const slides: Skill = {
  id: "frontend-slides",
  name: "frontend-slides",
  description: "Build animation-rich HTML presentations from scratch.",
  tags: ["frontend", "presentations"],
  body: "# Frontend Slides\n\nStep 1: pick an aesthetic.",
};

const apiDesign: Skill = {
  id: "api-design",
  name: "api-design",
  description: "REST API design patterns: resource naming, status codes, pagination.",
  tags: ["backend", "api"],
  body: "# API Design\n\nUse nouns for resources.",
};

describe("SkillCatalog", () => {
  it("returns no hits from an empty catalog", () => {
    const catalog = new SkillCatalog();
    expect(catalog.search("anything", 5)).toEqual([]);
  });

  it("rejects an explicitly empty embedding string", () => {
    expect(() => new SkillCatalog({ embedding: "" })).toThrow(/must not be blank/);
  });

  it("registers skills and ranks the relevant one first", async () => {
    const catalog = new SkillCatalog();
    await catalog.register(slides);
    await catalog.register(apiDesign);

    const hits = catalog.search("design a REST endpoint with pagination", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].skillId).toBe("api-design");
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it("registers an iterable of skills as one batch", async () => {
    const catalog = new SkillCatalog();
    await catalog.register([
      { id: "auth", name: "auth", description: "Set up login" },
      { id: "deploy", name: "deploy", description: "Deploy an app" },
    ]);

    expect(catalog.has("auth")).toBe(true);
    expect(catalog.has("deploy")).toBe(true);
    expect(catalog.size()).toBe(2);
  });

  it("registers on a semantic catalog: embeds inline and search_async finds the hit", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const catalog = new SkillCatalog({
        method: "semantic",
        embedding: { url: server.url, model: "test-model" },
      });
      await catalog.register(slides);

      expect(catalog.has("frontend-slides")).toBe(true);
      const hits = await catalog.searchAsync("slides", 5);
      expect(hits[0]?.skillId).toBe("frontend-slides");
    } finally {
      await server.close();
    }
  });

  it("surfaces embedding load failures through register, but metadata persists", async () => {
    const catalog = new SkillCatalog({
      method: "semantic",
      embedding: { local: "/definitely/missing/ratel-embedding-model" },
    });

    await expect(catalog.register(slides)).rejects.toThrow(/failed to load embedding model/);
    // Metadata registration happens before the embedding pass inside `register`,
    // so it persists even though the embed itself failed.
    expect(catalog.has("frontend-slides")).toBe(true);
  });

  it("keeps dense search behind the asynchronous API", () => {
    // search() rejects a resolved semantic/hybrid method before ever touching
    // the registry, so this needs no registration (and no working model).
    const catalog = new SkillCatalog({
      method: "semantic",
      embedding: { local: "/definitely/missing/ratel-embedding-model" },
    });
    expect(() => catalog.search("slides", 5)).toThrow(/searchAsync/);
  });

  it("rejects a semantic override on a bm25 catalog with no embeddings built", async () => {
    const catalog = new SkillCatalog();
    await catalog.register(slides);
    await expect(catalog.searchAsync("slides", 5, "direct", "semantic")).rejects.toThrow(
      /not computed for semantic/,
    );
  });

  it("register([]) on a semantic catalog is an asynchronous no-op", async () => {
    const catalog = new SkillCatalog({
      method: "semantic",
      embedding: { local: "/definitely/missing/ratel-embedding-model" },
    });
    await expect(catalog.register([])).resolves.toBeUndefined();
    expect(catalog.size()).toBe(0);
  });

  it("serializes queued dense searches and rejects registration until they settle", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const catalog = new SkillCatalog({
        method: "semantic",
        embedding: { url: server.url, model: "test-model" },
      });
      await catalog.register(slides);

      const first = catalog.searchAsync("slides", 5);
      const second = catalog.searchAsync("frontend", 5);
      await expect(catalog.register(apiDesign)).rejects.toThrow(/registry busy; await/);
      await Promise.all([first, second]);
      await expect(catalog.register(apiDesign)).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("invoke(id) returns the body; has/get report membership and metadata", async () => {
    const catalog = new SkillCatalog();
    await catalog.register(slides);

    expect(catalog.has("frontend-slides")).toBe(true);
    expect(catalog.has("missing")).toBe(false);
    expect(catalog.get("frontend-slides")?.description).toContain("presentations");
    expect(catalog.invoke("frontend-slides")).toContain("pick an aesthetic");
    expect(catalog.size()).toBe(1);
  });

  it("throws on invoke of an unknown skill id", () => {
    const catalog = new SkillCatalog();
    expect(() => catalog.invoke("nope")).toThrow(/unknown skillId: nope/);
  });

  it("accepts a minimal skill with no tags or body (parity with the Python SDK)", async () => {
    const catalog = new SkillCatalog();
    // `tags` and `body` are optional — this object must type-check and register.
    const minimal: Skill = {
      id: "min",
      name: "min",
      description: "a minimal skill, no tags or body",
    };
    await catalog.register(minimal);

    expect(catalog.has("min")).toBe(true);
    expect(catalog.invoke("min")).toBe(""); // missing body resolves to "", never undefined
    expect(catalog.search("minimal", 5)[0]?.skillId).toBe("min");
  });
});

describe("SkillCatalog removed methods", () => {
  it("registerMany / buildEmbeddings / rebuildEmbeddings are gone at runtime", () => {
    // Folded into the variadic, self-embedding `register` (RAT-379/async-register).
    const catalog = new SkillCatalog() as unknown as Record<string, unknown>;
    expect(catalog.registerMany).toBeUndefined();
    expect(catalog.buildEmbeddings).toBeUndefined();
    expect(catalog.rebuildEmbeddings).toBeUndefined();
  });
});

describe("SkillCatalog tracing", () => {
  it("does not capture events under the default noop sink", async () => {
    const catalog = new SkillCatalog();
    await catalog.register(slides);
    catalog.search("slides", 5);
    expect(catalog.drainTraceEvents()).toEqual([]);
  });

  it("captures skill_churn on register and skill_search on search", async () => {
    const catalog = new SkillCatalog({ trace: { kind: "memory", sessionId: "t" } });
    await catalog.register(apiDesign);
    catalog.search("api", 5, "agent");

    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const types = events.map((e) => e.type);
    expect(types).toContain("skill_churn");
    expect(types).toContain("skill_search");

    const search = events.find((e) => e.type === "skill_search");
    expect(search?.origin).toBe("agent");
    expect((search?.hits as unknown[]).length).toBeGreaterThan(0);
  });

  it("emits skill_invoke on invoke", async () => {
    const catalog = new SkillCatalog({ trace: { kind: "memory", sessionId: "t" } });
    await catalog.register(apiDesign);
    catalog.drainTraceEvents();

    catalog.invoke("api-design");

    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const invoke = events.find((e) => e.type === "skill_invoke");
    expect(invoke?.skill_id).toBe("api-design");
    expect(typeof invoke?.took_ms).toBe("number");
  });

  it("re-registering an id replaces it in place — one hit, latest body wins", async () => {
    const catalog = new SkillCatalog();
    await catalog.register(apiDesign);
    await catalog.register({
      ...apiDesign,
      description: "Build animation-rich HTML presentations from scratch.",
      body: "# Slides\n\nUpdated body.",
    });

    // Native corpus is deduped by id: the id ranks once, not twice (RAT-378).
    const hits = catalog.search("animation-rich HTML presentations", 10);
    expect(hits.filter((h) => h.skillId === "api-design")).toHaveLength(1);
    // The latest metadata wins.
    expect(catalog.get("api-design")?.body).toBe("# Slides\n\nUpdated body.");
  });
});
