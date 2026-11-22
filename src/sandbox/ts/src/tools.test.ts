import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeRun } from "./dev/execute.js";
import { Runs, type RunsEffect } from "./dev/runs.js";
import {
  buildManifest,
  CONFIRM_TIMEOUT_MS,
  type ConfirmAnswer,
  type FakeAnswer,
  type FakeRequest,
  RATEL_SANDBOX_CONFIG_HASH,
  RATEL_TOOL_CONFIRM_DECISION,
  RATEL_TOOL_FAKE_SOURCE,
  RATEL_TOOL_MODE,
  REJECTED_RESULT,
  resolveLocal,
  resolveParams,
  runSandbox,
  type ToolChannel,
  ToolModeError,
} from "./index.js";
import { supportSandbox, TOOL_ARGS } from "./test-support/support.sandbox.js";

// Tool modes (spec §3.4 tools row, §3.6): real, fake and confirm per run, with
// safe defaults for side effects.

const CHAT = { messages: [{ role: "user", content: "help" }] };

/** A channel that answers from canned values and records what it was asked. */
function channel(answers: { fake?: FakeAnswer; confirm?: ConfirmAnswer | (() => Promise<never>) }) {
  const fakes: FakeRequest[] = [];
  const confirms: unknown[] = [];
  const ch: ToolChannel = {
    fake: async (request) => {
      fakes.push(request);
      return answers.fake ?? { result: { id: "FAKE-1" }, isError: false, source: "generated" };
    },
    confirm: async (request, signal) => {
      confirms.push(request);
      const answer = answers.confirm ?? { decision: "approve" };
      if (typeof answer === "function") {
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      }
      return answer;
    },
  };
  return { ch, fakes, confirms };
}

const providers: NodeTracerProvider[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const p of providers.splice(0)) await p.shutdown();
  trace.disable();
  context.disable();
});

describe("sandbox.tools()", () => {
  it("returns a toolset of the same shape with edited descriptions and disabled tools removed", () => {
    const { sandbox } = supportSandbox();
    const { values } = resolveParams(sandbox, {
      tools: [
        { name: "searchDocs", description: "Search the Ratel docs by keyword." },
        { name: "askExpert" },
      ],
    });
    const tools = values.tools as Record<string, { description?: string; execute?: unknown }>;
    expect(Object.keys(tools)).toEqual(["searchDocs", "askExpert"]);
    expect(tools.searchDocs?.description).toBe("Search the Ratel docs by keyword.");
    expect(tools.askExpert?.description).toBe("Ask a sub-agent.");
    expect(typeof tools.searchDocs?.execute).toBe("function");
  });

  it("lists each tool as plain data in the manifest, with its JSON Schema, hint, allowReal and opaque", () => {
    const manifest = buildManifest({ sandboxes: [{ sandbox: supportSandbox().sandbox }] });
    const tools = manifest.sandboxes[0]?.params.find((p) => p.kind === "tools");
    expect(tools?.default).toEqual([
      {
        name: "searchDocs",
        description: "Search the docs.",
        hint: "readOnly",
        inputSchema: expect.objectContaining({ properties: { query: { type: "string" } } }),
      },
      expect.objectContaining({ name: "createTicket", hint: "sideEffect", allowReal: false }),
      expect.objectContaining({ name: "askExpert", hint: "none", opaque: true }),
    ]);
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });

  it("refuses an override that adds a tool", () => {
    expect(() =>
      resolveParams(supportSandbox().sandbox, { tools: [{ name: "deleteAccount" }] }),
    ).toThrow('tools has an unknown tool "deleteAccount"');
  });
});

