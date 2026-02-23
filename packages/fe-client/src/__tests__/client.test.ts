import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentifiedClient } from "../client.js";
import type { InspectorState } from "../types.js";
import type { BaseEvent, CustomEvent, RunStartedEvent, RunFinishedEvent, TextMessageStartEvent, TextMessageContentEvent, ToolCallStartEvent, RunErrorEvent, AgentSubscriber } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";

// Minimal mock HttpAgent that captures subscriber and dispatches via onEvent
function createMockAgent() {
  let subscriber: AgentSubscriber | undefined;
  return {
    subscribe: vi.fn((sub: AgentSubscriber) => {
      subscriber = sub;
      return { unsubscribe: () => { subscriber = undefined; } };
    }),
    async emitEvent(event: BaseEvent) {
      const params = {
        messages: [],
        state: {},
        agent: {} as any,
        input: { runId: "run-1", threadId: "thread-1" } as any,
      };
      await subscriber?.onEvent?.({ event, ...params });
    },
  };
}

function initialState(): InspectorState {
  return {
    connection: "idle",
    run: {},
    agentified: { prefetchResults: [], discoveries: [], currentTools: [] },
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
    streaming: { messageCount: 0, toolCallCount: 0 },
    events: [],
  };
}

describe("AgentifiedClient", () => {
  let mockAgent: ReturnType<typeof createMockAgent>;
  let client: AgentifiedClient;

  beforeEach(() => {
    mockAgent = createMockAgent();
    client = new AgentifiedClient(mockAgent as any);
  });

  describe("initialization", () => {
    it("subscribes to agent on construction", () => {
      expect(mockAgent.subscribe).toHaveBeenCalledOnce();
    });

    it("starts with idle initial state", () => {
      expect(client.getState()).toEqual(initialState());
    });
  });

  describe("subscribe", () => {
    it("notifies listener on state changes", async () => {
      const listener = vi.fn();
      client.subscribe(listener);

      await mockAgent.emitEvent({ type: EventType.RUN_STARTED, runId: "r1", threadId: "t1" } as RunStartedEvent);

      expect(listener).toHaveBeenCalled();
      expect(listener.mock.calls[0]![0].connection).toBe("connected");
    });

    it("unsubscribe stops notifications", async () => {
      const listener = vi.fn();
      const sub = client.subscribe(listener);
      sub.unsubscribe();

      await mockAgent.emitEvent({ type: EventType.RUN_STARTED, runId: "r1", threadId: "t1" } as RunStartedEvent);

      expect(listener).not.toHaveBeenCalled();
    });

    it("supports multiple listeners", async () => {
      const l1 = vi.fn();
      const l2 = vi.fn();
      client.subscribe(l1);
      client.subscribe(l2);

      await mockAgent.emitEvent({ type: EventType.RUN_STARTED, runId: "r1", threadId: "t1" } as RunStartedEvent);

      expect(l1).toHaveBeenCalled();
      expect(l2).toHaveBeenCalled();
    });
  });

  describe("run lifecycle events", () => {
    it("RUN_STARTED sets connection=connected and run info", async () => {
      await mockAgent.emitEvent({ type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" } as RunStartedEvent);

      const state = client.getState();
      expect(state.connection).toBe("connected");
      expect(state.run.runId).toBe("run-1");
      expect(state.run.threadId).toBe("thread-1");
      expect(state.run.startedAt).toBeGreaterThan(0);
    });

    it("RUN_FINISHED sets connection=disconnected and calculates duration", async () => {
      await mockAgent.emitEvent({ type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" } as RunStartedEvent);
      await mockAgent.emitEvent({ type: EventType.RUN_FINISHED, runId: "run-1" } as RunFinishedEvent);

      const state = client.getState();
      expect(state.connection).toBe("disconnected");
      expect(state.run.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("RUN_ERROR sets connection=error", async () => {
      await mockAgent.emitEvent({ type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" } as RunStartedEvent);
      await mockAgent.emitEvent({ type: EventType.RUN_ERROR, message: "fail" } as RunErrorEvent);

      expect(client.getState().connection).toBe("error");
    });
  });

  describe("streaming metrics", () => {
    it("counts messages on TEXT_MESSAGE_START", async () => {
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId: "m1" } as TextMessageStartEvent);
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId: "m2" } as TextMessageStartEvent);

      expect(client.getState().streaming.messageCount).toBe(2);
    });

    it("tracks time to first token on first TEXT_MESSAGE_CONTENT", async () => {
      await mockAgent.emitEvent({ type: EventType.RUN_STARTED, runId: "r1", threadId: "t1" } as RunStartedEvent);
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", content: "hi" } as TextMessageContentEvent);

      expect(client.getState().streaming.timeToFirstTokenMs).toBeGreaterThanOrEqual(0);
    });

    it("counts tool calls on TOOL_CALL_START", async () => {
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "foo" } as ToolCallStartEvent);

      expect(client.getState().streaming.toolCallCount).toBe(1);
    });
  });

  describe("agentified CUSTOM events", () => {
    it("parses prefetch:complete and stores result", async () => {
      const tools = [{ name: "weather", description: "Get weather", score: 0.9 }];
      await mockAgent.emitEvent({
        type: EventType.CUSTOM,
        name: "agentified:prefetch:complete",
        value: { tools, durationMs: 42 },
      } as CustomEvent);

      const state = client.getState();
      expect(state.agentified.prefetchResults).toHaveLength(1);
      expect(state.agentified.prefetchResults[0]).toEqual({ tools, durationMs: 42 });
      expect(state.agentified.currentTools).toEqual(tools);
    });

    it("parses discover:complete and stores result", async () => {
      const tools = [{ name: "calc", description: "Calculator", score: 0.8 }];
      await mockAgent.emitEvent({
        type: EventType.CUSTOM,
        name: "agentified:discover:complete",
        value: { tools, durationMs: 15, query: "math tools" },
      } as unknown as CustomEvent);

      const state = client.getState();
      expect(state.agentified.discoveries).toHaveLength(1);
      expect(state.agentified.discoveries[0]).toEqual({ query: "math tools", tools, durationMs: 15 });
      expect(state.agentified.currentTools).toEqual(tools);
    });

    it("parses token usage from complete events", async () => {
      const tokenUsage = { input: 100, output: 50, cached: 10, reasoning: 5 };
      await mockAgent.emitEvent({
        type: EventType.CUSTOM,
        name: "agentified:prefetch:complete",
        value: { tools: [], durationMs: 10, tokenUsage },
      } as CustomEvent);

      const state = client.getState();
      expect(state.tokens).toMatchObject(tokenUsage);
    });

    it("ignores non-agentified CUSTOM events for agentified state", async () => {
      await mockAgent.emitEvent({
        type: EventType.CUSTOM,
        name: "some:other:event",
        value: { data: "test" },
      } as CustomEvent);

      expect(client.getState().agentified.prefetchResults).toHaveLength(0);
      expect(client.getState().agentified.discoveries).toHaveLength(0);
    });
  });

  describe("event log", () => {
    it("logs all events with timestamps", async () => {
      await mockAgent.emitEvent({ type: EventType.RUN_STARTED, runId: "r1", threadId: "t1" } as RunStartedEvent);
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId: "m1" } as TextMessageStartEvent);

      const events = client.getState().events;
      expect(events).toHaveLength(2);
      expect(events[0]!.event.type).toBe(EventType.RUN_STARTED);
      expect(events[0]!.timestamp).toBeGreaterThan(0);
      expect(events[0]!.isAgentified).toBe(false);
    });

    it("flags agentified CUSTOM events in log", async () => {
      await mockAgent.emitEvent({
        type: EventType.CUSTOM,
        name: "agentified:prefetch:start",
        value: { messages: [] },
      } as CustomEvent);

      const events = client.getState().events;
      expect(events).toHaveLength(1);
      expect(events[0]!.isAgentified).toBe(true);
    });
  });

  describe("reset", () => {
    it("resets state to initial and notifies listeners", async () => {
      await mockAgent.emitEvent({ type: EventType.RUN_STARTED, runId: "r1", threadId: "t1" } as RunStartedEvent);

      const listener = vi.fn();
      client.subscribe(listener);
      client.reset();

      expect(client.getState()).toEqual(initialState());
      expect(listener).toHaveBeenCalledWith(initialState());
    });
  });
});
