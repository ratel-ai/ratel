import { describe, expect, it } from "vitest";
import { judgeLLM } from "./llm.js";

describe("judgeLLM", () => {
  it("returns n/a when judge_criteria is missing", async () => {
    const result = await judgeLLM({
      judgeCriteria: "",
      finalText: "anything",
      // biome-ignore lint/suspicious/noExplicitAny: stub model never invoked when criteria is empty
      model: {} as any,
    });
    expect(result.verdict).toBe("n/a");
    expect(result.explanation).toMatch(/no judge criteria/);
  });

  it("returns n/a when the model call throws", async () => {
    const result = await judgeLLM({
      judgeCriteria: "must mention localhost",
      finalText: "127.0.0.1 localhost",
      // biome-ignore lint/suspicious/noExplicitAny: invalid model surfaces a thrown error from generateObject
      model: { specificationVersion: "v0" } as any,
    });
    expect(result.verdict).toBe("n/a");
    expect(result.explanation).toMatch(/judge failed/);
  });
});
