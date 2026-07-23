import { Agent } from "@mastra/core/agent";
// Mastra ships its built-in mock as JS with no type declarations; test files are
// excluded from `tsc`, so the plain import is fine and keeps the loop authentic.
import { createMockModel } from "@mastra/core/test-utils/llm-mock";
import { createTool } from "@mastra/core/tools";
import { ratel, SEARCH_CAPABILITIES_ID } from "@ratel-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mastra } from "./mastra.js";

// Drives the REAL Mastra Agent loop with a mock model (no API key, no network),
// exercising what the codec + processor unit tests can't: that the recall pair the
// recallProcessor injects actually reaches the model prompt through Mastra's own
// message pipeline.

function viewWithDeployTool() {
  const view = ratel().adaptTo(mastra());
  view.tools.register({
    deploy_app: createTool({
      id: "deploy_app",
      description: "Deploy the app to production servers.",
      inputSchema: z.object({}),
      execute: async () => ({ deployed: true }),
    }),
  });
  return view;
}

describe("Agent integration (the real Mastra loop)", () => {
  it("injects the recall pair into the model prompt for a user turn", async () => {
    const view = viewWithDeployTool();
    const prompts: unknown[][] = [];
    const model = createMockModel({
      mockText: "deployed.",
      spyGenerate: (props: { prompt: unknown[] }) => prompts.push(props.prompt),
    });
    const agent = new Agent({
      id: "integration",
      name: "integration",
      instructions: "help the user",
      model,
      tools: view.modelTools(),
      inputProcessors: [view.recallProcessor()],
    });

    const result = await agent.generate("deploy to production");
    expect(result.text).toContain("deployed");
    expect(prompts).toHaveLength(1);
    // Both halves of the recall reached the model: Mastra expands the single
    // format-2 assistant message into an assistant tool-CALL plus a role:"tool"
    // tool-RESULT, so the recall id appears exactly twice. A dropped or reshaped
    // tool-result half pushes the count below 2 and fails this assertion.
    expect(recallIdOccurrences(prompts[0], "recall_0")).toBe(2);
    expect(JSON.stringify(prompts[0])).toContain(SEARCH_CAPABILITIES_ID);
    // The recalled capability id rode along in the tool-result payload — guards
    // the result half specifically, not just the assistant tool-call.
    expect(JSON.stringify(prompts[0])).toContain("deploy_app");
    // Exactly one recall pair for the turn — never re-injected as recall_1.
    expect(recallIdOccurrences(prompts[0], "recall_1")).toBe(0);
  });

  it("mints a fresh recall id per user turn (processInput = once per generation)", async () => {
    const view = viewWithDeployTool();
    const prompts: unknown[][] = [];
    const model = createMockModel({
      mockText: "ok",
      spyGenerate: (props: { prompt: unknown[] }) => prompts.push(props.prompt),
    });
    const agent = new Agent({
      id: "integration2",
      name: "integration2",
      instructions: "help the user",
      model,
      tools: view.modelTools(),
      inputProcessors: [view.recallProcessor()],
    });

    await agent.generate("deploy to production");
    await agent.generate("deploy the service again");
    expect(recallIdOccurrences(prompts[0], "recall_0")).toBe(2);
    expect(recallIdOccurrences(prompts[1], "recall_1")).toBe(2);
  });

  it("recalls via processInput, not processInputStep (no re-injection during the tool loop)", () => {
    const processor = viewWithDeployTool().recallProcessor() as {
      processInput?: unknown;
      processInputStep?: unknown;
    };
    expect(typeof processor.processInput).toBe("function");
    expect(processor.processInputStep).toBeUndefined();
  });
});

// Count a recall call id's occurrences in the raw prompt the model saw. A live
// recall pair is rendered as two model messages (assistant tool-call + tool
// result), so a surviving pair shows the id twice. Mirrors the sibling AI SDK
// adapter's `generate-text.test.ts` helper.
function recallIdOccurrences(prompt: unknown[], callId: string): number {
  return JSON.stringify(prompt).split(callId).length - 1;
}
