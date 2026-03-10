import { describe, it, expect, vi, beforeEach } from "vitest";
import { Subject } from "rxjs";
import { take } from "rxjs/operators";
import type { BaseEvent } from "@ag-ui/client";

// --- Mock setup ---

const mockSdkCreateInstance = vi.fn(async () => ({ instanceId: "inst-1" }));
const mockSdkRegister = vi.fn(async () => ({ registered: 5 }));
const mockSdkPrefetch = vi.fn<[], Promise<unknown[]>>(async () => []);
const mockSdkCaptureTurn = vi.fn(async () => ({ turnId: "turn-1" }));
const mockSdkGetFrontendToolNames = vi.fn(() => [] as string[]);
const mockSdkGetFrontendTools = vi.fn(() => [] as Array<{ name: string; description: string; parameters: Record<string, unknown> }>);
const mockDiscoverExecute = vi.fn(async () => []);
const mockSdkAsDiscoverTool = vi.fn(() => ({
  definition: {
    name: "agentified_discover",
    description: "Discover tools",
    parameters: {},
  },
  execute: mockDiscoverExecute,
}));

vi.mock("@agentified/sdk", () => ({
  ApiClient: vi.fn(() => ({
    createInstance: mockSdkCreateInstance,
    register: mockSdkRegister,
    prefetch: mockSdkPrefetch,
    captureTurn: mockSdkCaptureTurn,
    getFrontendToolNames: mockSdkGetFrontendToolNames,
    getFrontendTools: mockSdkGetFrontendTools,
    asDiscoverTool: mockSdkAsDiscoverTool,
  })),
}));

let agentStream: Subject<BaseEvent>;
const mockMastraAgentRun = vi.fn();

