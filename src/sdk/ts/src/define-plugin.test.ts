import { describe, expect, it } from "vitest";
import { definePlugin, type RankFn, type RetrieverPlugin, ToolCatalog } from "./index.js";

const rank: RankFn = (_query, candidates) =>
  candidates.map(({ id }, index) => ({ id, score: 1 / (index + 1) }));

describe("definePlugin", () => {
  it("returns the plugin it was given", () => {
    const plugin = { retrieve: rank, rerank: rank };
    expect(definePlugin(plugin)).toBe(plugin);
  });

  it("accepts a plugin with only one of the two functions", () => {
    const rerankOnly = definePlugin({ rerank: rank });
    expect(rerankOnly.rerank).toBe(rank);
    const retrieveOnly = definePlugin({ retrieve: rank });
    expect(retrieveOnly.retrieve).toBe(rank);
  });

  it("types a full plugin as a RetrieverPlugin", () => {
    const plugin: RetrieverPlugin = definePlugin({ retrieve: rank, rerank: rank });
    expect(typeof plugin.retrieve).toBe("function");
  });

  it("rejects a plugin with neither function", () => {
    expect(() => definePlugin({})).toThrow(TypeError);
  });

  it("rejects a field that is not a function", () => {
    expect(() => definePlugin({ retrieve: "bm25" as unknown as RankFn })).toThrow(
      /retrieve must be a function/,
    );
  });

  it("plugs straight into a catalog", async () => {
    const plugin = definePlugin({ retrieve: rank });
    const catalog = new ToolCatalog({ method: "custom", retrieveFn: plugin.retrieve });
    await catalog.register([
      {
        id: "read_file",
        name: "read_file",
        description: "read a file",
        inputSchema: {},
        outputSchema: {},
        execute: async () => "ok",
      },
    ]);
    const hits = await catalog.searchAsync("read", 1);
    expect(hits.map((hit) => hit.toolId)).toEqual(["read_file"]);
  });
});
