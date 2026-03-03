import { describe, it, expect } from "vitest";
import { tool } from "../tool.js";

describe("tool", () => {
  it("converts ToolDefinition to ServerTool with fields for multi-field embeddings", () => {
    const result = tool({
      name: "get_weather",
      description: "Get weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
      },
    });

    expect(result).toEqual({
      name: "get_weather",
      description: "Get weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
      },
      fields: {
        name: "get_weather",
        description: "Get weather for a city",
        inputSchema: JSON.stringify({
          type: "object",
          properties: { city: { type: "string" } },
        }),
      },
    });
  });
});
