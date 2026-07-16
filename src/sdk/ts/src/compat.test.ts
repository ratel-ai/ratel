import { describe, expect, it } from "vitest";
import {
  type ExecutableTool,
  SEARCH_TOOLS_ID,
  type SearchToolsResult,
  searchToolsTool,
  ToolCatalog,
} from "./index.js";

const deployTool: ExecutableTool = {
  id: "ci__deploy",
  name: "deploy",
  description: "Deploy the project to production.",
  inputSchema: {},
  outputSchema: {},
  execute: async () => ({ ok: true }),
};

describe("searchToolsTool (deprecated 0.1.x compatibility shim)", () => {
  it("keeps the old `search_tools` id and the tools-only `{ groups }` result shape", async () => {
    const tools = new ToolCatalog();
    await tools.register(deployTool);
    const tool = searchToolsTool(tools);

    expect(tool.id).toBe(SEARCH_TOOLS_ID);
    expect(SEARCH_TOOLS_ID).toBe("search_tools");

    const result = (await tool.execute({ query: "deploy to production" })) as SearchToolsResult;
    // Old shape: a top-level `groups`, NOT the new { tools, skills } buckets.
    expect(Array.isArray(result.groups)).toBe(true);
    expect(result).not.toHaveProperty("tools");
    expect(result).not.toHaveProperty("skills");
    expect(result.groups[0].hits[0].toolId).toBe("ci__deploy");
  });

  it("respects the old `topK` parameter", async () => {
    const tools = new ToolCatalog();
    for (let i = 0; i < 5; i++) {
      await tools.register({
        id: `ci__t${i}`,
        name: `t${i}`,
        description: "deploy the project to production",
        inputSchema: {},
        outputSchema: {},
        execute: async () => ({}),
      });
    }
    const tool = searchToolsTool(tools);
    const result = (await tool.execute({ query: "deploy", topK: 2 })) as SearchToolsResult;
    const n = result.groups.reduce((a, g) => a + g.hits.length, 0);
    expect(n).toBeLessThanOrEqual(2);
  });
});
