import { describe, expect, it } from "vitest";
import { DRY_REPLY, dryReply } from "./dry-model.js";

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
