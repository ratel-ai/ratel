import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { aiSdkModels } from "./ai-sdk.js";
import { executeRun, GEN_AI_CONVERSATION_ID, GEN_AI_OPERATION_NAME } from "./dev/execute.js";
import {
  buildManifest,
  RATEL_SANDBOX_INPUT,
  runSandbox,
  SandboxInputError,
  sandbox,
} from "./index.js";
import { docsSandbox } from "./test-support/docs.sandbox.js";
import { StreamModel } from "./test-support/stream-model.js";

// A chat sandbox (spec §3.2): one run per user turn, the conversation so far in
// input.messages, the reply streamed as text.delta events.

const CONVERSATION: ModelMessage[] = [
  { role: "user", content: "How do I install the SDK?" },
  { role: "assistant", content: "Run npm install @ratel-ai/sdk." },
  { role: "user", content: "And for Python?" },
];

function gatewaySandbox(model: StreamModel) {
  return docsSandbox(
    aiSdkModels({
      env: { AI_GATEWAY_API_KEY: "gw_test" },
      load: async () => ({ createGateway: () => () => model }),
      installed: () => true,
    }),
  );
}

const providers: NodeTracerProvider[] = [];
afterEach(async () => {
  for (const p of providers.splice(0)) await p.shutdown();
  trace.disable();
  context.disable();
});

describe("sandbox.chat()", () => {
  it("passes the two prior messages and the user turn to run() and streams the reply", async () => {
    const model = new StreamModel("anthropic/claude-sonnet-5-5", ["pip install ", "ratel-ai"]);
    const deltas: string[] = [];

    const result = await runSandbox(gatewaySandbox(model), {
      input: { messages: CONVERSATION },
      onText: (text) => deltas.push(text),
    });

    expect(deltas).toEqual(["pip install ", "ratel-ai"]);
    expect(result.output).toBe("pip install ratel-ai");
    const prompt = model.calls[0]?.prompt as { role: string }[];
    expect(prompt.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("runs under invoke_agent with the session as gen_ai.conversation.id and emits text.delta events", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    providers.push(provider);
    const events: unknown[] = [];

    const result = await executeRun(gatewaySandbox(new StreamModel("m", ["Hi", " there"])), {
      runId: "run_1",
      start: {
        sandboxId: "docs-agent",
        sessionId: "pgs_chat_1",
        input: { messages: CONVERSATION },
        params: {},
        configHash: "0".repeat(64),
      },
      tracer: trace.getTracer("test"),
      signal: new AbortController().signal,
      onEvent: (payload) => events.push(payload),
    });

    expect(result).toMatchObject({ status: "ok", output: "Hi there" });
    expect(events).toEqual([
      { kind: "text.delta", text: "Hi" },
      { kind: "text.delta", text: " there" },
    ]);
    const root = exporter.getFinishedSpans().find((s) => s.name === "invoke_agent docs-agent");
    expect(root?.attributes[GEN_AI_OPERATION_NAME]).toBe("invoke_agent");
    expect(root?.attributes[GEN_AI_CONVERSATION_ID]).toBe("pgs_chat_1");
    // The conversation is content: it is never stamped as a structured input.
    expect(root?.attributes[RATEL_SANDBOX_INPUT]).toBeUndefined();
  });

  it("rejects an input without messages before run() is called", async () => {
    let called = false;
    const t = sandbox("chat-probe", {
      params: {},
      input: sandbox.chat(),
      run: () => {
        called = true;
      },
    });
    await expect(runSandbox(t, { input: { messages: [] } })).rejects.toThrow(SandboxInputError);
    await expect(
      runSandbox(t, { input: { messages: [{ content: "x" }] } as never }),
    ).rejects.toThrow("messages[0] must be an object with a string role");
    expect(called).toBe(false);
  });

  it("lists a chat input and its context in the manifest", () => {
    const manifest = buildManifest({
      sandboxes: [{ sandbox: gatewaySandbox(new StreamModel("m", [])), file: "docs.sandbox.ts" }],
      env: {},
    });
    expect(manifest.sandboxes[0]).toMatchObject({
      id: "docs-agent",
      modelResolver: "builtin",
      modelKind: "language-model",
      input: { kind: "chat" },
      context: [{ name: "userId", default: "demo-user" }],
    });
  });
});

describe("sandbox.context()", () => {
  it("gives run() the declared defaults, with per-run values on top", async () => {
    const t = sandbox("ctx-probe", {
      params: {},
      input: sandbox.chat(),
      context: sandbox.context({ orgId: "org_demo", plan: "pro" }),
      run: ({ ctx }) => ctx.context,
    });
    const result = await runSandbox(t, {
      input: { messages: [{ role: "user", content: "hi" }] },
      context: { orgId: "org_other" },
    });
    expect(result.output).toEqual({ orgId: "org_other", plan: "pro" });
  });

  it("refuses a context name that is not a valid identifier", () => {
    expect(() =>
      sandbox("ctx-bad", {
        params: {},
        input: sandbox.chat(),
        context: sandbox.context({ "org-id": "x" }),
        run: () => null,
      }),
    ).toThrow('"org-id" is not a valid context name');
  });
});
