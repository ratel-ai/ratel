import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { type RuntimeEvent, ratel } from "@ratel-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type MastraOptions, mastra } from "./mastra.js";

// Drives the real Mastra Agent loop with a scripted model that calls tools, so
// the turn has to survive Mastra's own step machinery.

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

type Part = { type: "tool-call"; toolCallId: string; toolName: string; input: string };

function toolCall(id: string, toolName: string, input: unknown = {}): Part {
  return { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) };
}

const invokeDeploy = (id: string) =>
  toolCall(id, "invoke_tool", { toolId: "deploy_app", args: {} });

/** A language model that answers each generate call with the next scripted step. */
function scriptedModel(steps: Part[][]) {
  let call = 0;
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock",
    supportedUrls: {},
    async doGenerate() {
      const parts = steps[call++];
      if (parts === undefined || parts.length === 0) {
        return {
          content: [{ type: "text", text: "done" }],
          finishReason: "stop",
          usage,
          warnings: [],
        };
      }
      return { content: parts, finishReason: "tool-calls", usage, warnings: [] };
    },
    async doStream() {
      throw new Error("not scripted");
    },
  };
}

function viewWithDeployTool(options?: MastraOptions) {
  const view = ratel().adaptTo(mastra(options));
  view.tools.register({
    deploy_app: createTool({
      id: "deploy_app",
      description: "Deploy the app to production servers.",
      inputSchema: z.object({}),
      execute: async () => {
        await tick();
        return { deployed: true };
      },
    }),
  });
  return view;
}

type View = ReturnType<typeof viewWithDeployTool>;

function agentFor(view: View, steps: Part[][], extraTools = {}) {
  return new Agent({
    id: "turns",
    name: "turns",
    instructions: "help the user",
    model: scriptedModel(steps) as never,
    tools: { ...view.modelTools(), ...extraTools },
    inputProcessors: [view.recallProcessor()],
  });
}

async function capture(view: View, work: () => Promise<unknown>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  const subscription = view.events.subscribe((batch) => {
    events.push(...batch);
  });
  await work();
  await subscription.flush();
  subscription.unsubscribe();
  return events;
}

const ofType = (events: RuntimeEvent[], type: string) => events.filter((e) => e.type === type);

describe("one Ratel turn per Mastra generation", () => {
  it("opens a turn in the recall processor that every step's tool calls carry", async () => {
    const view = viewWithDeployTool();
    const agent = agentFor(view, [[invokeDeploy("a")], [invokeDeploy("b")]]);
    const events = await capture(view, () => agent.generate("deploy to production"));

    const [start, ...more] = ofType(events, "turn_start");
    expect(more).toEqual([]);
    expect(start).not.toHaveProperty("user_message");
    const turnId = start?.turn_id;
    expect(turnId).toEqual(expect.any(String));
    expect(ofType(events, "search").map((e) => e.turn_id)).toEqual([turnId]);
    expect(ofType(events, "invoke_start").map((e) => e.turn_id)).toEqual([turnId, turnId]);
  });

  it("sends the user's message only with captureUserMessage", async () => {
    const view = viewWithDeployTool({ captureUserMessage: true });
    const events = await capture(view, () => agentFor(view, []).generate("deploy to production"));

    expect(ofType(events, "turn_start")[0]?.user_message).toBe("deploy to production");
  });

  it("keeps concurrent generations in their own turns", async () => {
    const view = viewWithDeployTool();
    const events = await capture(view, () =>
      Promise.all([
        agentFor(view, [[invokeDeploy("a")], [invokeDeploy("b")]]).generate("deploy to production"),
        agentFor(view, [[invokeDeploy("c")]]).generate("please deploy the app again"),
      ]),
    );

    const searches = ofType(events, "search");
    const first = searches.find((e) => e.query === "deploy to production")?.turn_id;
    const second = searches.find((e) => e.query === "please deploy the app again")?.turn_id;
    expect(first).toEqual(expect.any(String));
    expect(second).toEqual(expect.any(String));
    expect(first).not.toBe(second);
    const invokes = ofType(events, "invoke_start").map((e) => e.turn_id);
    expect(invokes.filter((id) => id === first)).toHaveLength(2);
    expect(invokes.filter((id) => id === second)).toHaveLength(1);
  });

  it("joins the host's own turn instead of opening another", async () => {
    const view = viewWithDeployTool({ captureUserMessage: true });
    const agent = agentFor(view, [[invokeDeploy("a")]]);
    const events = await capture(view, () =>
      view.turn(() => agent.generate("deploy to production"), { id: "req-1", endUserId: "u-1" }),
    );

    expect(ofType(events, "turn_start")).toEqual([
      expect.objectContaining({ turn_id: "req-1", end_user_id: "u-1" }),
    ]);
    expect(ofType(events, "invoke_end")).toEqual([
      expect.objectContaining({ turn_id: "req-1", end_user_id: "u-1" }),
    ]);
  });

  it("records the Agent's own tools once, without double-counting Ratel's", async () => {
    const view = viewWithDeployTool();
    const lookup = createTool({
      id: "lookup_customer",
      description: "Look up a customer.",
      inputSchema: z.object({}),
      execute: async () => ({ found: true }),
    });
    const agent = agentFor(
      view,
      [[toolCall("l", "lookup_customer"), invokeDeploy("a")], [toolCall("m", "lookup_customer")]],
      { lookup_customer: lookup },
    );
    const events = await capture(view, () => agent.generate("deploy to production"));

    const turnId = ofType(events, "turn_start")[0]?.turn_id;
    const external = events.filter((e) => e.origin === "external");
    expect(external.map((e) => [e.type, e.tool_id, e.turn_id])).toEqual([
      ["invoke_start", "lookup_customer", turnId],
      ["invoke_end", "lookup_customer", turnId],
      ["invoke_start", "lookup_customer", turnId],
      ["invoke_end", "lookup_customer", turnId],
    ]);
    expect(ofType(events, "invoke_start").filter((e) => e.tool_id === "deploy_app")).toHaveLength(
      1,
    );
  });

  it("does nothing new against an SDK without the turn scope", async () => {
    const recalls: string[] = [];
    const ext = mastra({ captureUserMessage: true }).extend?.({
      recall: async (query: string) => {
        recalls.push(query);
        return [];
      },
    } as never);
    const processor = ext?.recallProcessor() as unknown as {
      processInput(args: unknown): Promise<unknown>;
      processInputStep(args: unknown): unknown;
    };
    const messages = [
      {
        id: "u",
        role: "user",
        createdAt: new Date(),
        content: { format: 2, parts: [{ type: "text", text: "hi" }] },
      },
    ];

    await expect(processor.processInput({ messages })).resolves.toBe(messages);
    expect(processor.processInputStep({ messages, state: {} })).toBeUndefined();
    expect(recalls).toEqual(["hi"]);
  });
});
