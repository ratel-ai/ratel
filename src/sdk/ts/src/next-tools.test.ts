import { describe, expect, it } from "vitest";
import { IntentGraph, ToolCatalog } from "./index.js";

const tool = (id: string) => ({
  id,
  name: id,
  description: id.replace(/_/g, " "),
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
  outputSchema: {},
  execute: async () => id,
});

const QUERY = "assign task to developer";

/** Ten turns of find → assign, two of which go on to notify. */
async function trained(): Promise<{ catalog: ToolCatalog; graph: IntentGraph }> {
  const catalog = new ToolCatalog();
  await catalog.register(["find_task", "assign_task", "notify"].map(tool));
  const graph = new IntentGraph();
  catalog.experimentalEnableAdaptiveRanking(graph);
  for (let i = 0; i < 10; i++) {
    catalog.turn(() => {
      catalog.search(QUERY, 5, "agent");
      catalog.recordToolCall({ toolId: "find_task" });
      catalog.recordToolCall({ toolId: "assign_task" });
      if (i < 2) catalog.recordToolCall({ toolId: "notify" });
    });
  }
  return { catalog, graph };
}

describe("experimentalPredictNextTools", () => {
  it("predicts the strong chain of a new turn and what follows a tool", async () => {
    const { catalog } = await trained();
    const p = catalog.experimentalPredictNextTools({ query: QUERY, ids: ["assign_task"] });
    expect(p.chain.map((c) => c.toolId)).toEqual(["find_task", "assign_task"]);
    expect(p.chain[0]?.from).toBe("<start>");
    expect(p.chain.every((c) => c.strong)).toBe(true);
    const after = p.after.find((a) => a.toolId === "assign_task");
    expect(after?.next[0]?.toolId).toBe("notify");
    expect(after?.next[0]?.p).toBeCloseTo(2 / 11, 5);
    expect(after?.next[0]?.strong).toBe(false);
  });

  it("predicts from the current turn's last tool", async () => {
    const { catalog } = await trained();
    const chain = catalog.turn(() => {
      catalog.search(QUERY, 5, "agent");
      catalog.recordToolCall({ toolId: "find_task" });
      return catalog.experimentalPredictNextTools().chain.map((c) => c.toolId);
    });
    expect(chain).toEqual(["assign_task"]);
  });

  it("is empty without adaptive ranking", async () => {
    const catalog = new ToolCatalog();
    await catalog.register([tool("find_task")]);
    expect(catalog.experimentalPredictNextTools({ query: QUERY })).toEqual({
      chain: [],
      after: [],
    });
  });

  it("follows the turn with learn: false and never changes the graph", async () => {
    const { graph } = await trained();
    const before = graph.toJson();
    const consumer = new ToolCatalog();
    await consumer.register(["find_task", "assign_task", "notify"].map(tool));
    consumer.experimentalEnableAdaptiveRanking(graph, { learn: false });
    const chain = consumer.turn(() => {
      consumer.search(QUERY, 5, "agent");
      consumer.recordToolCall({ toolId: "find_task" });
      return consumer.experimentalPredictNextTools({ query: QUERY }).chain.map((c) => c.toolId);
    });
    expect(chain).toEqual(["assign_task"]);
    expect(graph.toJson()).toBe(before);
  });
});
