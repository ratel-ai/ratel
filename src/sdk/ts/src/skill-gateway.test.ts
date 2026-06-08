import { describe, expect, it } from "vitest";
import {
  INVOKE_SKILL_ID,
  invokeSkillTool,
  SEARCH_SKILLS_ID,
  type SearchSkillsResult,
  type Skill,
  SkillCatalog,
  searchSkillsTool,
} from "./index.js";

const apiDesign: Skill = {
  id: "api-design",
  name: "api-design",
  description: "REST API design patterns: resource naming, status codes, pagination.",
  tags: ["backend", "api"],
  body: "# API Design\n\nUse nouns for resources.",
};

describe("searchSkillsTool", () => {
  it("uses the canonical id and name", () => {
    const catalog = new SkillCatalog();
    const tool = searchSkillsTool(catalog);
    expect(tool.id).toBe(SEARCH_SKILLS_ID);
    expect(tool.name).toBe(SEARCH_SKILLS_ID);
    expect(SEARCH_SKILLS_ID).toBe("search_skills");
  });

  it("returns ranked skill hits with compacted descriptions", async () => {
    const catalog = new SkillCatalog();
    catalog.register(apiDesign);

    const tool = searchSkillsTool(catalog);
    const result = (await tool.execute({
      query: "design a REST API",
      topK: 5,
    })) as SearchSkillsResult;

    expect(result.skills.length).toBeGreaterThan(0);
    const top = result.skills[0];
    expect(top.skillId).toBe("api-design");
    expect(top.description).toContain("REST");
    expect(top.score).toBeGreaterThan(0);
  });

  it("emits gateway_search with origin=agent and the hit count", async () => {
    const catalog = new SkillCatalog({ trace: { kind: "memory", sessionId: "t" } });
    catalog.register(apiDesign);
    catalog.drainTraceEvents();

    const tool = searchSkillsTool(catalog);
    await tool.execute({ query: "rest api", topK: 3 });

    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const gw = events.find((e) => e.type === "gateway_search");
    expect(gw).toBeDefined();
    expect(gw?.origin).toBe("agent");
    expect(gw?.top_k).toBe(3);
  });

  it("defaults topK to 5 when omitted", async () => {
    const catalog = new SkillCatalog();
    catalog.register(apiDesign);
    const tool = searchSkillsTool(catalog);
    const result = (await tool.execute({ query: "api" })) as SearchSkillsResult;
    expect(Array.isArray(result.skills)).toBe(true);
  });
});

describe("invokeSkillTool", () => {
  it("uses the canonical id and name", () => {
    const catalog = new SkillCatalog();
    const tool = invokeSkillTool(catalog);
    expect(tool.id).toBe(INVOKE_SKILL_ID);
    expect(tool.name).toBe(INVOKE_SKILL_ID);
    expect(INVOKE_SKILL_ID).toBe("invoke_skill");
  });

  it("returns the skill body by id", async () => {
    const catalog = new SkillCatalog();
    catalog.register(apiDesign);

    const tool = invokeSkillTool(catalog);
    const result = (await tool.execute({ skillId: "api-design" })) as { body: string };
    expect(result.body).toContain("Use nouns for resources");
  });

  it("returns a structured error for an unknown skill id", async () => {
    const catalog = new SkillCatalog();
    const tool = invokeSkillTool(catalog);
    const result = (await tool.execute({ skillId: "nope" })) as { error: string };
    expect(result.error).toMatch(/unknown skillId: nope/);
  });

  it("emits gateway_error with unknown_skill_id for an unknown id", async () => {
    const catalog = new SkillCatalog({ trace: { kind: "memory", sessionId: "t" } });
    const tool = invokeSkillTool(catalog);
    await tool.execute({ skillId: "nope" });

    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const err = events.find((e) => e.type === "gateway_error");
    expect(err?.tool_id).toBe("nope");
    expect(err?.error).toBe("unknown_skill_id");
  });
});
