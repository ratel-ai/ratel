import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetContext = vi.fn();
const mockGetMessages = vi.fn();
const mockAppendMessages = vi.fn();
const mockAsDiscoverTool = vi.fn();
const mockAsGetMessagesTool = vi.fn();

vi.mock("../api-client.js", () => ({
  ApiClient: vi.fn(() => ({
    getContext: mockGetContext,
    getMessages: mockGetMessages,
    appendMessages: mockAppendMessages,
    asDiscoverTool: mockAsDiscoverTool,
    asGetMessagesTool: mockAsGetMessagesTool,
  })),
}));

import { ContextBuilder } from "../context-builder.js";
import { ObserverEmitter } from "../events.js";
import type { ContextAssembledEvent, RecallEvent } from "../events.js";
import { ApiClient } from "../api-client.js";

function baseResponse() {
  return {
    messages: [{ id: "m1", role: "user", content: "hi", createdAt: "", seq: 1 }],
    strategyUsed: "recent" as const,
    totalMessages: 1,
    includedMessages: 1,
    recalled: { tools: [], memories: [] },
    tokenEstimate: 5,
    conversationMessages: 1,
    fallback: false,
  };
}

describe("ObserverEmitter", () => {
  it("calls registered listeners", () => {
    const emitter = new ObserverEmitter();
    const cb = vi.fn();
    emitter.on("context:assembled", cb);
    emitter.emit("context:assembled", { sessionId: "s" } as ContextAssembledEvent);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("disposer removes the listener", () => {
    const emitter = new ObserverEmitter();
    const cb = vi.fn();
    const off = emitter.on("context:assembled", cb);
    off();
    emitter.emit("context:assembled", {} as ContextAssembledEvent);
    expect(cb).not.toHaveBeenCalled();
  });

  it("swallows listener errors and keeps other listeners", () => {
    const emitter = new ObserverEmitter();
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good = vi.fn();
    emitter.on("context:assembled", bad);
    emitter.on("context:assembled", good);
    expect(() => emitter.emit("context:assembled", {} as ContextAssembledEvent)).not.toThrow();
    expect(good).toHaveBeenCalled();
  });

  it("supports multiple event names independently", () => {
    const emitter = new ObserverEmitter();
    const ctx = vi.fn();
    const step = vi.fn();
    emitter.on("context:assembled", ctx);
    emitter.on("step", step);
    emitter.emit("context:assembled", {} as ContextAssembledEvent);
    expect(ctx).toHaveBeenCalledTimes(1);
    expect(step).not.toHaveBeenCalled();
  });
});

describe("ContextBuilder events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits context:assembled exactly once per assemble() with full payload", async () => {
    mockGetContext.mockResolvedValue(baseResponse());
    const emitter = new ObserverEmitter();
    const events: ContextAssembledEvent[] = [];
    emitter.on("context:assembled", (evt) => { events.push(evt); });

    const sdk = new ApiClient({ serverUrl: "", tools: [] });
    const cb = new ContextBuilder(sdk, "ds", "ns", "sess-1", [], new Set(), emitter);
    await cb.assemble();

    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.sessionId).toBe("sess-1");
    expect(evt.datasetId).toBe("ds");
    expect(evt.strategyUsed).toBe("recent");
    expect(evt.totalMessages).toBe(1);
    expect(evt.includedMessages).toBe(1);
    expect(evt.tokenEstimate).toBe(5);
    expect(evt.fallback).toBe(false);
    expect(evt.recalled).toEqual({ tools: [] });
    expect(typeof evt.durationMs).toBe("number");
  });

  it("does NOT emit recall when recall was not configured", async () => {
    mockGetContext.mockResolvedValue(baseResponse());
    const emitter = new ObserverEmitter();
    const recallEvents: RecallEvent[] = [];
    emitter.on("recall", (evt) => { recallEvents.push(evt); });

    const sdk = new ApiClient({ serverUrl: "", tools: [] });
    const cb = new ContextBuilder(sdk, "ds", "ns", "sess", [], new Set(), emitter);
    await cb.assemble();

    expect(recallEvents).toHaveLength(0);
  });

  it("emits recall once with matches when recall() was configured", async () => {
    const ranked = { name: "get_weather", description: "", parameters: {}, score: 0.9 };
    mockGetContext.mockResolvedValue({
      ...baseResponse(),
      recalled: { tools: [ranked], memories: [] },
    });
    const emitter = new ObserverEmitter();
    const recallEvents: RecallEvent[] = [];
    const ctxEvents: ContextAssembledEvent[] = [];
    emitter.on("recall", (evt) => { recallEvents.push(evt); });
    emitter.on("context:assembled", (evt) => { ctxEvents.push(evt); });

    const sdk = new ApiClient({ serverUrl: "", tools: [] });
    const cb = new ContextBuilder(sdk, "ds", "ns", "sess", [], new Set(), emitter);
    await cb.recall().assemble();

    expect(recallEvents).toHaveLength(1);
    expect(recallEvents[0]!.matches).toEqual([ranked]);
    expect(recallEvents[0]!.config).toEqual({ tools: true });
    expect(ctxEvents).toHaveLength(1);
    expect(ctxEvents[0]!.recalled.tools).toEqual([ranked]);
  });

  it("does not emit events when no emitter is provided", async () => {
    mockGetContext.mockResolvedValue(baseResponse());
    const sdk = new ApiClient({ serverUrl: "", tools: [] });
    const cb = new ContextBuilder(sdk, "ds", "ns", "sess");
    // Should not throw
    await cb.assemble();
  });
});