describe("tool modes", () => {
  it("defaults readOnly to real, sideEffect to fake and no hint to confirm", async () => {
    const { sandbox, calls } = supportSandbox();
    const { ch, fakes, confirms } = channel({ confirm: { decision: "reject" } });
    const result = await runSandbox(sandbox, { input: CHAT, toolChannel: ch });

    expect(result.toolModes).toEqual({
      searchDocs: "real",
      createTicket: "fake",
      askExpert: "confirm",
    });
    expect(calls.map((c) => c.tool)).toEqual(["searchDocs"]);
    expect(fakes.map((f) => f.tool)).toEqual(["createTicket"]);
    expect(confirms).toEqual([
      { callId: "call_askExpert", tool: "askExpert", args: TOOL_ARGS.askExpert },
    ]);
    expect(result.output).toEqual({
      searchDocs: [{ slug: "install", title: "Install (install)" }],
      createTicket: { id: "FAKE-1" },
      askExpert: REJECTED_RESULT,
    });
  });

  it("never runs a sideEffect tool real without allowReal: the run is refused", async () => {
    const { sandbox, calls } = supportSandbox();
    await expect(
      runSandbox(sandbox, { input: CHAT, toolModes: { createTicket: "real" } }),
    ).rejects.toThrow(ToolModeError);
    await expect(
      runSandbox(sandbox, { input: CHAT, toolModes: { createTicket: "real" } }),
    ).rejects.toThrow("createTicket: real needs allowReal: true in the sandbox file");
    expect(calls).toEqual([]);
  });

  it("runs a sideEffect tool real when the sandbox file sets allowReal", async () => {
    const { sandbox, calls } = supportSandbox({ allowReal: true });
    await runSandbox(sandbox, {
      input: CHAT,
      toolModes: { createTicket: "real", askExpert: "real" },
    });
    expect(calls.map((c) => c.tool)).toEqual(["searchDocs", "createTicket", "askExpert"]);
  });

  it("sends the fake request with the call, the schemas and the last messages, and returns its result", async () => {
    const { sandbox } = supportSandbox();
    const { ch, fakes } = channel({});
    await runSandbox(sandbox, { input: CHAT, toolChannel: ch, toolModes: { askExpert: "fake" } });
    expect(fakes[0]).toMatchObject({
      callId: "call_createTicket",
      tool: "createTicket",
      description: "Open a support ticket.",
      args: TOOL_ARGS.createTicket,
      inputSchema: expect.objectContaining({ required: ["title", "body"] }),
      messages: [{ role: "user", content: "help" }],
    });
  });

  it("answers a fake call with invalid arguments with a validation error and asks for no fake", async () => {
    const { sandbox } = supportSandbox();
    const { ch, fakes } = channel({});
    const run = await runSandbox(
      {
        ...sandbox,
        run: async ({ params }) => {
          try {
            return await params.tools.createTicket.execute?.(
              { title: "x" } as never,
              {
                toolCallId: "c1",
                messages: [],
              } as never,
            );
          } catch (err) {
            return (err as Error).message;
          }
        },
      },
      { input: CHAT, toolChannel: ch },
    );
    expect(run.output).toMatch(/^Invalid arguments for createTicket: title: .*\bbody: /);
    expect(fakes).toEqual([]);
  });

  it("emits tool.call and tool.result events with the mode and the fake source", async () => {
    const { sandbox } = supportSandbox();
    const events: unknown[] = [];
    await runSandbox(sandbox, {
      input: CHAT,
      toolChannel: channel({ confirm: { decision: "reject" } }).ch,
      onEvent: (e) => events.push(e),
    });
    expect(events).toEqual([
      {
        kind: "tool.call",
        callId: "call_searchDocs",
        tool: "searchDocs",
        args: TOOL_ARGS.searchDocs,
        mode: "real",
      },
      {
        kind: "tool.result",
        callId: "call_searchDocs",
        result: [{ slug: "install", title: "Install (install)" }],
        isError: false,
        mode: "real",
      },
      {
        kind: "tool.call",
        callId: "call_createTicket",
        tool: "createTicket",
        args: TOOL_ARGS.createTicket,
        mode: "fake",
      },
      {
        kind: "tool.result",
        callId: "call_createTicket",
        result: { id: "FAKE-1" },
        isError: false,
        mode: "fake",
        fakeSource: "generated",
      },
      {
        kind: "tool.call",
        callId: "call_askExpert",
        tool: "askExpert",
        args: TOOL_ARGS.askExpert,
        mode: "confirm",
      },
      {
        kind: "tool.result",
        callId: "call_askExpert",
        result: REJECTED_RESULT,
        isError: false,
        mode: "confirm",
        confirmDecision: "reject",
      },
    ]);
  });
});

