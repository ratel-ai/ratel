import { describe, it, expect, vi } from "vitest";
import { buildMastraToolsFromRanked } from "./mastra-tools.js";
import type { RankedTool } from "@agentified/sdk";

// Minimal stubs matching what TOOL_DEFINITIONS + toolHandlers export
vi.mock("./index.js", () => {
  const TOOL_DEFINITIONS = [
    { name: "viewEmployee", description: "View employee", category: "employees", parameters: {} },
    { name: "listEmployees", description: "List employees", category: "employees", parameters: {} },
    { name: "addEmployee", description: "Add employee", category: "employees", parameters: {} },
  ];
  const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    viewEmployee: vi.fn(async (args) => ({ id: args.employeeId, name: "Test" })),
    listEmployees: vi.fn(async () => ({ employees: [] })),
    addEmployee: vi.fn(async (args) => ({ id: "EMP999", ...args })),
  };
  return { TOOL_DEFINITIONS, toolHandlers };
});

describe("buildMastraToolsFromRanked", () => {
  it("returns only tools matching ranked list", () => {
    const ranked: RankedTool[] = [
      { name: "viewEmployee", description: "View employee", parameters: {}, score: 0.9 },
      { name: "listEmployees", description: "List employees", parameters: {}, score: 0.8 },
    ];

    const tools = buildMastraToolsFromRanked(ranked);

    expect(Object.keys(tools)).toEqual(["viewEmployee", "listEmployees"]);
    expect(tools.addEmployee).toBeUndefined();
  });

  it("execute dispatches to original handler with args", async () => {
    const ranked: RankedTool[] = [
      { name: "viewEmployee", description: "View employee", parameters: {}, score: 0.9 },
    ];

    const tools = buildMastraToolsFromRanked(ranked);
    const result = await tools.viewEmployee!.execute!(
      { employeeId: "EMP001" },
      {} as never,
    );

    expect(result).toEqual({ id: "EMP001", name: "Test" });
  });
});
