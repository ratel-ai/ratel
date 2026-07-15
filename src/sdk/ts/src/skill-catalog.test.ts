import { describe, expect, it } from "vitest";
import { type Skill, SkillCatalog } from "./index.js";

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

  it("registers skills and ranks the relevant one first", () => {
    const catalog = new SkillCatalog();
    catalog.register(slides);
    catalog.register(apiDesign);

    const hits = catalog.search("design a REST endpoint with pagination", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].skillId).toBe("api-design");
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it("invoke(id) returns the body; has/get report membership and metadata", () => {
    const catalog = new SkillCatalog();
    catalog.register(slides);

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

  it("accepts a minimal skill with no tags or body (parity with the Python SDK)", () => {
    const catalog = new SkillCatalog();
    // `tags` and `body` are optional — this object must type-check and register.
    const minimal: Skill = {
      id: "min",
      name: "min",
      description: "a minimal skill, no tags or body",
    };
    catalog.register(minimal);

    expect(catalog.has("min")).toBe(true);
    expect(catalog.invoke("min")).toBe(""); // missing body resolves to "", never undefined
    expect(catalog.search("minimal", 5)[0]?.skillId).toBe("min");
  });

  it("round-trips declared tool and skill deps through register/get", () => {
    const catalog = new SkillCatalog();
    catalog.register({
      ...apiDesign,
      tools: ["http__request"],
      skills: ["deck-outlining"],
    });

    const skill = catalog.get("api-design");
    expect(skill?.tools).toEqual(["http__request"]);
    expect(skill?.skills).toEqual(["deck-outlining"]);
  });
});

describe("SkillCatalog tracing", () => {
  it("does not capture events under the default noop sink", () => {
    const catalog = new SkillCatalog();
    catalog.register(slides);
    catalog.search("slides", 5);
    expect(catalog.drainTraceEvents()).toEqual([]);
  });

  it("captures skill_churn on register and skill_search on search", () => {
    const catalog = new SkillCatalog({ trace: { kind: "memory", sessionId: "t" } });
    catalog.register(apiDesign);
    catalog.search("api", 5, "agent");

    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const types = events.map((e) => e.type);
    expect(types).toContain("skill_churn");
    expect(types).toContain("skill_search");

    const search = events.find((e) => e.type === "skill_search");
    expect(search?.origin).toBe("agent");
    expect((search?.hits as unknown[]).length).toBeGreaterThan(0);
  });

  it("emits skill_invoke on invoke", () => {
    const catalog = new SkillCatalog({ trace: { kind: "memory", sessionId: "t" } });
    catalog.register(apiDesign);
    catalog.drainTraceEvents();

    catalog.invoke("api-design");

    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const invoke = events.find((e) => e.type === "skill_invoke");
    expect(invoke?.skill_id).toBe("api-design");
    expect(typeof invoke?.took_ms).toBe("number");
  });

  it("re-registering an id replaces it in place — one hit, latest body wins", () => {
    const catalog = new SkillCatalog();
    catalog.register(apiDesign);
    catalog.register({
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
