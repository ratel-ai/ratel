import { describe, it, expect } from "vitest";
import { appAgent } from "../src/mastra/agents/app-agent.js";
import { mastra } from "../src/mastra/index.js";

describe("appAgent", () => {
  it("has correct id", () => {
    expect(appAgent.id).toBe("app-agent");
  });

  it("is registered in mastra instance", () => {
    const agent = mastra.getAgent("app-agent");
    expect(agent).toBeDefined();
    expect(agent.name).toBe("App Agent");
  });
});
