import { describe, expect, it } from "vitest";
import { type ExecutableTool, ToolCatalog } from "./index.js";

// Dense (semantic) retrieval via the bundled Candle embedder that ships in
// dense-enabled addons (the published build); see ADR-0013.

function tool(id: string, description: string): ExecutableTool {
  return {
    id,
    name: id,
    description,
    inputSchema: {},
    outputSchema: {},
    execute: async () => null,
  };
}

function catalog(): ToolCatalog {
  const c = new ToolCatalog();
  c.register(tool("delete_path", "erase a directory entry permanently"));
  c.register(tool("weather", "get the current weather forecast for a city"));
  c.register(tool("send_email", "compose and send an email message"));
  return c;
}

describe("ToolCatalog.searchDense", () => {
  it("surfaces a synonym match BM25 would miss", () => {
    // "remove a file" shares no content words with "erase a directory entry".
    const hits = catalog().searchDense("remove a file", 3);
    expect(hits[0].toolId).toBe("delete_path");
  });

  it("respects topK", () => {
    expect(catalog().searchDense("anything", 2).length).toBeLessThanOrEqual(2);
  });
});
