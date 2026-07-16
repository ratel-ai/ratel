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

describe("SkillCatalog mutation seam (loader-facing)", () => {
  it("upsert returns false for a new id and true when replacing", () => {
    const catalog = new SkillCatalog();
    expect(catalog.upsert(slides)).toBe(false);
    expect(catalog.upsert({ ...slides, body: "# Updated" })).toBe(true);
    expect(catalog.size()).toBe(1);
    expect(catalog.get("frontend-slides")?.body).toBe("# Updated");
  });

  it("remove drops the skill and returns whether it was present", () => {
    const catalog = new SkillCatalog();
    catalog.register(slides);
    catalog.register(apiDesign);

    expect(catalog.remove("frontend-slides")).toBe(true);
    expect(catalog.has("frontend-slides")).toBe(false);
    expect(catalog.size()).toBe(1);
    const hits = catalog.search("animation-rich HTML presentations", 5);
    expect(hits.some((h) => h.skillId === "frontend-slides")).toBe(false);

    expect(catalog.remove("frontend-slides")).toBe(false);
  });

  it("remove emits a skill_churn remove trace event", () => {
    const catalog = new SkillCatalog({ trace: { kind: "memory", sessionId: "t" } });
    catalog.register(slides);
    catalog.drainTraceEvents();

    catalog.remove("frontend-slides");

    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const churn = events.filter((e) => e.type === "skill_churn");
    expect(churn).toHaveLength(1);
    expect(churn[0].kind).toBe("remove");
    expect(churn[0].skill_id).toBe("frontend-slides");
  });

  it("onChange fires on register, upsert, and remove; unsubscribe stops it", () => {
    const catalog = new SkillCatalog();
    let calls = 0;
    const unsubscribe = catalog.onChange(() => {
      calls += 1;
    });

    catalog.register(slides);
    expect(calls).toBe(1);
    catalog.upsert({ ...slides, body: "# Updated" });
    expect(calls).toBe(2);
    catalog.remove("frontend-slides");
    expect(calls).toBe(3);

    unsubscribe();
    catalog.register(apiDesign);
    expect(calls).toBe(3);
  });

  it("onChange does not fire when removing an unknown id", () => {
    const catalog = new SkillCatalog();
    let calls = 0;
    catalog.onChange(() => {
      calls += 1;
    });
    expect(catalog.remove("missing")).toBe(false);
    expect(calls).toBe(0);
  });

  it("a subscribed listener registered twice fires once per change", () => {
    const catalog = new SkillCatalog();
    let calls = 0;
    const listener = () => {
      calls += 1;
    };
    catalog.onChange(listener);
    catalog.onChange(listener);
    catalog.register(slides);
    expect(calls).toBe(1);
  });

  it("notifies subscribers even when eager embedding fails mid-register", () => {
    // On a semantic catalog the mutation commits before the eager embed; if the
    // embedder then fails, the error propagates but the staleness hook must
    // still fire — the host has a committed mutation to react to.
    const catalog = new SkillCatalog({ method: "semantic" });
    const internals = catalog as unknown as { registry: { buildEmbeddings: () => void } };
    internals.registry.buildEmbeddings = () => {
      throw new Error("stub embed failure");
    };
    let calls = 0;
    catalog.onChange(() => {
      calls += 1;
    });

    expect(() => catalog.register(slides)).toThrow(/stub embed failure/);
    expect(catalog.has("frontend-slides")).toBe(true);
    expect(calls).toBe(1);
  });

  it("a listener unsubscribing itself mid-notify breaks neither the mutation nor siblings", () => {
    const catalog = new SkillCatalog();
    let siblingCalls = 0;
    const unsubscribes: Array<() => void> = [];
    unsubscribes.push(
      catalog.onChange(() => {
        unsubscribes[0]();
      }),
    );
    catalog.onChange(() => {
      siblingCalls += 1;
    });

    expect(() => catalog.register(slides)).not.toThrow();
    expect(siblingCalls).toBe(1);
    catalog.register(apiDesign);
    expect(siblingCalls).toBe(2);
  });

  it("a listener subscribed mid-notify fires on the next mutation, not the current one", () => {
    const catalog = new SkillCatalog();
    let lateCalls = 0;
    let subscribed = false;
    catalog.onChange(() => {
      if (!subscribed) {
        subscribed = true;
        catalog.onChange(() => {
          lateCalls += 1;
        });
      }
    });

    catalog.register(slides);
    expect(lateCalls).toBe(0);
    catalog.register(apiDesign);
    expect(lateCalls).toBe(1);
  });

  it("listeners observe the settled post-mutation catalog", () => {
    const catalog = new SkillCatalog();
    const seen: Array<[number, boolean]> = [];
    catalog.onChange(() => {
      seen.push([catalog.size(), catalog.has("frontend-slides")]);
    });

    catalog.register(slides);
    catalog.remove("frontend-slides");
    expect(seen).toEqual([
      [1, true],
      [0, false],
    ]);
  });

  it("a throwing listener breaks neither the mutation nor its siblings", () => {
    const catalog = new SkillCatalog();
    let calls = 0;
    catalog.onChange(() => {
      throw new Error("bad subscriber");
    });
    catalog.onChange(() => {
      calls += 1;
    });

    expect(() => catalog.register(slides)).not.toThrow();
    expect(calls).toBe(1);
    expect(catalog.has("frontend-slides")).toBe(true);
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