describe("confirm", () => {
  const confirmOnly = { searchDocs: "confirm", createTicket: "fake", askExpert: "confirm" };

  it("approve runs the production execute with the model's arguments", async () => {
    const { sandbox, calls } = supportSandbox();
    const run = await runSandbox(sandbox, {
      input: CHAT,
      toolModes: confirmOnly,
      toolChannel: channel({ confirm: { decision: "approve" } }).ch,
    });
    expect(calls).toEqual([
      { tool: "searchDocs", args: TOOL_ARGS.searchDocs },
      { tool: "askExpert", args: TOOL_ARGS.askExpert },
    ]);
    expect((run.output as Record<string, unknown>).askExpert).toEqual({ answer: "42" });
  });

  it("edit runs the production execute with the reviewer's arguments", async () => {
    const { sandbox, calls } = supportSandbox();
    await runSandbox(sandbox, {
      input: CHAT,
      toolModes: confirmOnly,
      toolChannel: channel({ confirm: { decision: "edit", args: { query: "rotate key" } } }).ch,
    });
    expect(calls[0]).toEqual({ tool: "searchDocs", args: { query: "rotate key" } });
  });

  it("fake returns the reviewer's value without running the tool", async () => {
    const { sandbox, calls } = supportSandbox();
    const run = await runSandbox(sandbox, {
      input: CHAT,
      toolModes: confirmOnly,
      toolChannel: channel({ confirm: { decision: "fake", result: { answer: "pinned" } } }).ch,
    });
    expect(calls).toEqual([]);
    expect((run.output as Record<string, unknown>).askExpert).toEqual({ answer: "pinned" });
  });

  it("reject returns the rejection to the model without running the tool", async () => {
    const { sandbox, calls } = supportSandbox();
    const run = await runSandbox(sandbox, {
      input: CHAT,
      toolModes: confirmOnly,
      toolChannel: channel({ confirm: { decision: "reject" } }).ch,
    });
    expect(calls).toEqual([]);
    expect((run.output as Record<string, unknown>).searchDocs).toEqual({
      error: "Rejected by reviewer",
    });
  });

  it("approve of a sideEffect tool without allowReal still never runs it real", async () => {
    const { sandbox, calls } = supportSandbox();
    const run = await runSandbox(sandbox, {
      input: CHAT,
      toolModes: { createTicket: "confirm" },
      toolChannel: channel({ confirm: { decision: "approve" } }).ch,
    });
    expect(calls.map((c) => c.tool)).not.toContain("createTicket");
    expect((run.output as Record<string, { thrown?: string }>).createTicket?.thrown).toBe(
      "createTicket cannot run real: set allowReal: true in the sandbox file",
    );
  });

  it("rejects a call with no decision after 10 minutes", async () => {
    vi.useFakeTimers();
    const { sandbox, calls } = supportSandbox();
    const pending = runSandbox(sandbox, {
      input: CHAT,
      toolModes: { searchDocs: "confirm", askExpert: "fake" },
      toolChannel: channel({ confirm: () => new Promise<never>(() => {}) }).ch,
    });
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const run = await pending;
    expect(CONFIRM_TIMEOUT_MS).toBe(600_000);
    expect((run.output as Record<string, unknown>).searchDocs).toEqual(REJECTED_RESULT);
    expect(calls).toEqual([]);
  });
});

describe("config hash and tool modes", () => {
  it("is the same for two runs that differ only in tool modes", async () => {
    const { sandbox } = supportSandbox({ allowReal: true });
    const ch = channel({ confirm: { decision: "reject" } }).ch;
    const a = await runSandbox(sandbox, { input: CHAT, toolChannel: ch });
    const b = await runSandbox(sandbox, {
      input: CHAT,
      toolChannel: ch,
      toolModes: { searchDocs: "fake", createTicket: "real", askExpert: "fake" },
    });
    expect(a.configHash).toBe(b.configHash);
    expect(a.toolModes).not.toEqual(b.toolModes);
  });

  it("changes when a description is edited or a tool disabled, and names tools as changed", () => {
    const { sandbox } = supportSandbox();
    const base = resolveParams(sandbox, {});
    const edited = resolveParams(sandbox, {
      tools: [
        { name: "searchDocs", description: "other" },
        { name: "createTicket" },
        { name: "askExpert" },
      ],
    });
    const disabled = resolveParams(sandbox, {
      tools: [
        { name: "searchDocs" },
        { name: "createTicket", enabled: false },
        { name: "askExpert" },
      ],
    });
    const same = resolveParams(sandbox, {
      tools: [{ name: "searchDocs" }, { name: "createTicket" }, { name: "askExpert" }],
    });
    expect(new Set([base.configHash, edited.configHash, disabled.configHash]).size).toBe(3);
    expect(same.configHash).toBe(base.configHash);
    expect(same.overrides).toEqual([]);
    expect(edited.overrides).toEqual(["tools"]);
  });

  it("matches the production hash of the same defaults (baseline = production)", () => {
    const { sandbox, defaults } = supportSandbox();
    const provider = new NodeTracerProvider();
    provider.register();
    providers.push(provider);
    let stamped: unknown;
    trace.getTracer("t").startActiveSpan("invoke_agent support", (span) => {
      resolveLocal(defaults, { sandbox: "support-agent" });
      stamped = (span as unknown as { attributes: Record<string, unknown> }).attributes[
        RATEL_SANDBOX_CONFIG_HASH
      ];
      span.end();
    });
    expect(stamped).toBe(resolveParams(sandbox, {}).configHash);
  });
});

