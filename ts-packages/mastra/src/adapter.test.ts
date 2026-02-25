import { describe, it, expect, vi, beforeEach } from "vitest";
import { Subject } from "rxjs";
import { take } from "rxjs/operators";
import type { BaseEvent } from "@ag-ui/client";

// --- Mock setup ---

const mockSdkRegister = vi.fn(async () => ({ registered: 5 }));
const mockSdkPrefetch = vi.fn<[], Promise<unknown[]>>(async () => []);
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
  Agentified: vi.fn(() => ({
    register: mockSdkRegister,
    prefetch: mockSdkPrefetch,
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
    agent: { name: "test", __setTools: vi.fn() } as any,
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
});
