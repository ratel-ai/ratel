import { describe, expect, it } from "vitest";
import { GET_SKILL_CONTENT_ID, getSkillContentTool, type Skill, SkillCatalog } from "./index.js";

const apiDesign: Skill = {
  id: "api-design",
  name: "api-design",
  description: "REST API design patterns: resource naming, status codes, pagination.",
  tags: ["backend", "api"],
  body: "# API Design\n\nUse nouns for resources.",
};

function catalogWith(...skills: Skill[]): SkillCatalog {
  const c = new SkillCatalog();
  for (const s of skills) c.register(s);
  return c;
}

describe("getSkillContentTool", () => {
  it("uses the canonical id and name", () => {
    const tool = getSkillContentTool(new SkillCatalog());
    expect(tool.id).toBe(GET_SKILL_CONTENT_ID);
    expect(tool.name).toBe(GET_SKILL_CONTENT_ID);
    expect(GET_SKILL_CONTENT_ID).toBe("get_skill_content");
  });

  it("returns the skill body by id", async () => {
    const tool = getSkillContentTool(catalogWith(apiDesign));
    const result = (await tool.execute({ skillId: "api-design" })) as { body: string };
    expect(result.body).toContain("Use nouns for resources");
  });

  it("returns a structured error (with isError) for an unknown skill id", async () => {
    const tool = getSkillContentTool(new SkillCatalog());
    const result = (await tool.execute({ skillId: "nope" })) as {
      error: string;
      isError?: boolean;
    };
    expect(result.error).toMatch(/unknown skillId: nope/);
    // isError lets the host flag the call as failed rather than read it as content.
    expect(result.isError).toBe(true);
  });

  it("declares an output schema that accepts the error shape, not just body", () => {
    // An MCP client validates structured content against outputSchema. The error
    // branch returns { error } with no body, so `body` must NOT be required —
    // otherwise the error path throws a protocol error instead of returning it.
    const schema = getSkillContentTool(new SkillCatalog()).outputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.required ?? []).not.toContain("body");
    expect(schema.properties).toHaveProperty("body");
    expect(schema.properties).toHaveProperty("error");
  });

  it("lists declared skill deps with id and compacted description", async () => {
    const outline: Skill = {
      id: "deck-outlining",
      name: "deck-outlining",
      description: "Outline the narrative structure of a slide deck.",
      body: "# Deck Outlining",
    };
    const withDeps: Skill = { ...apiDesign, skills: ["deck-outlining"] };
    const tool = getSkillContentTool(catalogWith(withDeps, outline));
    const result = (await tool.execute({ skillId: "api-design" })) as {
      body: string;
      skills?: Array<{ skillId: string; description: string }>;
    };
    expect(result.body).toContain("Use nouns for resources");
    expect(result.skills).toEqual([
      {
        skillId: "deck-outlining",
        description: "Outline the narrative structure of a slide deck.",
      },
    ]);
  });

  it("omits the skills listing when the skill declares no deps", async () => {
    const tool = getSkillContentTool(catalogWith(apiDesign));
    const result = (await tool.execute({ skillId: "api-design" })) as Record<string, unknown>;
    expect(result).not.toHaveProperty("skills");
  });

  it("skips declared dep ids the catalog doesn't have, omitting the listing if none remain", async () => {
    const outline: Skill = {
      id: "deck-outlining",
      name: "deck-outlining",
      description: "Outline the narrative structure of a slide deck.",
      body: "# Deck Outlining",
    };
    const mixed: Skill = { ...apiDesign, skills: ["ghost-skill", "deck-outlining"] };
    const tool = getSkillContentTool(catalogWith(mixed, outline));
    const result = (await tool.execute({ skillId: "api-design" })) as {
      skills?: Array<{ skillId: string }>;
    };
    expect(result.skills?.map((s) => s.skillId)).toEqual(["deck-outlining"]);

    const allUnknown: Skill = { ...apiDesign, skills: ["ghost-skill"] };
    const tool2 = getSkillContentTool(catalogWith(allUnknown));
    const result2 = (await tool2.execute({ skillId: "api-design" })) as Record<string, unknown>;
    expect(result2).not.toHaveProperty("skills");
  });

  it("declares skills in the output schema without requiring it", () => {
    const schema = getSkillContentTool(new SkillCatalog()).outputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty("skills");
    expect(schema.required ?? []).not.toContain("skills");
  });

  it("emits gateway_error with unknown_skill_id for an unknown id", async () => {
    const catalog = new SkillCatalog({ trace: { kind: "memory", sessionId: "t" } });
    const tool = getSkillContentTool(catalog);
    await tool.execute({ skillId: "nope" });
    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const err = events.find((e) => e.type === "gateway_error");
    expect(err?.tool_id).toBe("nope");
    expect(err?.error).toBe("unknown_skill_id");
  });
});
