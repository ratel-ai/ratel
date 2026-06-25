import { describe, expect, it } from "vitest";
import { buildRollup, RatelClient, type Rollup } from "./cloud.js";

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
});

describe("RatelClient", () => {
  it("tracks and flushes through the transport", async () => {
    const batches: Rollup[][] = [];
    const client = new RatelClient({
      transport: (batch) => {
        batches.push([...batch]);
      },
    });
    client.track({
      tokensByCategory: { tools: 2000 },
      savedByCategory: { tools: 7000 },
      model: "claude-haiku-4-5",
    });
    await client.flush();
    expect(batches).toHaveLength(1);
    const event = batches[0][0];
    expect(event.tokens_by_category).toEqual({
      skills: 0,
      tools: 2000,
      history: 0,
      memory: 0,
      user_input: 0,
    });
    expect((event.saved_by_category as Record<string, number>).tools).toBe(7000);
    expect(event.cost_usd as number).toBeGreaterThan(0);
  });

  it("auto-flushes at the size threshold", async () => {
    const batches: Rollup[][] = [];
    const client = new RatelClient({
      flushAt: 2,
      transport: (batch) => {
        batches.push([...batch]);
      },
    });
    client.track({ tokensByCategory: { tools: 1 } });
    client.track({ tokensByCategory: { tools: 2 } });
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the void flush() settle
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it("is a no-op without a key or transport", async () => {
    const client = new RatelClient({ host: "https://cloud.ratel.sh" });
    client.track({ tokensByCategory: { tools: 1 } }); // must not throw
    await client.flush();
    expect(client.canExport).toBe(false);
  });

  it("never throws when the transport rejects", async () => {
    const client = new RatelClient({
      transport: () => {
        throw new Error("boom");
      },
    });
    client.track({ tokensByCategory: { tools: 1 } });
    await expect(client.flush()).resolves.toBeUndefined();
  });
});
