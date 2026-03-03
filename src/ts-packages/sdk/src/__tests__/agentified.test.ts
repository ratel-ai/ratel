import { describe, it, expect, vi, beforeEach } from "vitest";
import { Agentified } from "../agentified.js";
import type { AgentifiedEvent, RankedTool, ServerTool } from "../types.js";

const TEST_URL = "http://localhost:9119";

const testTool: ServerTool = {
  name: "get_weather",
  description: "Get weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } } },
};

const rankedTool: RankedTool = { ...testTool, score: 0.95 };

describe("Agentified", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("register", () => {
    it("posts tools to server and returns registered count", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ registered: 1 }), { status: 200 }),
      );

      const agent = new Agentified({
        serverUrl: TEST_URL,
        tools: [testTool],
      });

      const result = await agent.register();

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/tools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tools: [testTool] }),
      });
      expect(result).toEqual({ registered: 1 });
    });
  });

  describe("prefetch", () => {
    it("posts discover request built from messages and returns ranked tools", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const agent = new Agentified({
        serverUrl: TEST_URL,
        tools: [testTool],
      });

      const result = await agent.prefetch({
        messages: [{ role: "user", content: "What is the weather in Paris?" }],
        limit: 5,
      });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "What is the weather in Paris?",
          limit: 5,
        }),
      });
      expect(result).toEqual([rankedTool]);
    });

    it("emits start and complete events with timing", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const events: AgentifiedEvent[] = [];
      const messages = [{ role: "user", content: "weather in Paris" }];

      const agent = new Agentified({
        serverUrl: TEST_URL,
        tools: [testTool],
        onEvent: (e) => events.push(e),
      });

      await agent.prefetch({ messages });

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: "agentified:prefetch:start",
        messages,
      });
      expect(events[1]).toMatchObject({
        type: "agentified:prefetch:complete",
        tools: [rankedTool],
      });
      expect(
        (events[1] as Extract<AgentifiedEvent, { type: "agentified:prefetch:complete" }>).durationMs,
      ).toBeGreaterThanOrEqual(0);
    });
  });

  describe("asDiscoverTool", () => {
    it("returns a DiscoverTool that calls discover endpoint", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const agent = new Agentified({
        serverUrl: TEST_URL,
        tools: [testTool],
      });

      const discoverTool = agent.asDiscoverTool();

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

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/discover`, {
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
      const agent = new Agentified({
        serverUrl: TEST_URL,
        tools: [testTool],
        onEvent: (e) => events.push(e),
      });

      await agent.asDiscoverTool().execute({ query: "weather" });

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: "agentified:discover:start",
        query: "weather",
      });
      expect(events[1]).toMatchObject({
        type: "agentified:discover:complete",
        tools: [rankedTool],
      });
      expect(
        (events[1] as Extract<AgentifiedEvent, { type: "agentified:discover:complete" }>).durationMs,
      ).toBeGreaterThanOrEqual(0);
    });
  });

  describe("prefetch with exclude", () => {
    it("passes exclude to discover body", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const agent = new Agentified({
        serverUrl: TEST_URL,
        tools: [testTool],
      });

      await agent.prefetch({
        messages: [{ role: "user", content: "test" }],
        exclude: ["frontendTool"],
      });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "test",
          exclude: ["frontendTool"],
        }),
      });
    });

    it("omits exclude from body when not provided", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const agent = new Agentified({
        serverUrl: TEST_URL,
        tools: [testTool],
      });

      await agent.prefetch({
        messages: [{ role: "user", content: "test" }],
      });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      });
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

      const agent = new Agentified({
        serverUrl: TEST_URL,
        tools: [frontendTool, serverTool],
      });

      expect(agent.getFrontendTools()).toEqual([frontendTool]);
    });

    it("returns empty array when no frontend tools", () => {
      const agent = new Agentified({
        serverUrl: TEST_URL,
        tools: [testTool],
      });

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

      const agent = new Agentified({
        serverUrl: TEST_URL,
        tools: [frontendTool, testTool],
      });

      expect(agent.getFrontendToolNames()).toEqual(["confirm_action"]);
    });
  });

  describe("captureTurn", () => {
    it("posts turn data and returns turnId", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ turn_id: "abc-123" }), { status: 201 }),
      );

      const agent = new Agentified({ serverUrl: TEST_URL, tools: [testTool] });
      const result = await agent.captureTurn({
        toolsLoaded: ["get_weather"],
        message: "What is the weather?",
      });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tools_loaded: ["get_weather"],
          message: "What is the weather?",
        }),
      });
      expect(result).toEqual({ turnId: "abc-123" });
    });
  });

  describe("prefetch with turnId", () => {
    it("passes turn_id to discover body", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const agent = new Agentified({ serverUrl: TEST_URL, tools: [testTool] });
      await agent.prefetch({
        messages: [{ role: "user", content: "test" }],
        limit: 5,
        turnId: "turn-xyz",
      });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "test",
          limit: 5,
          turn_id: "turn-xyz",
        }),
      });
    });

    it("omits turn_id when not provided", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 }),
      );

      const agent = new Agentified({ serverUrl: TEST_URL, tools: [testTool] });
      await agent.prefetch({
        messages: [{ role: "user", content: "test" }],
      });

      expect(fetch).toHaveBeenCalledWith(`${TEST_URL}/api/v1/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      });
    });
  });

  describe("onEvent optional", () => {
    it("does not crash when onEvent is not provided", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ tools: [rankedTool] }), { status: 200 })),
      );

      const agent = new Agentified({
        serverUrl: TEST_URL,
        tools: [testTool],
      });

      await expect(
        agent.prefetch({ messages: [{ role: "user", content: "test" }] }),
      ).resolves.toEqual([rankedTool]);

      await expect(
        agent.asDiscoverTool().execute({ query: "test" }),
      ).resolves.toEqual([rankedTool]);
    });
  });
});
