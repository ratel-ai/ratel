import { describe, expect, it } from "vitest";
import { buildRollup } from "./rollup.js";

describe("buildRollup", () => {
  it("fills all five sources and defaults input tokens to the sum", () => {
    const rollup = buildRollup({ tokensByCategory: { tools: 2000, history: 3400 } });
    expect(rollup.tokens_by_category).toEqual({
      skills: 0,
      tools: 2000,
      history: 3400,
      memory: 0,
      user_input: 0,
    });
    expect(rollup.input_tokens).toBe(5400);
    // absent optionals are omitted, not null
    expect(rollup.saved_by_category).toBeUndefined();
    expect(rollup.cost_usd).toBeUndefined();
  });

  it("estimates cost from the model", () => {
    const rollup = buildRollup({
      tokensByCategory: { tools: 1000 },
      outputTokens: 200,
      model: "claude-sonnet-4-6",
    });
    expect(rollup.model).toBe("claude-sonnet-4-6");
    expect(rollup.cost_usd as number).toBeGreaterThan(0);
  });

  it("lets an explicit cost win over the estimate", () => {
    const rollup = buildRollup({
      tokensByCategory: { tools: 1000 },
      model: "claude-opus-4-8",
      costUsd: 0.5,
    });
    expect(rollup.cost_usd).toBe(0.5);
  });

  it("serializes an occurredAt Date to ISO 8601", () => {
    const rollup = buildRollup({
      tokensByCategory: { tools: 1 },
      occurredAt: new Date("2026-06-25T00:00:00Z"),
    });
    expect(rollup.occurred_at).toBe("2026-06-25T00:00:00.000Z");
  });

  it("counts raw context segments automatically (no manual tokenization)", () => {
    const rollup = buildRollup({
      context: {
        skills: "You are a support agent. Follow the refund playbook carefully.",
        tools: [{ name: "search_orders", description: "find a customer's orders" }],
        history: [
          { role: "user", content: "where is my order" },
          { role: "assistant", content: "let me check that for you" },
        ],
        memory: "Customer is a premium member since 2021.",
        userInput: "I want a refund please",
      },
      model: "gpt-4o",
    });
    const tbc = rollup.tokens_by_category as Record<string, number>;
    for (const key of ["skills", "tools", "history", "memory", "user_input"]) {
      expect(tbc[key]).toBeGreaterThan(0);
    }
    expect(rollup.input_tokens).toBe(
      tbc.skills + tbc.tools + tbc.history + tbc.memory + tbc.user_input,
    );
  });

  it("prefers explicit tokensByCategory over context when both are given", () => {
    const rollup = buildRollup({
      tokensByCategory: { tools: 5 },
      context: { tools: "this string would count to something else entirely" },
    });
    expect((rollup.tokens_by_category as Record<string, number>).tools).toBe(5);
  });
});
