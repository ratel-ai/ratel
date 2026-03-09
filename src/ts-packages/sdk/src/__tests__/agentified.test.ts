import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiClient } from "../agentified.js";
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

  describe("createInstance", () => {
    it("posts dataset and returns instanceId", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ instance_id: "inst-abc" }), { status: 201 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const result = await agent.createInstance("my-dataset");

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/instances`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset: "my-dataset" }),
      });
      expect(result).toEqual({ instanceId: "inst-abc" });
    });
  });

  describe("heartbeatInstance", () => {
    it("posts heartbeat and returns void", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 204 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      await agent.heartbeatInstance("inst-abc");

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/instances/inst-abc/heartbeat`, {
        method: "POST",
      });
    });
  });

  describe("deleteInstance", () => {
    it("sends delete and returns void", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 204 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      await agent.deleteInstance("inst-abc");

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/instances/inst-abc`, {
        method: "DELETE",
      });
    });
  });

  describe("register", () => {
    it("posts tools to instance endpoint and returns registered count", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ registered: 1 }), { status: 200 }),
      );

      const agent = new ApiClient({
        serverUrl: TEST_URL,
        tools: [testTool],
      });

      const result = await agent.register("inst-abc");

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/instances/inst-abc/tools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tools: [testTool] }),
      });
      expect(result).toEqual({ registered: 1 });
    });
  });

  describe("discover", () => {
    it("posts to instance discover endpoint and returns ranked tools", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const result = await agent.discover("inst-abc", "weather tools", 5);

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/instances/inst-abc/discover`, {
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
      await agent.discover("inst-abc", "test", undefined, ["excluded"], "turn-1");

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/instances/inst-abc/discover`, {
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
      await agent.discover("inst-abc", "test");

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/instances/inst-abc/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      });
    });
  });

  describe("prefetch", () => {
    it("builds query from messages and returns ranked tools via instance discover", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const result = await agent.prefetch("inst-abc", {
        messages: [{ role: "user", content: "What is the weather in Paris?" }],
        limit: 5,
      });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/instances/inst-abc/discover`, {
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

      await agent.prefetch("inst-abc", { messages });

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
      await agent.prefetch("inst-abc", {
        messages: [{ role: "user", content: "test" }],
        exclude: ["frontendTool"],
      });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/instances/inst-abc/discover`, {
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
      await agent.prefetch("inst-abc", {
        messages: [{ role: "user", content: "test" }],
        limit: 5,
        turnId: "turn-xyz",
      });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/instances/inst-abc/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test", limit: 5, turn_id: "turn-xyz" }),
      });
    });
  });

  describe("asDiscoverTool", () => {
    it("returns a DiscoverTool that calls instance discover endpoint", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const discoverTool = agent.asDiscoverTool("inst-abc");

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

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/instances/inst-abc/discover`, {
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

      await agent.asDiscoverTool("inst-abc").execute({ query: "weather" });

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "agentified:discover:start", query: "weather" });
      expect(events[1]).toMatchObject({ type: "agentified:discover:complete", tools: [rankedTool] });
      expect(
        (events[1] as Extract<AgentifiedEvent, { type: "agentified:discover:complete" }>).durationMs,
      ).toBeGreaterThanOrEqual(0);
    });
  });

  describe("captureTurn", () => {
    it("posts turn data to instance endpoint and returns turnId", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ turn_id: "abc-123" }), { status: 201 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const result = await agent.captureTurn("inst-abc", "default", "session-1", {
        toolsLoaded: ["get_weather"],
        message: "What is the weather?",
      });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/instances/inst-abc/turns`, {
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
    it("gets messages with no opts", async () => {
      const stored = { id: "m1", role: "user", content: "Hello", tool_call_id: null, tool_calls: null, created_at: "2026-01-01T00:00:00Z", seq: 1 };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ messages: [stored], has_more: false, max_seq: 1 }), { status: 200 }),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });
      const result = await agent.getMessages("ds", "ns", "sess");

      expect(fetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/v1/messages?dataset=ds&namespace=ns&session=sess`,
        { method: "GET" },
      );
      expect(result).toEqual({ messages: [stored], hasMore: false, maxSeq: 1 });
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
    it("posts context request with defaults when no opts", async () => {
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
      const result = await agent.getContext("ds", "ns", "sess");

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataset: "ds",
          namespace: "ns",
          session: "sess",
          messages: {},
        }),
      });
      expect(result).toEqual({
        messages: [],
        strategyUsed: "recent",
        totalMessages: 0,
        includedMessages: 0,
        recalled: { tools: [], memories: [] },
        tokenEstimate: 0,
        conversationMessages: 0,
        fallback: false,
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

  describe("onEvent optional", () => {
    it("does not crash when onEvent is not provided", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 })),
      );

      const agent = new ApiClient({ serverUrl: TEST_URL, tools: [testTool] });

      await expect(
        agent.prefetch("inst-abc", { messages: [{ role: "user", content: "test" }] }),
      ).resolves.toEqual([rankedTool]);

      await expect(
        agent.asDiscoverTool("inst-abc").execute({ query: "test" }),
      ).resolves.toEqual([rankedTool]);
    });
  });
});
