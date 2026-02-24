import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentifiedClient } from "../client.js";
import type { InspectorState } from "../types.js";
import type { BaseEvent, CustomEvent, RunStartedEvent, RunFinishedEvent, TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent, ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent, ToolCallResultEvent, RunErrorEvent, AgentSubscriber, AbstractAgent } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";

function createMockAgent() {
  let subscriber: AgentSubscriber | undefined;
  return {
    subscribe: vi.fn((sub: AgentSubscriber) => {
      subscriber = sub;
      return { unsubscribe: () => { subscriber = undefined; } };
    }),
    setMessages: vi.fn(),
    runAgent: vi.fn(() => Promise.resolve({ result: null, newMessages: [] })),
    abortRun: vi.fn(),
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

type MockAgent = ReturnType<typeof createMockAgent>;

function createClient(agent?: MockAgent) {
  const mock = agent ?? createMockAgent();
  const client = new AgentifiedClient({
    agentUrl: "http://localhost:9119",
    _agentFactory: () => mock as unknown as AbstractAgent,
  });
  return { client, mockAgent: mock };
}

function initialState(): InspectorState {
  return {
    connection: "idle",
    run: {},
    agentified: { prefetchResults: [], discoveries: [], currentTools: [] },
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
    streaming: { messageCount: 0, toolCallCount: 0 },
    toolCalls: [],
    events: [],
    messages: [],
    isLoading: false,
    error: null,
  };
}

describe("AgentifiedClient", () => {
  let mockAgent: MockAgent;
  let client: AgentifiedClient;

  beforeEach(() => {
    const result = createClient();
    client = result.client;
    mockAgent = result.mockAgent;
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
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hi" } as TextMessageContentEvent);

      expect(client.getState().streaming.timeToFirstTokenMs).toBeGreaterThanOrEqual(0);
    });

    it("counts tool calls on TOOL_CALL_START", async () => {
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "foo" } as ToolCallStartEvent);

      expect(client.getState().streaming.toolCallCount).toBe(1);
    });
  });

  describe("message tracking", () => {
    it("TEXT_MESSAGE_START creates a pending message entry", async () => {
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as TextMessageStartEvent);

      const messages = client.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.id).toBe("m1");
      expect(messages[0]!.role).toBe("assistant");
      expect(messages[0]!.content).toBe("");
    });

    it("TEXT_MESSAGE_CONTENT appends delta and notifies", async () => {
      const listener = vi.fn();
      client.subscribe(listener);

      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as TextMessageStartEvent);
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "Hello" } as TextMessageContentEvent);

      const messages = client.getMessages();
      expect(messages[0]!.content).toBe("Hello");
      // listener called for both events
      expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("TEXT_MESSAGE_CONTENT appends multiple deltas", async () => {
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as TextMessageStartEvent);
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "Hel" } as TextMessageContentEvent);
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "lo" } as TextMessageContentEvent);

      expect(client.getMessages()[0]!.content).toBe("Hello");
    });

    it("TEXT_MESSAGE_END finalizes message", async () => {
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as TextMessageStartEvent);
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "Done" } as TextMessageContentEvent);
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as TextMessageEndEvent);

      const messages = client.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe("Done");
    });

    it("tracks multiple messages by messageId", async () => {
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as TextMessageStartEvent);
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "First" } as TextMessageContentEvent);
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as TextMessageEndEvent);

      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId: "m2", role: "assistant" } as TextMessageStartEvent);
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m2", delta: "Second" } as TextMessageContentEvent);
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_END, messageId: "m2" } as TextMessageEndEvent);

      const messages = client.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0]!.content).toBe("First");
      expect(messages[1]!.content).toBe("Second");
    });

    it("getMessages returns current messages including in-progress", async () => {
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as TextMessageStartEvent);
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "stream" } as TextMessageContentEvent);

      // Message is still in-progress but visible via getMessages
      const messages = client.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe("stream");
    });

    it("messages are included in state", async () => {
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as TextMessageStartEvent);
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hi" } as TextMessageContentEvent);

      expect(client.getState().messages).toHaveLength(1);
      expect(client.getState().messages[0]!.content).toBe("hi");
    });
  });

  describe("run()", () => {
    it("sets isLoading=true during run", async () => {
      let loadingDuringRun = false;
      mockAgent.runAgent.mockImplementation(async () => {
        loadingDuringRun = client.getState().isLoading;
        return { result: null, newMessages: [] };
      });

      await client.run({ messages: [] });

      expect(loadingDuringRun).toBe(true);
      expect(client.getState().isLoading).toBe(false);
    });

    it("calls agent.setMessages and runAgent", async () => {
      const messages = [{ id: "u1", role: "user" as const, content: "hello" }];
      await client.run({ messages });

      expect(mockAgent.setMessages).toHaveBeenCalledWith(messages);
      expect(mockAgent.runAgent).toHaveBeenCalled();
    });

    it("passes context to runAgent", async () => {
      const context = [{ description: "test", value: "val" }];
      await client.run({ messages: [], context });

      expect(mockAgent.runAgent).toHaveBeenCalledWith({ context });
    });

    it("sets error on failure", async () => {
      mockAgent.runAgent.mockRejectedValue(new Error("network error"));

      await client.run({ messages: [] });

      expect(client.getState().error).toBe("network error");
      expect(client.getState().isLoading).toBe(false);
    });

    it("clears previous error on new run", async () => {
      mockAgent.runAgent.mockRejectedValueOnce(new Error("fail"));
      await client.run({ messages: [] });
      expect(client.getState().error).toBe("fail");

      mockAgent.runAgent.mockResolvedValueOnce({ result: null, newMessages: [] });
      await client.run({ messages: [] });
      expect(client.getState().error).toBeNull();
    });
  });

  describe("sendMessage()", () => {
    it("creates user message and appends to messages", async () => {
      await client.sendMessage("hello");

      const messages = client.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe("user");
      expect(messages[0]!.content).toBe("hello");
    });

    it("calls run with all messages", async () => {
      await client.sendMessage("hi");

      expect(mockAgent.setMessages).toHaveBeenCalled();
      expect(mockAgent.runAgent).toHaveBeenCalled();
    });

    it("preserves existing messages", async () => {
      await client.sendMessage("first");
      mockAgent.runAgent.mockResolvedValueOnce({ result: null, newMessages: [] });
      await client.sendMessage("second");

      const messages = client.getMessages();
      const userMessages = messages.filter(m => m.role === "user");
      expect(userMessages).toHaveLength(2);
      expect(userMessages[0]!.content).toBe("first");
      expect(userMessages[1]!.content).toBe("second");
    });
  });

  describe("reset()", () => {
    it("clears messages, isLoading, error", async () => {
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as TextMessageStartEvent);
      await mockAgent.emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hi" } as TextMessageContentEvent);

      client.reset();

      expect(client.getState().messages).toEqual([]);
      expect(client.getState().isLoading).toBe(false);
      expect(client.getState().error).toBeNull();
    });

    it("calls abortRun on agent", () => {
      client.reset();
      expect(mockAgent.abortRun).toHaveBeenCalled();
    });

    it("resets to initial state and notifies listeners", async () => {
      await mockAgent.emitEvent({ type: EventType.RUN_STARTED, runId: "r1", threadId: "t1" } as RunStartedEvent);

      const listener = vi.fn();
      client.subscribe(listener);
      client.reset();

      expect(client.getState()).toEqual(initialState());
      expect(listener).toHaveBeenCalledWith(initialState());
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

  describe("tool call tracking", () => {
    it("TOOL_CALL_START creates ToolCallDetail with id, name, startedAt", async () => {
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search" } as ToolCallStartEvent);

      const toolCalls = client.getState().toolCalls;
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.id).toBe("tc1");
      expect(toolCalls[0]!.name).toBe("search");
      expect(toolCalls[0]!.args).toBe("");
      expect(toolCalls[0]!.startedAt).toBeGreaterThan(0);
    });

    it("TOOL_CALL_ARGS appends delta to correct tool call", async () => {
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search" } as ToolCallStartEvent);
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: '{"q":' } as ToolCallArgsEvent);
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: '"hello"}' } as ToolCallArgsEvent);

      expect(client.getState().toolCalls[0]!.args).toBe('{"q":"hello"}');
    });

    it("TOOL_CALL_END sets endedAt and durationMs", async () => {
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search" } as ToolCallStartEvent);
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_END, toolCallId: "tc1" } as ToolCallEndEvent);

      const tc = client.getState().toolCalls[0]!;
      expect(tc.endedAt).toBeGreaterThan(0);
      expect(tc.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("TOOL_CALL_RESULT stores result", async () => {
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search" } as ToolCallStartEvent);
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_RESULT, toolCallId: "tc1", messageId: "m1", content: "found 3 results" } as ToolCallResultEvent);

      expect(client.getState().toolCalls[0]!.result).toBe("found 3 results");
    });

    it("tracks multiple concurrent tool calls independently", async () => {
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search" } as ToolCallStartEvent);
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_START, toolCallId: "tc2", toolCallName: "calculate" } as ToolCallStartEvent);
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: "arg1" } as ToolCallArgsEvent);
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_ARGS, toolCallId: "tc2", delta: "arg2" } as ToolCallArgsEvent);
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_END, toolCallId: "tc1" } as ToolCallEndEvent);

      const toolCalls = client.getState().toolCalls;
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]!.name).toBe("search");
      expect(toolCalls[0]!.args).toBe("arg1");
      expect(toolCalls[0]!.endedAt).toBeDefined();
      expect(toolCalls[1]!.name).toBe("calculate");
      expect(toolCalls[1]!.args).toBe("arg2");
      expect(toolCalls[1]!.endedAt).toBeUndefined();
    });

    it("toolCalls persist across multiple run() calls", async () => {
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search" } as ToolCallStartEvent);

      // Simulate a new run — run() doesn't reset toolCalls
      await client.run({ messages: [] });

      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_START, toolCallId: "tc2", toolCallName: "calc" } as ToolCallStartEvent);

      expect(client.getState().toolCalls).toHaveLength(2);
    });

    it("reset() clears toolCalls", async () => {
      await mockAgent.emitEvent({ type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search" } as ToolCallStartEvent);
      client.reset();
      expect(client.getState().toolCalls).toEqual([]);
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
});