describe("execute_tool spans", () => {
  function exporter() {
    const memory = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
    provider.register();
    providers.push(provider);
    return memory;
  }

  it("carry the mode, the fake source and the confirm decision", async () => {
    const memory = exporter();
    await runSandbox(supportSandbox().sandbox, {
      input: CHAT,
      toolChannel: channel({ confirm: { decision: "fake", result: "x" } }).ch,
    });
    const attrs = (name: string) =>
      memory.getFinishedSpans().find((s) => s.name === `execute_tool ${name}`)?.attributes;
    expect(attrs("searchDocs")).toMatchObject({
      [RATEL_TOOL_MODE]: "real",
      "gen_ai.tool.name": "searchDocs",
    });
    expect(attrs("createTicket")).toMatchObject({
      [RATEL_TOOL_MODE]: "fake",
      [RATEL_TOOL_FAKE_SOURCE]: "generated",
    });
    expect(attrs("askExpert")).toMatchObject({
      [RATEL_TOOL_MODE]: "confirm",
      [RATEL_TOOL_CONFIRM_DECISION]: "fake",
      [RATEL_TOOL_FAKE_SOURCE]: "pinned",
    });
  });

  it("go on the AI SDK's execute_tool span when it is active, without a second span", async () => {
    const memory = exporter();
    const { sandbox } = supportSandbox();
    const tracer = trace.getTracer("gen_ai");
    await runSandbox(
      {
        ...sandbox,
        run: ({ params }) =>
          tracer.startActiveSpan("execute_tool searchDocs", async (span) => {
            await params.tools.searchDocs.execute?.(TOOL_ARGS.searchDocs, {
              toolCallId: "c1",
              messages: [],
            } as never);
            span.end();
          }),
      },
      { input: CHAT },
    );
    const spans = memory.getFinishedSpans().filter((s) => s.name === "execute_tool searchDocs");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes[RATEL_TOOL_MODE]).toBe("real");
  });
});

describe("ratel sandbox dev: tool modes in run.start", () => {
  const T0 = new Date("2026-11-20T10:00:00Z");
  const manifest = buildManifest({ sandboxes: [{ sandbox: supportSandbox().sandbox }] });
  const start = (toolModes: Record<string, string>) => ({
    v: 1 as const,
    type: "run.start",
    id: "c_1",
    ts: T0.toISOString(),
    runId: "run_1",
    payload: {
      sandboxId: "support-agent",
      input: CHAT,
      params: {},
      toolModes,
      configHash: "0".repeat(64),
    },
  });
  const runs = () => new Runs({ stamp: { nextId: () => "w_1", now: () => T0 }, maxConcurrency: 1 });
  const sent = (effects: RunsEffect[]) =>
    effects.flatMap((e) => (e.type === "send" ? [e.frame] : []));

  it("rejects real for a sideEffect tool without allowReal before it acks", () => {
    const [reject] = sent(runs().start(start({ createTicket: "real" }), manifest, T0));
    expect(reject).toMatchObject({
      type: "run.reject",
      payload: {
        reason: "invalid_params",
        errors: [
          {
            param: "toolModes",
            message: "createTicket: real needs allowReal: true in the sandbox file",
          },
        ],
      },
    });
  });

  it("sends a tool request, resends it on a new socket until answered, and routes the answer", () => {
    const r = runs();
    r.start(start({}), manifest, T0);
    const [request] = sent(
      r.toolRequest("run_1", "tool.confirm.request", { callId: "c1", tool: "askExpert", args: {} }),
    );
    expect(request).toMatchObject({
      type: "tool.confirm.request",
      runId: "run_1",
      payload: { callId: "c1" },
    });
    expect(r.unacked()).toContainEqual(request);

    const decision = {
      v: 1 as const,
      type: "tool.confirm.decision",
      id: "c_2",
      ts: T0.toISOString(),
      runId: "run_1",
      payload: { callId: "c1", decision: "approve" },
    };
    expect(r.toolAnswer({ ...decision, type: "tool.fake.result" })).toEqual([]);
    expect(r.toolAnswer(decision)).toEqual([
      {
        type: "tool-answer",
        runId: "run_1",
        answerType: "tool.confirm.decision",
        payload: decision.payload,
      },
    ]);
    expect(r.toolAnswer(decision)).toEqual([]);
    expect(r.unacked()).not.toContainEqual(request);
  });

  it("refuses a real side effect in the child too, whatever the server sends", async () => {
    const result = await executeRun(supportSandbox().sandbox, {
      runId: "run_1",
      start: start({ createTicket: "real" }).payload,
      tracer: trace.getTracer("t"),
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(result).toMatchObject({
      status: "error",
      error: { code: "invalid_params", message: expect.stringContaining("allowReal") },
    });
  });
});
