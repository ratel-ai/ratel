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
});

describe("SkillCatalog mutation", () => {
  it("upsert replaces an existing skill and reindexes it", () => {
    const catalog = new SkillCatalog();
    catalog.register(apiDesign);

    const replaced = catalog.upsert({
      id: "api-design",
      name: "api-design",
      description: "GraphQL schema modeling and federation.",
      tags: ["graphql"],
      body: "# GraphQL",
    });

    expect(replaced).toBe(true);
    expect(catalog.search("REST pagination", 5)).toEqual([]);
    expect(catalog.search("GraphQL federation", 5)[0]?.skillId).toBe("api-design");
    expect(catalog.get("api-design")?.description).toContain("GraphQL");
    expect(catalog.invoke("api-design")).toBe("# GraphQL");
    expect(catalog.size()).toBe(1);
  });

  it("upsert of a new id registers it and reports no replacement", () => {
    const catalog = new SkillCatalog();
    expect(catalog.upsert(apiDesign)).toBe(false);
    expect(catalog.has("api-design")).toBe(true);
  });

  it("remove drops the skill from search and membership", () => {
    const catalog = new SkillCatalog();
    catalog.register(apiDesign);

    expect(catalog.remove("api-design")).toBe(true);
    expect(catalog.remove("api-design")).toBe(false);
    expect(catalog.has("api-design")).toBe(false);
    expect(catalog.search("REST API", 5)).toEqual([]);
  });

  it("upsert of an existing id emits skill_churn remove then add", () => {
    const catalog = new SkillCatalog({ trace: { kind: "memory", sessionId: "t" } });
    catalog.register(apiDesign);
    catalog.drainTraceEvents();

    catalog.upsert({ ...apiDesign, description: "GraphQL schema modeling." });

    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const churn = events.filter((e) => e.type === "skill_churn").map((e) => e.kind);
    expect(churn).toEqual(["remove", "add"]);
  });

  it("onChange fires after register/upsert/remove until unsubscribed", () => {
    const catalog = new SkillCatalog();
    let fired = 0;
    const unsubscribe = catalog.onChange(() => {
      fired += 1;
    });

    catalog.register(apiDesign);
    catalog.upsert(slides);
    catalog.remove("api-design");
    expect(fired).toBe(3);

    unsubscribe();
    catalog.remove("frontend-slides");
    expect(fired).toBe(3);
  });

  it("onChange does not fire when remove is a no-op", () => {
    const catalog = new SkillCatalog();
    let fired = 0;
    catalog.onChange(() => {
      fired += 1;
    });

    catalog.remove("ghost");
    expect(fired).toBe(0);
  });

  it("a throwing listener breaks neither the mutation nor the other listeners", () => {
    const catalog = new SkillCatalog();
    let laterListenerFired = 0;
    catalog.onChange(() => {
      throw new Error("boom");
    });
    catalog.onChange(() => {
      laterListenerFired += 1;
    });

    expect(() => catalog.register(apiDesign)).not.toThrow();
    expect(catalog.has("api-design")).toBe(true);
    expect(laterListenerFired).toBe(1);
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
});
