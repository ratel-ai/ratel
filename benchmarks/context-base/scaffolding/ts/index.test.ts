import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { resolve } from "node:path";
import type { ToolDef, SetupBody, SendMessageBody, SendMessageResponse } from "../../lib/protocol.js";
import { startAgent, executeTool } from "./index.js";

const PORT = 19876;

describe("TS scaffolding", () => {
  let close: () => Promise<void>;
  let setupCalled = false;
  let lastSendBody: SendMessageBody | undefined;

  beforeAll(async () => {
    const server = await startAgent({
      port: PORT,
      setup: async (_tools, _config) => {
        setupCalled = true;
      },
      sendMessage: async (body) => {
        lastSendBody = body;
        return {
          content: "test response",
          toolCalls: [],
          usage: { totalTokens: 10, inputTokens: 8, outputTokens: 2 },
          durationMs: 50,
        };
      },
    });
    close = server.close;
  });

  afterAll(async () => {
    await close();
  });

  it("responds to GET /health", async () => {
    const res = await fetch(`http://localhost:${PORT}/health`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("handles POST /setup", async () => {
    const setupBody: SetupBody = {
      tools: [{ name: "getEmployee", description: "Get employee", parameters: {}, script: "/path/to/script.sh" }],
      config: { model: "gpt-5", systemPrompt: "You are helpful", maxSteps: 10 },
    };
    const res = await fetch(`http://localhost:${PORT}/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(setupBody),
    });
    expect(res.ok).toBe(true);
    expect(setupCalled).toBe(true);
  });

  it("executeTool spawns bash script and returns parsed JSON", async () => {
    const script = resolve(import.meta.dirname, "../../tools/scripts/getEmployee.sh");
    const result = await executeTool(script, { employeeId: "EMP001" }) as any;
    expect(result.id).toBe("EMP001");
    expect(result.name).toBe("Marco Rossi");
  });

  it("executeTool rejects on unknown tool script", async () => {
    await expect(executeTool("/nonexistent/script.sh", {})).rejects.toThrow();
  });

  it("handles POST /send-message and delegates to callback", async () => {
    const body: SendMessageBody = {
      history: [{ role: "user", content: "Hello" }],
      seed: 42,
    };
    const res = await fetch(`http://localhost:${PORT}/send-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.ok).toBe(true);
    const result: SendMessageResponse = await res.json();
    expect(result.content).toBe("test response");
    expect(result.durationMs).toBe(50);
    expect(lastSendBody?.history[0].content).toBe("Hello");
    expect(lastSendBody?.seed).toBe(42);
  });
});
