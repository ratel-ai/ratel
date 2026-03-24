import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiClient } from "../api-client.js";
import type { AgentifiedEvent, RankedTool, ServerTool } from "../types.js";

const TEST_URL = "http://localhost:9119";

const testTool: ServerTool = {
  name: "get_weather",
  description: "Get weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } } },
};

const rankedTool: RankedTool = { ...testTool, score: 0.95 };

describe("ApiClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("register", () => {
    it("posts tools to dataset endpoint and returns registered count", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ registered: 1 }), { status: 200 }),
      );

      const agent = new ApiClient({
        serverUrl: TEST_URL,
        tools: [testTool],
      });

      const result = await agent.register("ds-abc");

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/datasets/ds-abc/tools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tools: [testTool] }),
      });
      expect(result).toEqual({ registered: 1 });
    });
  });

  describe("discover", () => {
    it("posts to dataset discover endpoint and returns ranked tools", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const result = await agent.discover("ds-abc", "weather tools", 5);

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/datasets/ds-abc/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "weather tools", limit: 5 }),
      });
      expect(result).toEqual([rankedTool]);
    });

    it("passes exclude and turnId when provided", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [] }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      await agent.discover("ds-abc", "test", undefined, ["excluded"], "turn-1");

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/datasets/ds-abc/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test", exclude: ["excluded"], turn_id: "turn-1" }),
      });
    });

    it("omits optional params when not provided", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [] }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      await agent.discover("ds-abc", "test");

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/datasets/ds-abc/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      });
    });
  });

  describe("prefetch", () => {
    it("builds query from messages and returns ranked tools via dataset discover", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const result = await agent.prefetch("ds-abc", {
        messages: [{ role: "user", content: "What is the weather in Paris?" }],
        limit: 5,
      });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/datasets/ds-abc/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "What is the weather in Paris?", limit: 5 }),
      });
      expect(result).toEqual([rankedTool]);
    });

    it("emits start and complete events with timing", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const events: AgentifiedEvent[] = [];
      const messages = [{ role: "user", content: "weather in Paris" }];

      const agent = new ApiClient({
        serverUrl: TEST_URL,
        tools: [testTool],
        onEvent: (e) => events.push(e),
      });

      await agent.prefetch("ds-abc", { messages });

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "agentified:prefetch:start", messages });
      expect(events[1]).toMatchObject({ type: "agentified:prefetch:complete", tools: [rankedTool] });
      expect(
        (events[1] as Extract<AgentifiedEvent, { type: "agentified:prefetch:complete" }>).durationMs,
      ).toBeGreaterThanOrEqual(0);
    });

    it("passes exclude to discover body", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      await agent.prefetch("ds-abc", {
        messages: [{ role: "user", content: "test" }],
        exclude: ["frontendTool"],
      });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/datasets/ds-abc/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test", exclude: ["frontendTool"] }),
      });
    });

    it("passes turn_id to discover body", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      await agent.prefetch("ds-abc", {
        messages: [{ role: "user", content: "test" }],
        limit: 5,
        turnId: "turn-xyz",
      });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/datasets/ds-abc/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test", limit: 5, turn_id: "turn-xyz" }),
      });
    });
  });

  describe("asDiscoverTool", () => {
    it("returns a DiscoverTool that calls dataset discover endpoint", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const discoverTool = agent.asDiscoverTool("ds-abc");

      expect(discoverTool.definition).toEqual({
        name: "agentified_discover",
        description: "Find tools relevant to the current task. Call this when you need capabilities you don't have.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural language description of what you need to do" },
            limit: { type: "number", description: "Max number of tools to return" },
          },
          required: ["query"],
        },
      });

      const result = await discoverTool.execute({ query: "weather tools", limit: 3 });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/datasets/ds-abc/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "weather tools", limit: 3 }),
      });
      expect(result).toEqual([rankedTool]);
    });

    it("emits start and complete events with timing", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const events: AgentifiedEvent[] = [];
      const agent = new ApiClient({
        serverUrl: TEST_URL,
        tools: [testTool],
        onEvent: (e) => events.push(e),
      });

      await agent.asDiscoverTool("ds-abc").execute({ query: "weather" });

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "agentified:discover:start", query: "weather" });
      expect(events[1]).toMatchObject({ type: "agentified:discover:complete", tools: [rankedTool] });
      expect(
        (events[1] as Extract<AgentifiedEvent, { type: "agentified:discover:complete" }>).durationMs,
      ).toBeGreaterThanOrEqual(0);
    });
  });

  describe("captureTurn", () => {
    it("posts turn data to /api/v1/turns (no instanceId) and returns turnId", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ turn_id: "abc-123" }), { status: 201 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const result = await agent.captureTurn("default", "session-1", {
        toolsLoaded: ["get_weather"],
        message: "What is the weather?",
      });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          namespace_id: "default",
          session_id: "session-1",
          tools_loaded: ["get_weather"],
          message: "What is the weather?",
        }),
      });
      expect(result).toEqual({ turnId: "abc-123" });
    });
  });

  describe("getFrontendTools", () => {
    it("returns tools with metadata.location=frontend", () => {
      const frontendTool: ServerTool = {
        name: "confirm_action",
        description: "Confirm an action",
        parameters: {},
        metadata: { location: "frontend" },
      };
      const serverTool: ServerTool = {
        name: "get_data",
        description: "Get data",
        parameters: {},
      };

      const agent = new ApiClient({
        serverUrl: TEST_URL,
        tools: [frontendTool, serverTool],
      });

      expect(agent.getFrontendTools()).toEqual([frontendTool]);
    });

    it("returns empty array when no frontend tools", () => {
      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      expect(agent.getFrontendTools()).toEqual([]);
    });
  });

  describe("getFrontendToolNames", () => {
    it("returns names of frontend tools", () => {
      const frontendTool: ServerTool = {
        name: "confirm_action",
        description: "Confirm",
        parameters: {},
        metadata: { location: "frontend" },
      };

      const agent = new ApiClient({
        serverUrl: TEST_URL,
        tools: [frontendTool, testTool],
      });

      expect(agent.getFrontendToolNames()).toEqual(["confirm_action"]);
    });
  });

  describe("appendMessages", () => {
    it("posts messages and returns seq range", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ appended: 2, first_seq: 42, last_seq: 43 }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const result = await agent.appendMessages("my-dataset", "user-123", "session-abc", [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ]);

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataset: "my-dataset",
          namespace: "user-123",
          session: "session-abc",
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi there!" },
          ],
        }),
      });
      expect(result).toEqual({ appended: 2, firstSeq: 42, lastSeq: 43 });
    });
  });

  describe("getMessages", () => {
    it("gets messages with snake_case mapped to camelCase", async () => {
      const stored = { id: "m1", role: "user", content: "Hello", tool_call_id: "tc1", tool_calls: null, created_at: "2026-01-01T00:00:00Z", seq: 1 };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ messages: [stored], has_more: false, max_seq: 1 }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const result = await agent.getMessages("ds", "ns", "sess");

      expect(fetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/v1/messages?dataset=ds&namespace=ns&session=sess`,
        { method: "GET" },
      );
      expect(result).toEqual({
        messages: [{ id: "m1", role: "user", content: "Hello", toolCallId: "tc1", toolCalls: null, createdAt: "2026-01-01T00:00:00Z", seq: 1 }],
        hasMore: false,
        maxSeq: 1,
      });
    });

    it("passes limit, afterSeq, aroundSeq as query params", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ messages: [], has_more: false, max_seq: 0 }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      await agent.getMessages("ds", "ns", "sess", { limit: 10, afterSeq: 5 });

      expect(fetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/v1/messages?dataset=ds&namespace=ns&session=sess&limit=10&after_seq=5`,
        { method: "GET" },
      );
    });

    it("passes aroundSeq as query param", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ messages: [], has_more: false, max_seq: 0 }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      await agent.getMessages("ds", "ns", "sess", { aroundSeq: 50 });

      expect(fetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/v1/messages?dataset=ds&namespace=ns&session=sess&around_seq=50`,
        { method: "GET" },
      );
    });
  });

  describe("getContext", () => {
    it("posts context request and maps messages to camelCase", async () => {
      const contextRes = {
        messages: [{ id: "m1", role: "user", content: "Hi", tool_call_id: null, tool_calls: null, created_at: "2026-01-01T00:00:00Z", seq: 1 }],
        strategy_used: "recent",
        total_messages: 1,
        included_messages: 1,
        recalled: { tools: [], memories: [] },
        token_estimate: 10,
        conversation_messages: 1,
        fallback: false,
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(contextRes), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const result = await agent.getContext("ds", "ns", "sess");

      expect(result).toEqual({
        messages: [{ id: "m1", role: "user", content: "Hi", toolCallId: null, toolCalls: null, createdAt: "2026-01-01T00:00:00Z", seq: 1 }],
        strategyUsed: "recent",
        totalMessages: 1,
        includedMessages: 1,
        recalled: { tools: [], memories: [] },
        tokenEstimate: 10,
        conversationMessages: 1,
        fallback: false,
      });
    });

    it("passes keepFirst as keep_first in messages config", async () => {
      const contextRes = {
        messages: [],
        strategy_used: "recent",
        total_messages: 0,
        included_messages: 0,
        recalled: { tools: [], memories: [] },
        token_estimate: 0,
        conversation_messages: 0,
        fallback: false,
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(contextRes), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      await agent.getContext("ds", "ns", "sess", { strategy: "recent", maxTokens: 4000, keepFirst: true });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataset: "ds",
          namespace: "ns",
          session: "sess",
          messages: { strategy: "recent", max_tokens: 4000, keep_first: true },
        }),
      });
    });

    it("passes strategy and maxTokens in messages sub-object", async () => {
      const contextRes = {
        messages: [],
        strategy_used: "full",
        total_messages: 10,
        included_messages: 10,
        recalled: { tools: [], memories: [] },
        token_estimate: 500,
        conversation_messages: 10,
        fallback: false,
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(contextRes), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const result = await agent.getContext("ds", "ns", "sess", { strategy: "full", maxTokens: 8000 });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataset: "ds",
          namespace: "ns",
          session: "sess",
          messages: { strategy: "full", max_tokens: 8000 },
        }),
      });
      expect(result).toEqual({
        messages: [],
        strategyUsed: "full",
        totalMessages: 10,
        includedMessages: 10,
        recalled: { tools: [], memories: [] },
        tokenEstimate: 500,
        conversationMessages: 10,
        fallback: false,
      });
    });
  });

  describe("custom headers", () => {
    it("merges config headers into every request", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ registered: 1 }), { status: 200 }),
      );

      const agent = new ApiClient({
        serverUrl: TEST_URL,
        tools: [testTool],
        headers: { Authorization: "Bearer tok-123" },
      });

      await agent.register("ds-abc");

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/datasets/ds-abc/tools`, {
        method: "POST",
        headers: { Authorization: "Bearer tok-123", "Content-Type": "application/json" },
        body: JSON.stringify({ tools: [testTool] }),
      });
    });

    it("includes config headers on GET requests", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ messages: [], has_more: false, max_seq: 0 }), { status: 200 }),
      );

      const agent = new ApiClient({
        serverUrl: TEST_URL,
        tools: [testTool],
        headers: { Authorization: "Bearer tok-123" },
      });

      await agent.getMessages("ds", "ns", "sess");

      expect(fetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/v1/messages?dataset=ds&namespace=ns&session=sess`,
        { method: "GET", headers: { Authorization: "Bearer tok-123" } },
      );
    });

    it("works without config headers (backward compat)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ registered: 1 }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      await agent.register("ds-abc");

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/datasets/ds-abc/tools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tools: [testTool] }),
      });
    });
  });

  describe("instance methods removed", () => {
    it("does not have createInstance, heartbeatInstance, deleteInstance", () => {
      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      expect((agent as any).createInstance).toBeUndefined();
      expect((agent as any).heartbeatInstance).toBeUndefined();
      expect((agent as any).deleteInstance).toBeUndefined();
    });
  });

  describe("onEvent optional", () => {
    it("does not crash when onEvent is not provided", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 })),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });

      await expect(
        agent.prefetch("ds-abc", { messages: [{ role: "user", content: "test" }] }),
      ).resolves.toEqual([rankedTool]);

      await expect(
        agent.asDiscoverTool("ds-abc").execute({ query: "test" }),
      ).resolves.toEqual([rankedTool]);
    });
  });

  describe("asGetMessagesTool", () => {
    it("returns tool with correct name and description", () => {
      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const tool = agent.asGetMessagesTool("ds", "ns", "sess");

      expect(tool.definition.name).toBe("agentified_get_messages");
      expect(tool.definition.description).toContain("conversation messages");
      expect(tool.definition.parameters).toHaveProperty("properties.limit");
      expect(tool.definition.parameters).toHaveProperty("properties.afterSeq");
      expect(tool.definition.parameters).toHaveProperty("properties.aroundSeq");
    });

    it("execute delegates to getMessages with correct params", async () => {
      const messagesRes = {
        messages: [{ id: "m1", role: "user", content: "hello", created_at: "2026-01-01", seq: 5 }],
        has_more: true,
        max_seq: 100,
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(messagesRes), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const tool = agent.asGetMessagesTool("ds", "ns", "sess");
      const result = await tool.execute({ afterSeq: 4, limit: 10 });

      expect(result.messages).toHaveLength(1);
      expect(result.hasMore).toBe(true);
      expect(result.maxSeq).toBe(100);

      const url = (fetch as any).mock.calls[0][0] as string;
      expect(url).toContain("dataset=ds");
      expect(url).toContain("namespace=ns");
      expect(url).toContain("session=sess");
      expect(url).toContain("after_seq=4");
      expect(url).toContain("limit=10");
    });
  });
});