vi.mock("@ag-ui/mastra", () => ({
  MastraAgent: vi.fn(() => ({ run: mockMastraAgentRun })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateTool = vi.fn((config: any) => ({
  id: config.id,
  description: config.description,
  execute: config.execute,
}));

vi.mock("@mastra/core/tools", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createTool: (...args: any[]) => mockCreateTool(...args),
}));

import { AgentifiedMastra } from "./adapter.js";

function defaultConfig() {
  return {
    agentifiedUrl: "http://localhost:9119",
    tools: [
      {
        name: "viewEmployee",
        description: "View employee details",
        parameters: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ],
    toolHandlers: {
      viewEmployee: vi.fn(async () => ({ id: "EMP001", name: "Alice" })),
    },
    agent: { name: "test", __setTools: vi.fn(), stream: vi.fn() } as any,
  };
}

describe("AgentifiedMastra", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentStream = new Subject<BaseEvent>();
    mockMastraAgentRun.mockReturnValue(agentStream.asObservable());
    mockSdkPrefetch.mockResolvedValue([
      {
        name: "viewEmployee",
        description: "View employee",
        parameters: {},
        score: 0.9,
      },
    ]);
    mockSdkGetFrontendToolNames.mockReturnValue([]);
    mockSdkGetFrontendTools.mockReturnValue([]);
  });

  it("register() delegates to SDK", async () => {
    const am = new AgentifiedMastra(defaultConfig());
    const result = await am.register();
    expect(mockSdkRegister).toHaveBeenCalled();
    expect(result).toEqual({ registered: 5 });
  });

  it("run() emits RUN_STARTED as first event", async () => {
    const am = new AgentifiedMastra(defaultConfig());
    const obs = await am.run({
      messages: [{ role: "user", content: "hi" }],
    });

    const events: BaseEvent[] = [];
    obs.pipe(take(2)).subscribe((e) => events.push(e));

    expect(events[0]!.type).toBe("RUN_STARTED");
    agentStream.complete();
  });

  it("run() emits prefetch CUSTOM as second event", async () => {
    const am = new AgentifiedMastra(defaultConfig());
    const obs = await am.run({
      messages: [{ role: "user", content: "hi" }],
    });

    const events: BaseEvent[] = [];
    obs.pipe(take(2)).subscribe((e) => events.push(e));

    expect(events[1]!.type).toBe("CUSTOM");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((events[1] as any).name).toBe("agentified:prefetch:complete");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((events[1] as any).value.tools).toEqual([
      {
        name: "viewEmployee",
        description: "View employee",
        parameters: {},
        score: 0.9,
      },
    ]);
    agentStream.complete();
  });

  it("run() calls prefetch with messages", async () => {
    const am = new AgentifiedMastra(defaultConfig());
    await am.run({ messages: [{ role: "user", content: "hello" }] });

    expect(mockSdkPrefetch).toHaveBeenCalledWith(
      "inst-1",
      expect.objectContaining({
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    agentStream.complete();
  });

  it("run() excludes unavailable frontend tools", async () => {
    mockSdkGetFrontendToolNames.mockReturnValue([
      "confirm_action",
      "show_modal",
    ]);
    const am = new AgentifiedMastra(defaultConfig());

    await am.run({
      messages: [{ role: "user", content: "hi" }],
      frontendTools: ["confirm_action"],
    });

    expect(mockSdkPrefetch).toHaveBeenCalledWith(
      "inst-1",
      expect.objectContaining({ exclude: ["show_modal"] }),
    );
    agentStream.complete();
  });

  it("run() converts ranked tools to Mastra tools", async () => {
    const am = new AgentifiedMastra(defaultConfig());
    await am.run({ messages: [{ role: "user", content: "hi" }] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolIds = mockCreateTool.mock.calls.map((c: any) => c[0].id);
    expect(toolIds).toContain("viewEmployee");
    agentStream.complete();
  });

  it("run() injects discover tool", async () => {
    const am = new AgentifiedMastra(defaultConfig());
    await am.run({ messages: [{ role: "user", content: "hi" }] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolIds = mockCreateTool.mock.calls.map((c: any) => c[0].id);
    expect(toolIds).toContain("agentified_discover");
    agentStream.complete();
  });

  it("run() skips duplicate RUN_STARTED from MastraAgent", async () => {
    const am = new AgentifiedMastra(defaultConfig());
    const obs = await am.run({
      messages: [{ role: "user", content: "hi" }],
    });

    const events: BaseEvent[] = [];
    const sub = obs.subscribe((e) => events.push(e));

    agentStream.next({
      type: "RUN_STARTED",
      runId: "r1",
      threadId: "t1",
    } as BaseEvent);
    agentStream.next({
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
    } as BaseEvent);
    agentStream.complete();

    const runStartedCount = events.filter(
      (e) => e.type === "RUN_STARTED",
    ).length;
    expect(runStartedCount).toBe(1);
    sub.unsubscribe();
  });

  it("run() routes discover events to Observable", async () => {
    mockDiscoverExecute.mockResolvedValueOnce([
      { name: "found_tool", description: "Found", parameters: {}, score: 0.8 },
    ]);

    const am = new AgentifiedMastra(defaultConfig());
    const obs = await am.run({
      messages: [{ role: "user", content: "hi" }],
    });

    const events: BaseEvent[] = [];
    const sub = obs.subscribe((e) => events.push(e));

    // Find the discover tool's execute from createTool mock
    const discoverCall = mockCreateTool.mock.calls.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any) => c[0].id === "agentified_discover",
    );
    expect(discoverCall).toBeDefined();

    // Execute the discover tool (simulates agent calling it)
    await discoverCall![0].execute({ query: "find tools" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const discoverEvents = events.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) =>
        e.type === "CUSTOM" && e.name?.startsWith("agentified:discover:"),
    );
    expect(discoverEvents).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((discoverEvents[0] as any).name).toBe("agentified:discover:start");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((discoverEvents[1] as any).name).toBe(
      "agentified:discover:complete",
    );

    agentStream.complete();
    sub.unsubscribe();
  });

  it("run() builds frontend clientTool defs", async () => {
    mockSdkGetFrontendToolNames.mockReturnValue(["confirm_action"]);
    mockSdkGetFrontendTools.mockReturnValue([
      {
        name: "confirm_action",
        description: "Confirm action",
        parameters: { type: "object" },
      },
    ]);

    const am = new AgentifiedMastra(defaultConfig());
    const obs = await am.run({
      messages: [{ role: "user", content: "hi" }],
      frontendTools: ["confirm_action"],
    });

    // Subscribe to trigger Observable factory (which calls MastraAgent.run)
    const sub = obs.subscribe(() => {});

    const runCall = mockMastraAgentRun.mock.calls[0]![0];
    expect(runCall.tools).toEqual([
      {
        name: "confirm_action",
        description: "Confirm action",
        parameters: { type: "object" },
      },
    ]);
    agentStream.complete();
    sub.unsubscribe();
  });

  it("run() preserves toolCallId on tool messages", async () => {
    const am = new AgentifiedMastra(defaultConfig());
    const obs = await am.run({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "Sure",
          toolCalls: [
            { id: "tc1", type: "function" as const, function: { name: "navigate_to_page", arguments: '{"page":"timeoff"}' } },
          ],
        },
        { role: "tool", content: '{"ok":true}', toolCallId: "tc1" },
      ],
    });

    const sub = obs.subscribe(() => {});

    const runCall = mockMastraAgentRun.mock.calls[0]![0];
    const toolMsg = runCall.messages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.toolCallId).toBe("tc1");

    agentStream.complete();
    sub.unsubscribe();
  });

  it("run() preserves toolCalls on assistant messages", async () => {
    const am = new AgentifiedMastra(defaultConfig());
    const obs = await am.run({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "tc1", type: "function" as const, function: { name: "nav", arguments: "{}" } },
          ],
        },
        { role: "tool", content: '{"ok":true}', toolCallId: "tc1" },
      ],
    });

    const sub = obs.subscribe(() => {});

    const runCall = mockMastraAgentRun.mock.calls[0]![0];
    const assistantMsg = runCall.messages.find((m: any) => m.toolCalls);
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.toolCalls[0].id).toBe("tc1");

    agentStream.complete();
    sub.unsubscribe();
  });

  describe("prefetch caching", () => {
    it("skips prefetch when cache exists and messages contain role=tool", async () => {
      const am = new AgentifiedMastra(defaultConfig());

      // First run — normal prefetch
      const obs1 = await am.run({ messages: [{ role: "user", content: "hi" }] });
      const sub1 = obs1.subscribe(() => {});
      agentStream.complete();
      sub1.unsubscribe();

      expect(mockSdkPrefetch).toHaveBeenCalledTimes(1);

      // Reset stream for second run
      agentStream = new Subject<BaseEvent>();
      mockMastraAgentRun.mockReturnValue(agentStream.asObservable());

      // Second run — with tool results (re-run)
      const obs2 = await am.run({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "", toolCalls: [{ id: "tc1", type: "function" as const, function: { name: "nav", arguments: "{}" } }] },
          { role: "tool", content: '{"ok":true}', toolCallId: "tc1" },
        ],
      });
      const sub2 = obs2.subscribe(() => {});
      agentStream.complete();
      sub2.unsubscribe();

      // Prefetch should NOT have been called again
      expect(mockSdkPrefetch).toHaveBeenCalledTimes(1);
    });

    it("emits prefetch:skipped event when skipping", async () => {
      const am = new AgentifiedMastra(defaultConfig());

      // First run
      const obs1 = await am.run({ messages: [{ role: "user", content: "hi" }] });
      const sub1 = obs1.subscribe(() => {});
      agentStream.complete();
      sub1.unsubscribe();

      agentStream = new Subject<BaseEvent>();
      mockMastraAgentRun.mockReturnValue(agentStream.asObservable());

      // Second run with tool results
      const obs2 = await am.run({
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", content: '{}', toolCallId: "tc1" },
        ],
      });
      const events: BaseEvent[] = [];
      const sub2 = obs2.subscribe((e) => events.push(e));
      agentStream.complete();
      sub2.unsubscribe();

      const skippedEvent = events.find(
        (e: any) => e.type === "CUSTOM" && e.name === "agentified:prefetch:skipped",
      );
      expect(skippedEvent).toBeDefined();
    });

    it("does NOT skip prefetch on first run even with tool messages", async () => {
      const am = new AgentifiedMastra(defaultConfig());

      const obs = await am.run({
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", content: '{}', toolCallId: "tc1" },
        ],
      });
      const sub = obs.subscribe(() => {});
      agentStream.complete();
      sub.unsubscribe();

      expect(mockSdkPrefetch).toHaveBeenCalledTimes(1);
    });
  });

  it("run() injects tools into agent via __setTools", async () => {
    const config = defaultConfig();
    const am = new AgentifiedMastra(config);
    const obs = await am.run({
      messages: [{ role: "user", content: "hi" }],
    });

    const sub = obs.subscribe(() => {});

    expect(config.agent.__setTools).toHaveBeenCalledWith(
      expect.objectContaining({
        viewEmployee: expect.anything(),
        agentified_discover: expect.anything(),
      }),
    );

    agentStream.complete();
    sub.unsubscribe();
  });

  describe("patchAgentStreamForGemini()", () => {
    it("injects thoughtSignature on each content part of assistant messages with tool-calls", async () => {
      const streamFn = vi.fn(async (messages: any[]) => ({ stream: true }));
      const config = {
        ...defaultConfig(),
        agent: { name: "test", __setTools: vi.fn(), stream: streamFn } as any,
      };
      const am = new AgentifiedMastra(config);

      await config.agent.stream([
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Sure" },
            { type: "tool-call", toolCallId: "tc1", toolName: "nav", args: {} },
          ],
        },
      ]);

      const patched = streamFn.mock.calls[0][0];
      expect(patched[0]).toEqual({ role: "user", content: "hi" });
      // Each part gets thoughtSignature injected
      const parts = patched[1].content;
      expect(parts[0].providerOptions.google.thoughtSignature).toBe("skip_thought_signature_validator");
      expect(parts[1].providerOptions.google.thoughtSignature).toBe("skip_thought_signature_validator");
    });

    it("does NOT overwrite existing thoughtSignature on parts", async () => {
      const streamFn = vi.fn(async (messages: any[]) => ({ stream: true }));
      const config = {
        ...defaultConfig(),
        agent: { name: "test", __setTools: vi.fn(), stream: streamFn } as any,
      };
      const am = new AgentifiedMastra(config);

      await config.agent.stream([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call", toolCallId: "tc1", toolName: "nav", args: {},
              providerOptions: { google: { thoughtSignature: "real-sig" } },
            },
          ],
        },
      ]);

      const patched = streamFn.mock.calls[0][0];
      expect(patched[0].content[0].providerOptions.google.thoughtSignature).toBe("real-sig");
    });

    it("preserves existing providerOptions on parts when injecting", async () => {
      const streamFn = vi.fn(async (messages: any[]) => ({ stream: true }));
      const config = {
        ...defaultConfig(),
        agent: { name: "test", __setTools: vi.fn(), stream: streamFn } as any,
      };
      const am = new AgentifiedMastra(config);

      await config.agent.stream([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call", toolCallId: "tc1", toolName: "nav", args: {},
              providerOptions: { openai: { mode: "fast" } },
            },
          ],
        },
      ]);

      const patched = streamFn.mock.calls[0][0];
      const part = patched[0].content[0];
      expect(part.providerOptions.openai).toEqual({ mode: "fast" });
      expect(part.providerOptions.google.thoughtSignature).toBe("skip_thought_signature_validator");
    });

    it("skips non-assistant messages", async () => {
      const streamFn = vi.fn(async (messages: any[]) => ({ stream: true }));
      const config = {
        ...defaultConfig(),
        agent: { name: "test", __setTools: vi.fn(), stream: streamFn } as any,
      };
      const am = new AgentifiedMastra(config);

      await config.agent.stream([
        { role: "user", content: "hi" },
        { role: "system", content: "you are helpful" },
      ]);

      const patched = streamFn.mock.calls[0][0];
      expect(patched[0]).toEqual({ role: "user", content: "hi" });
      expect(patched[1]).toEqual({ role: "system", content: "you are helpful" });
    });

    it("skips assistant messages without tool-call parts", async () => {
      const streamFn = vi.fn(async (messages: any[]) => ({ stream: true }));
      const config = {
        ...defaultConfig(),
        agent: { name: "test", __setTools: vi.fn(), stream: streamFn } as any,
      };
      const am = new AgentifiedMastra(config);

      await config.agent.stream([
        { role: "assistant", content: "just text" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ]);

      const patched = streamFn.mock.calls[0][0];
      expect(patched[0]).toEqual({ role: "assistant", content: "just text" });
      expect(patched[1].content[0].providerOptions).toBeUndefined();
    });

    it("passes through extra args to original stream", async () => {
      const streamFn = vi.fn(async (messages: any[], opts: any) => ({ stream: true }));
      const config = {
        ...defaultConfig(),
        agent: { name: "test", __setTools: vi.fn(), stream: streamFn } as any,
      };
      const am = new AgentifiedMastra(config);

      await config.agent.stream(
        [{ role: "user", content: "hi" }],
        { maxSteps: 5 },
      );

      expect(streamFn).toHaveBeenCalledWith(
        expect.any(Array),
        { maxSteps: 5 },
      );
    });
  });

  describe("generate()", () => {
    const mockAgentGenerate = vi.fn();

    function generateConfig() {
      return {
        agentifiedUrl: "http://localhost:9119",
        tools: [
          {
            name: "viewEmployee",
            description: "View employee details",
            parameters: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
          },
          {
            name: "updateEmployee",
            description: "Update employee details",
            parameters: {
              type: "object",
              properties: { id: { type: "string" }, name: { type: "string" } },
              required: ["id"],
            },
          },
        ],
        toolHandlers: {
          viewEmployee: vi.fn(async () => ({ id: "EMP001", name: "Alice" })),
          updateEmployee: vi.fn(async () => ({ ok: true })),
        },
        agent: {
          name: "test",
          __setTools: vi.fn(),
          stream: vi.fn(),
          generate: mockAgentGenerate,
        } as any,
      };
    }

    function defaultAgentGenerateResult(overrides: Record<string, any> = {}) {
      return {
        text: "Done",
        toolCalls: [],
        steps: [],
        usage: { promptTokens: 40, completionTokens: 10 },
        ...overrides,
      };
    }

    beforeEach(() => {
      mockAgentGenerate.mockReset();
      mockAgentGenerate.mockResolvedValue(defaultAgentGenerateResult());
      mockSdkPrefetch.mockResolvedValue([
        { name: "viewEmployee", description: "View employee", parameters: {}, score: 0.9 },
      ]);
      mockSdkCaptureTurn.mockResolvedValue({ turnId: "turn-1" });
    });

    it("calls prefetch with messages and turnId", async () => {
      const am = new AgentifiedMastra(generateConfig());
      await am.generate({
        messages: [{ role: "user", content: "Show Alice" }],
        turnId: "prev-turn",
      });

      expect(mockSdkPrefetch).toHaveBeenCalledWith(
        "inst-1",
        expect.objectContaining({
          messages: [{ role: "user", content: "Show Alice" }],
          turnId: "prev-turn",
        }),
      );
    });

    it("sets ALL tools (not just ranked) on agent and calls agent.generate()", async () => {
      // prefetch returns only viewEmployee
      mockSdkPrefetch.mockResolvedValue([
        { name: "viewEmployee", description: "View employee", parameters: {}, score: 0.9 },
      ]);

      const config = generateConfig();
      const am = new AgentifiedMastra(config);
      await am.generate({
        messages: [{ role: "user", content: "test" }],
        maxSteps: 5,
      });

      // __setTools should include BOTH tools + discover
      expect(config.agent.__setTools).toHaveBeenCalledWith(
        expect.objectContaining({
          viewEmployee: expect.anything(),
          updateEmployee: expect.anything(),
          agentified_discover: expect.anything(),
        }),
      );

      // agent.generate should have been called
      expect(mockAgentGenerate).toHaveBeenCalledOnce();
      const [messages, opts] = mockAgentGenerate.mock.calls[0];
      expect(messages).toEqual([{ role: "user", content: "test" }]);
      expect(opts.maxSteps).toBe(5);
    });

    it("returns text and filters out discover from toolCalls", async () => {
      mockAgentGenerate.mockResolvedValue(defaultAgentGenerateResult({
        text: "Here is Alice",
        steps: [
          {
            toolCalls: [
              { toolName: "agentified_discover", toolCallId: "d1", args: { query: "find" } },
            ],
            toolResults: [],
          },
          {
            toolCalls: [
              { toolName: "viewEmployee", toolCallId: "c1", args: { id: "EMP001" } },
              { toolName: "updateEmployee", toolCallId: "c2", args: { id: "EMP001", name: "Bob" } },
            ],
            toolResults: [],
          },
        ],
      }));

      const am = new AgentifiedMastra(generateConfig());
      const result = await am.generate({
        messages: [{ role: "user", content: "test" }],
      });

      expect(result.text).toBe("Here is Alice");
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].toolName).toBe("viewEmployee");
      expect(result.toolCalls[1].toolName).toBe("updateEmployee");
      expect(result.toolCalls.find(tc => tc.toolName === "agentified_discover")).toBeUndefined();
    });

    it("extracts usage tokens from agent result", async () => {
      mockAgentGenerate.mockResolvedValue(defaultAgentGenerateResult({
        usage: { promptTokens: 100, completionTokens: 50 },
      }));

      const am = new AgentifiedMastra(generateConfig());
      const result = await am.generate({
        messages: [{ role: "user", content: "test" }],
      });

      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
    });

    it("calls captureTurn after completion and returns turnId", async () => {
      mockSdkCaptureTurn.mockResolvedValue({ turnId: "new-turn-42" });

      const am = new AgentifiedMastra(generateConfig());
      const result = await am.generate({
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "Show Alice" },
        ],
      });

      expect(mockSdkCaptureTurn).toHaveBeenCalledOnce();
      expect(mockSdkCaptureTurn).toHaveBeenCalledWith(
        "inst-1",
        "default",
        "default",
        expect.objectContaining({
          message: "Show Alice",
          toolsLoaded: expect.arrayContaining(["viewEmployee"]),
        }),
      );
      // discover should NOT be in toolsLoaded
      const call = mockSdkCaptureTurn.mock.calls[0][3];
      expect(call.toolsLoaded).not.toContain("agentified_discover");

      expect(result.turnId).toBe("new-turn-42");
    });

    it("tracks hydratedTools from prefill + discovered", async () => {
      mockSdkPrefetch.mockResolvedValue([
        { name: "viewEmployee", description: "View", parameters: {}, score: 0.9 },
      ]);
      // Simulate discover adding updateEmployee via steps
      mockAgentGenerate.mockResolvedValue(defaultAgentGenerateResult({
        steps: [
          {
            toolCalls: [{ toolName: "agentified_discover", toolCallId: "d1", args: { query: "update" } }],
            toolResults: [
              { toolName: "agentified_discover", result: [{ name: "updateEmployee" }] },
            ],
          },
          {
            toolCalls: [{ toolName: "updateEmployee", toolCallId: "c1", args: { id: "1", name: "Bob" } }],
            toolResults: [],
          },
        ],
      }));

      const am = new AgentifiedMastra(generateConfig());
      const result = await am.generate({
        messages: [{ role: "user", content: "test" }],
      });

      expect(result.hydratedTools).toContain("viewEmployee");
      expect(result.hydratedTools).toContain("updateEmployee");
      expect(result.hydratedTools).not.toContain("agentified_discover");
    });

    it("passes toolLimit to prefetch and seed to agent.generate()", async () => {
      const am = new AgentifiedMastra(generateConfig());
      await am.generate({
        messages: [{ role: "user", content: "test" }],
        toolLimit: 3,
        seed: 42,
      });

      expect(mockSdkPrefetch).toHaveBeenCalledWith(
        "inst-1",
        expect.objectContaining({ limit: 3 }),
      );

      const [, opts] = mockAgentGenerate.mock.calls[0];
      expect(opts.seed).toBe(42);
    });

    it("captureTurn failure is non-fatal — returns result without turnId", async () => {
      mockSdkCaptureTurn.mockRejectedValue(new Error("network down"));

      const am = new AgentifiedMastra(generateConfig());
      const result = await am.generate({
        messages: [{ role: "user", content: "test" }],
      });

      expect(result.text).toBe("Done");
      expect(result.turnId).toBeUndefined();
    });

    it("measures durationMs", async () => {
      const am = new AgentifiedMastra(generateConfig());
      const result = await am.generate({
        messages: [{ role: "user", content: "test" }],
      });

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
