import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const mockCreateTool = vi.fn(({ id, execute }: any) => ({
  id,
  execute,
  __mastraTool: true,
}));

vi.mock("@mastra/core/tools", () => ({
  createTool: (...args: any[]) => mockCreateTool(...args),
}));

const { mockSpawn, mockResolveBinary, mockFindFreePort } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockResolveBinary: vi.fn(),
  mockFindFreePort: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

// Mock spawn-utils at the agentified (SDK) level
vi.mock("agentified", async (importOriginal) => {
  const original = await importOriginal<typeof import("agentified")>();
  return {
    ...original,
    resolveBinaryPath: mockResolveBinary,
    findFreePort: mockFindFreePort,
  };
});

import { Agentified, type AgentifiedTool } from "../agentified.js";

describe("Agentified (Mastra)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Helper: make fetch return JSON for register + discover calls
  function mockFetchForRegister() {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.endsWith("/health")) return { ok: true, status: 200 };
      if (url.includes("/tools")) return new Response(JSON.stringify({ registered: 1 }), { status: 200 });
      if (url.includes("/discover")) return new Response(JSON.stringify({ tools: [] }), { status: 200 });
      if (url.includes("/messages")) return new Response(JSON.stringify({ messages: [], has_more: false, max_seq: 0 }), { status: 200 });
      if (url.includes("/context")) return new Response(JSON.stringify({
        messages: [], strategy_used: "recent", total_messages: 0,
        included_messages: 0, recalled: { tools: [], memories: [] },
        token_estimate: 0, conversation_messages: 0, fallback: false,
      }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
  }

  describe("connect(url)", () => {
    it("connects to remote server after health check passes", async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });

      const ag = new Agentified();
      await ag.connect("http://localhost:9119");

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:9119/health",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("throws when health check fails", async () => {
      fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

      const ag = new Agentified();
      await expect(ag.connect("http://localhost:9999")).rejects.toThrow();
    });
  });

  describe("connect() local auto-spawn", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("throws if OPENAI_API_KEY is not set", async () => {
      delete process.env.OPENAI_API_KEY;

      const ag = new Agentified();
      await expect(ag.connect()).rejects.toThrow(/OPENAI_API_KEY/);
    });

    it("throws if binary package is not installed", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      mockResolveBinary.mockReturnValue(null);

      const ag = new Agentified();
      await expect(ag.connect()).rejects.toThrow(/agentified.*core/i);
    });

    // Local spawn behavior is tested in the SDK package
  });

  describe("dataset()", () => {
    it("returns a Mastra DatasetRef", async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });

      const ag = new Agentified();
      await ag.connect("http://localhost:9119");
      const ref = ag.dataset("my-dataset");

      expect(ref).toBeDefined();
      expect(ref.constructor.name).toBe("DatasetRef");
    });
  });

  describe("register()", () => {
    it("returns Mastra Instance with createTool-wrapped discoverTool", async () => {
      mockFetchForRegister();

      const ag = new Agentified();
      await ag.connect("http://localhost:9119");

      const tool: AgentifiedTool = {
        name: "myTool", description: "does stuff",
        parameters: { type: "object" }, handler: async () => "ok",
      };

      const instance = await ag.register({ tools: [tool] });

      expect(instance.instanceId).toBe("default");
      expect(instance.discoverTool).toBeDefined();
      expect(instance.discoverTool.__mastraTool).toBe(true);
      expect(mockCreateTool).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "agentified_discover",
        }),
      );

      await ag.disconnect();
    });

    it("session(id) returns Session with given id", async () => {
      mockFetchForRegister();

      const ag = new Agentified();
      await ag.connect("http://localhost:9119");

      const instance = await ag.register({
        tools: [{ name: "myTool", description: "tool", parameters: {}, handler: async () => "ok" }],
      });
      const session = instance.session("chat-1");

      expect(session.id).toBe("chat-1");
      expect(session.namespaceId).toBe("default");

      await ag.disconnect();
    });

    it("namespace(id) returns Namespace with tools stub", async () => {
      mockFetchForRegister();

      const ag = new Agentified();
      await ag.connect("http://localhost:9119");

      const instance = await ag.register({
        tools: [{ name: "myTool", description: "tool", parameters: {}, handler: async () => "ok" }],
      });
      const ns = instance.namespace("user-123");

      expect(ns.id).toBe("user-123");
      expect(ns.tools).toEqual({});

      await ag.disconnect();
    });
  });

  describe("Session", () => {
    async function setup(tools: AgentifiedTool[] = [{ name: "toolA", description: "toolA", parameters: { type: "object" }, handler: async () => "ok" }]) {
      mockFetchForRegister();
      const ag = new Agentified();
      await ag.connect("http://localhost:9119");
      const instance = await ag.register({ tools });
      return { ag, instance };
    }

    it("context.messages().build() returns assembled context", async () => {
      const { ag, instance } = await setup();
      const session = instance.session("chat-1");

      // Override fetch for context call
      fetchSpy.mockImplementation(async (url: string) => {
        if (url.includes("/context")) {
          return new Response(JSON.stringify({
            messages: [{ id: "m1", role: "user", content: "Hello", seq: 1, tool_call_id: null, tool_calls: null, created_at: "2026-01-01" }],
            strategy_used: "recent", total_messages: 5, included_messages: 1,
            recalled: { tools: [], memories: [] },
            token_estimate: 10, conversation_messages: 5, fallback: false,
          }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      });

      const ctx = await session.context
        .messages({ strategy: "recent", maxTokens: 2000 })
        .build();

      expect(ctx.messages).toHaveLength(1);
      expect(ctx.strategyUsed).toBe("recent");
      await ag.disconnect();
    });

    it("conversation.append() posts messages", async () => {
      const { ag, instance } = await setup();
      const session = instance.session("chat-1");

      fetchSpy.mockImplementation(async (url: string, opts: any) => {
        if (url.includes("/messages") && opts?.method === "POST") {
          return new Response(JSON.stringify({ appended: 2, first_seq: 1, last_seq: 2 }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      });

      const result = await session.conversation.append([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ]);

      expect(result).toEqual({ appended: 2, firstSeq: 1, lastSeq: 2 });
      await ag.disconnect();
    });
  });
});
