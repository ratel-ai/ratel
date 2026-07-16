import { describe, expect, it } from "vitest";
import { GET_SKILL_CONTENT_ID, getSkillContentTool, type Skill, SkillCatalog } from "./index.js";

const apiDesign: Skill = {
  id: "api-design",
  name: "api-design",
  description: "REST API design patterns: resource naming, status codes, pagination.",
  tags: ["backend", "api"],
  body: "# API Design\n\nUse nouns for resources.",
};

async function catalogWith(...skills: Skill[]): Promise<SkillCatalog> {
  const c = new SkillCatalog();
  for (const s of skills) await c.register(s);
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
    const tool = getSkillContentTool(await catalogWith(apiDesign));
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
