import { describe, it, expect, vi } from "vitest";
import { Observable } from "rxjs";
import { wrapDiscoverTool, createRequestAgent } from "./agent.js";
import type { DiscoverTool, RankedTool, ServerTool } from "@agentified/sdk";

describe("wrapDiscoverTool", () => {
  it("creates a mastra tool that delegates to discoverTool.execute", async () => {
    const mockDiscover: DiscoverTool = {
      definition: {
        name: "agentified_discover",
        description: "Discover tools",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
      execute: vi.fn(async () => [
        { name: "tool1", description: "Tool 1", parameters: {}, score: 0.9 },
      ]),
    };

    const tool = wrapDiscoverTool(mockDiscover);

    expect(tool.id).toBe("agentified_discover");

    const result = await tool.execute!(
      { query: "find employees", limit: 5 },
      {} as never,
    );

    expect(mockDiscover.execute).toHaveBeenCalledWith({ query: "find employees", limit: 5 });
    expect(result).toEqual([
      { name: "tool1", description: "Tool 1", parameters: {}, score: 0.9 },
    ]);
  });
});

// Mock tools module for createRequestAgent tests
vi.mock("./tools/index.js", () => ({
  TOOL_DEFINITIONS: [
    { name: "viewEmployee", description: "View employee", category: "employees", parameters: {} },
  ],
  toolHandlers: {
    viewEmployee: vi.fn(async () => ({ id: "EMP001" })),
  },
}));

describe("createRequestAgent", () => {
  it("returns adapter with run method returning Observable", () => {
    const ranked: RankedTool[] = [
      { name: "viewEmployee", description: "View employee", parameters: {}, score: 0.9 },
    ];

    const { adapter } = createRequestAgent({
      ranked,
      agentifiedUrl: "http://localhost:9119",
      sdkTools: [] as ServerTool[],
      systemPrompt: "You are a helpful HR assistant.",
    });

    expect(adapter).toBeDefined();
    expect(typeof adapter.run).toBe("function");

    const obs = adapter.run({
      messages: [{ id: "m1", role: "user", content: "hi" }],
      threadId: "t1",
      runId: "r1",
      tools: [],
      context: [],
    });
    expect(obs).toBeInstanceOf(Observable);
  });
});
