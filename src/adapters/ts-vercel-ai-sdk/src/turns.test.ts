import { type RuntimeEvent, ratel } from "@ratel-ai/sdk";
import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AiSdkOptions, aiSdk } from "./aisdk.js";
import { MockLanguageModelV2, usage } from "./test-support/mock-model.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

async function deployView(options?: AiSdkOptions) {
  const view = ratel().adaptTo(aiSdk(options));
  await view.tools.register({
    deploy_app: tool({
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

type View = Awaited<ReturnType<typeof deployView>>;

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

function call(id: string, toolName: string, input: unknown = {}) {
  return { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) };
}

function step(...content: unknown[]) {
  return { content, finishReason: "tool-calls", usage, warnings: [] };
}

const done = {
  content: [{ type: "text", text: "done" }],
  finishReason: "stop",
  usage,
  warnings: [],
};

const invokeDeploy = (id: string) => call(id, "invoke_tool", { toolId: "deploy_app", args: {} });

function generate(view: View, model: MockLanguageModelV2, prompt: string, extraTools = {}) {
  return generateText({
    model: model as unknown as LanguageModel,
    tools: { ...view.modelTools(), ...extraTools },
    messages: [{ role: "user", content: prompt }],
    prepareStep: view.prepareStep,
    stopWhen: stepCountIs(5),
  });
}

describe("one Ratel turn per AI SDK call", () => {
  it("opens a turn in prepareStep that every step's tool calls carry", async () => {
    const view = await deployView();
    const model = new MockLanguageModelV2([step(invokeDeploy("a")), step(invokeDeploy("b")), done]);
    const events = await capture(view, () => generate(view, model, "deploy to production"));

    const [start, ...more] = ofType(events, "turn_start");
    expect(more).toEqual([]);
    expect(start?.turn_id).toEqual(expect.any(String));
    expect(start).not.toHaveProperty("user_message");
    const turnId = start?.turn_id;
    expect(ofType(events, "search").map((e) => e.turn_id)).toEqual([turnId]);
    expect(ofType(events, "invoke_start").map((e) => e.turn_id)).toEqual([turnId, turnId]);
    expect(ofType(events, "gateway_invoke").map((e) => e.turn_id)).toEqual([turnId, turnId]);
  });

  it("sends the user's message only with captureUserMessage", async () => {
    const view = await deployView({ captureUserMessage: true });
    const model = new MockLanguageModelV2([done]);
    const events = await capture(view, () => generate(view, model, "deploy to production"));

    expect(ofType(events, "turn_start")[0]?.user_message).toBe("deploy to production");
  });

  it("keeps two concurrent calls in their own turns", async () => {
    const view = await deployView();
    const first = new MockLanguageModelV2([step(invokeDeploy("a")), step(invokeDeploy("b")), done]);
    const second = new MockLanguageModelV2([step(invokeDeploy("c")), done]);
    const events = await capture(view, () =>
      Promise.all([
        generate(view, first, "deploy to production"),
        generate(view, second, "please deploy the app again"),
      ]),
    );

    const starts = ofType(events, "turn_start").map((e) => e.turn_id);
    expect(new Set(starts).size).toBe(2);
    const searches = ofType(events, "search");
    const turnOf = (query: string) => searches.find((e) => e.query === query)?.turn_id;
    const firstTurn = turnOf("deploy to production");
    const secondTurn = turnOf("please deploy the app again");
    expect([firstTurn, secondTurn].sort()).toEqual([...starts].sort());
    const invokes = ofType(events, "invoke_start").map((e) => e.turn_id);
    expect(invokes.filter((id) => id === firstTurn)).toHaveLength(2);
    expect(invokes.filter((id) => id === secondTurn)).toHaveLength(1);
  });

  it("finds the turn by the user message when recall found nothing", async () => {
    const view = await deployView();
    const model = new MockLanguageModelV2([
      step(call("s", "search_capabilities", { query: "zzz" })),
      done,
    ]);
    const events = await capture(view, () => generate(view, model, "qqqq xxxx"));

    const turnId = ofType(events, "turn_start")[0]?.turn_id;
    expect(turnId).toEqual(expect.any(String));
    // One from the host-side recall, one from the model's own search.
    expect(ofType(events, "gateway_search").map((e) => [e.origin, e.turn_id])).toEqual([
      ["direct", turnId],
      ["agent", turnId],
    ]);
  });

  it("opens the turn from appendRecall too", async () => {
    const view = await deployView();
    const model = new MockLanguageModelV2(
      [],
      [
        streamResult(invokeDeploy("a"), { type: "finish", finishReason: "tool-calls", usage }),
        streamResult(
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "ok" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: "stop", usage },
        ),
      ],
    );
    const messages: ModelMessage[] = [{ role: "user", content: "deploy to production" }];
    const events = await capture(view, async () => {
      const result = streamText({
        model: model as unknown as LanguageModel,
        tools: view.modelTools(),
        messages: await view.appendRecall(messages),
        stopWhen: stepCountIs(3),
      });
      await result.consumeStream();
    });

    const turnId = ofType(events, "turn_start")[0]?.turn_id;
    expect(turnId).toEqual(expect.any(String));
    expect(ofType(events, "invoke_end").map((e) => e.turn_id)).toEqual([turnId]);
  });

  it("joins the host's own turn instead of opening another", async () => {
    const view = await deployView({ captureUserMessage: true });
    const model = new MockLanguageModelV2([step(invokeDeploy("a")), step(invokeDeploy("b")), done]);
    const events = await capture(view, () =>
      view.turn(() => generate(view, model, "deploy to production"), {
        id: "request-9",
        endUserId: "user-3",
      }),
    );

    expect(ofType(events, "turn_start")).toEqual([
      expect.objectContaining({ turn_id: "request-9", end_user_id: "user-3" }),
    ]);
    expect(ofType(events, "turn_start")[0]).not.toHaveProperty("user_message");
    for (const event of ofType(events, "invoke_start")) {
      expect(event).toMatchObject({ turn_id: "request-9", end_user_id: "user-3" });
    }
  });

  it("records the host's own tools the model ran, once, without double-counting Ratel's", async () => {
    const view = await deployView();
    const lookup = tool({
      description: "Look up a customer.",
      inputSchema: z.object({}),
      execute: async () => ({ found: true }),
    });
    const broken = tool({
      description: "Always fails.",
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error("upstream down");
      },
    });
    const model = new MockLanguageModelV2([
      step(call("l", "lookup_customer"), invokeDeploy("a")),
      step(call("x", "broken_tool")),
      done,
    ]);
    const events = await capture(view, () =>
      generate(view, model, "deploy to production", {
        lookup_customer: lookup,
        broken_tool: broken,
      }),
    );

    const turnId = ofType(events, "turn_start")[0]?.turn_id;
    const external = events.filter((e) => e.origin === "external");
    expect(external.map((e) => [e.type, e.tool_id, e.turn_id])).toEqual([
      ["invoke_start", "lookup_customer", turnId],
      ["invoke_end", "lookup_customer", turnId],
      ["invoke_start", "broken_tool", turnId],
      ["invoke_error", "broken_tool", turnId],
    ]);
    expect(ofType(events, "invoke_error")[0]?.error).toContain("upstream down");
    expect(ofType(events, "invoke_start").map((e) => e.tool_id)).toEqual([
      "deploy_app",
      "lookup_customer",
      "broken_tool",
    ]);
  });

  it("does nothing new against an SDK without the turn scope", async () => {
    const recalls: string[] = [];
    const adapter = aiSdk({ captureUserMessage: true });
    const legacyBase = {
      recall: async (query: string) => {
        recalls.push(query);
        return [];
      },
    };
    const ext = adapter.extend?.(legacyBase as never);
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }];

    await expect(ext?.appendRecall(messages)).resolves.toBe(messages);
    await expect(ext?.prepareStep({ stepNumber: 0, messages, steps: [] })).resolves.toBeUndefined();
    await expect(
      ext?.prepareStep({ stepNumber: 1, messages, steps: [{ content: [call("a", "x")] }] }),
    ).resolves.toBeUndefined();
    expect(recalls).toEqual(["hello", "hello"]);
  });
});

function streamResult(...chunks: unknown[]): { stream: ReadableStream<unknown> } {
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}
