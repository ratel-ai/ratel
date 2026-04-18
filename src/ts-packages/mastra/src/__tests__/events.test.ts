import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateTool = vi.fn(({ id, execute }: any) => ({ id, execute, __mastraTool: true }));
vi.mock("@mastra/core/tools", () => ({
  createTool: (...args: any[]) => mockCreateTool(...args),
}));

import { MastraInstance, MastraSession, MastraAgentified } from "../agentified.js";
import { ObserverEmitter } from "agentified";
import type { StepEvent, Agentified, Instance, Session } from "agentified";

function fakeInstance(emitter?: ObserverEmitter): Instance {
  return {
    instanceId: "default",
    datasetId: "default",
    discoverTool: {
      definition: { name: "agentified_discover", description: "", parameters: {} },
      execute: vi.fn(),
      discoveredNames: new Set<string>(),
    },
    prepareStep: vi.fn().mockResolvedValue({ activeTools: [] }),
    session: vi.fn(),
    namespace: vi.fn(),
    emitter,
  } as unknown as Instance;
}

function fakeSession(id: string, emitter?: ObserverEmitter): Session {
  return {
    id,
    datasetId: "default",
    discoverTool: {
      definition: { name: "agentified_discover", description: "", parameters: {} },
      execute: vi.fn(),
      discoveredNames: new Set<string>(),
    },
    getMessagesTool: {
      definition: { name: "agentified_get_messages", description: "", parameters: {} },
      execute: vi.fn(),
    },
    prepareStep: vi.fn(),
    emitter,
    conversation: {},
  } as unknown as Session;
}

describe("MastraAgentified.on", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("delegates on() to underlying Agentified.on", () => {
    const ag = { on: vi.fn().mockReturnValue(() => {}) } as unknown as Agentified;
    const m = new MastraAgentified(ag);
    const cb = vi.fn();
    m.on("context:assembled", cb);
    expect(ag.on).toHaveBeenCalledWith("context:assembled", cb);
  });
});

describe("MastraInstance step events", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("on('step', cb) + onStepFinish emits StepEvent once", () => {
    const emitter = new ObserverEmitter();
    const inst = fakeInstance(emitter);
    const m = new MastraInstance(inst, []);

    const events: StepEvent[] = [];
    m.on("step", (evt) => events.push(evt));

    m.onStepFinish({
      toolCalls: [{ toolName: "x" }],
      toolResults: [{ toolCallId: "1", result: 42 }],
      usage: { input: 10, output: 5 },
      finishReason: "stop",
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.stepIndex).toBe(0);
    expect(events[0]!.toolCalls).toEqual([{ toolName: "x" }]);
    expect(events[0]!.toolResults).toEqual([{ toolCallId: "1", result: 42 }]);
    expect(events[0]!.usage).toEqual({ input: 10, output: 5 });
    expect(events[0]!.finishReason).toBe("stop");
  });

  it("increments stepIndex across calls", () => {
    const emitter = new ObserverEmitter();
    const inst = fakeInstance(emitter);
    const m = new MastraInstance(inst, []);
    const events: StepEvent[] = [];
    m.on("step", (evt) => events.push(evt));

    m.onStepFinish({});
    m.onStepFinish({});
    m.onStepFinish({});

    expect(events.map(e => e.stepIndex)).toEqual([0, 1, 2]);
  });

  it("disposer from on() removes listener", () => {
    const emitter = new ObserverEmitter();
    const inst = fakeInstance(emitter);
    const m = new MastraInstance(inst, []);
    const cb = vi.fn();
    const off = m.on("step", cb);
    off();
    m.onStepFinish({});
    expect(cb).not.toHaveBeenCalled();
  });

  it("no emitter means on() returns no-op disposer and onStepFinish is safe", () => {
    const inst = fakeInstance(undefined);
    const m = new MastraInstance(inst, []);
    const off = m.on("step", () => {});
    expect(typeof off).toBe("function");
    expect(() => m.onStepFinish({})).not.toThrow();
    expect(() => off()).not.toThrow();
  });
});

describe("MastraSession step events", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("onStepFinish tags sessionId onto StepEvent", () => {
    const emitter = new ObserverEmitter();
    const sess = fakeSession("chat-42", emitter);
    const m = new MastraSession(sess, []);
    const events: StepEvent[] = [];
    m.on("step", (evt) => events.push(evt));

    m.onStepFinish({ toolCalls: [], toolResults: [] });
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBe("chat-42");
  });
});
