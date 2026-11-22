import { describe, expect, it } from "vitest";
import { DRY_REPLY, DryModel, dryReply } from "./dry-model.js";

describe("dryReply", () => {
  it("is DRY_REPLY with no system prompt", () => {
    expect(dryReply({ prompt: [{ role: "user", content: "hi" }] })).toBe(DRY_REPLY);
  });

  it("shows the start of the system prompt the stand-in got", () => {
    expect(dryReply({ prompt: [{ role: "system", content: "Answer in French." }] })).toBe(
      `${DRY_REPLY} System prompt: "Answer in French."`,
    );
    const long = "x".repeat(80);
    expect(dryReply({ prompt: [{ role: "system", content: long }] })).toBe(
      `${DRY_REPLY} System prompt: "${"x".repeat(60)}..."`,
    );
  });
});

describe("DryModel and the capability funnel", () => {
  it("loads each skill a recall result in the prompt surfaced", async () => {
    const recall = JSON.stringify({ skills: [{ skillId: "summarizeDoc", description: "x" }] });
    const { content } = await new DryModel("m").doGenerate({
      prompt: [
        { role: "user", content: "hi" },
        { role: "tool", content: recall },
      ],
      tools: [
        {
          name: "get_skill_content",
          inputSchema: { type: "object", properties: { skillId: { type: "string" } } },
        },
      ],
    });
    expect(content).toEqual([
      {
        type: "tool-call",
        toolCallId: "dry_1",
        toolName: "get_skill_content",
        input: JSON.stringify({ skillId: "summarizeDoc" }),
      },
    ]);
  });
});
