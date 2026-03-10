import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const mockRegister = vi.fn();
const mockAsDiscoverTool = vi.fn();
const mockAppendMessages = vi.fn();
const mockGetMessages = vi.fn();
const mockGetContext = vi.fn();

vi.mock("../api-client.js", () => ({
  ApiClient: vi.fn(() => ({
    register: mockRegister,
    asDiscoverTool: mockAsDiscoverTool,
    appendMessages: mockAppendMessages,
    getMessages: mockGetMessages,
    getContext: mockGetContext,
  })),
}));

const { mockSpawn, mockResolveBinary, mockFindFreePort } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockResolveBinary: vi.fn(),
  mockFindFreePort: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("../spawn-utils.js", () => ({
  resolveBinaryPath: mockResolveBinary,
  findFreePort: mockFindFreePort,
}));

import { Agentified } from "../agentified.js";
import type { AgentifiedTool } from "../types.js";

describe("Agentified", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    vi.clearAllMocks();
    mockAsDiscoverTool.mockReturnValue({
      definition: { name: "agentified_discover", description: "Find tools", parameters: {} },
      execute: vi.fn().mockResolvedValue([]),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

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

    it("throws with signal timeout on health check", async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 503 });

      const ag = new Agentified();
      await expect(ag.connect("http://localhost:9119")).rejects.toThrow(
        /Health check failed/,
      );
    });

    it("throws when called twice", async () => {
      fetchSpy.mockResolvedValue({ ok: true, status: 200 });

      const ag = new Agentified();
      await ag.connect("http://localhost:9119");
      await expect(ag.connect("http://localhost:9119")).rejects.toThrow(
        /Already connected/,
      );
      await ag.disconnect();
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

    it("spawns local process and connects after health check", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      mockResolveBinary.mockReturnValue("/path/to/agentified-core");
      mockFindFreePort.mockResolvedValue(9200);

      const fakeChild = Object.assign(new EventEmitter(), {
        pid: 1234,
        kill: vi.fn(),
        stdin: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      mockSpawn.mockReturnValue(fakeChild);
      fetchSpy.mockResolvedValue({ ok: true, status: 200 });

      const ag = new Agentified();
      await ag.connect();

      expect(mockSpawn).toHaveBeenCalledWith(
        "/path/to/agentified-core",
        [],
        expect.objectContaining({
          stdio: ["ignore", "pipe", "pipe"],
          env: expect.objectContaining({ AGENTIFIED_PORT: "9200" }),
        }),
      );
      expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:9200/health");
      expect(ag.sdk).not.toBeNull();

      await ag.disconnect();
    });

    it("throws after exhausting health check attempts", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      mockResolveBinary.mockReturnValue("/path/to/agentified-core");
      mockFindFreePort.mockResolvedValue(9201);

      const fakeChild = Object.assign(new EventEmitter(), {
        pid: 1234, kill: vi.fn(), stdin: null,
        stdout: new EventEmitter(), stderr: new EventEmitter(),
      });
      mockSpawn.mockReturnValue(fakeChild);
      fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

      const ag = new Agentified();
      ag.healthCheckDelayMs = 1;
      ag.healthCheckMaxAttempts = 3;
      await expect(ag.connect()).rejects.toThrow(/failed to start/);
      expect(fakeChild.kill).toHaveBeenCalled();
    });

    it("auto-restarts once on unexpected crash", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      mockResolveBinary.mockReturnValue("/path/to/agentified-core");
      mockFindFreePort.mockResolvedValue(9202);

      const fakeChild1 = Object.assign(new EventEmitter(), {
        pid: 1111, kill: vi.fn(), stdin: null,
        stdout: new EventEmitter(), stderr: new EventEmitter(),
      });
      const fakeChild2 = Object.assign(new EventEmitter(), {
        pid: 2222, kill: vi.fn(), stdin: null,
        stdout: new EventEmitter(), stderr: new EventEmitter(),
      });
      mockSpawn.mockReturnValueOnce(fakeChild1).mockReturnValueOnce(fakeChild2);
      fetchSpy.mockResolvedValue({ ok: true, status: 200 });

      const ag = new Agentified();
      await ag.connect();

      fakeChild1.emit("exit", 1, null);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockSpawn).toHaveBeenCalledTimes(2);

      await ag.disconnect();
    });

    it("does not restart more than once", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      mockResolveBinary.mockReturnValue("/path/to/agentified-core");
      mockFindFreePort.mockResolvedValue(9204);

      const children = Array.from({ length: 3 }, (_, i) =>
        Object.assign(new EventEmitter(), {
          pid: 3000 + i, kill: vi.fn(), stdin: null,
          stdout: new EventEmitter(), stderr: new EventEmitter(),
        }),
      );
      mockSpawn
        .mockReturnValueOnce(children[0])
        .mockReturnValueOnce(children[1])
        .mockReturnValueOnce(children[2]);
      fetchSpy.mockResolvedValue({ ok: true, status: 200 });

      const ag = new Agentified();
      await ag.connect();

      // First crash → restart
      children[0]!.emit("exit", 1, null);
      await new Promise((r) => setTimeout(r, 10));
      expect(mockSpawn).toHaveBeenCalledTimes(2);

      // Second crash → no restart
      children[1]!.emit("exit", 1, null);
      await new Promise((r) => setTimeout(r, 10));
      expect(mockSpawn).toHaveBeenCalledTimes(2);

      await ag.disconnect();
    });
  });

  describe("adaptTo()", () => {
    it("delegates to adapter.adapt with self", () => {
      const ag = new Agentified();
      const adapted = ag.adaptTo({
        adapt: (inner) => ({ wrapped: inner }),
      });
      expect(adapted.wrapped).toBe(ag);
    });
  });

  describe("dataset()", () => {
    it("returns a DatasetRef with the given name", async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });

      const ag = new Agentified();
      await ag.connect("http://localhost:9119");
      const ref = ag.dataset("my-dataset");

      expect(ref).toBeDefined();
      expect(ref.constructor.name).toBe("DatasetRef");
    });
  });

  describe("disconnect()", () => {
    it("is a no-op when not connected", async () => {
      const ag = new Agentified();
      await ag.disconnect();
    });

    it("is idempotent", async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
      const ag = new Agentified();
      await ag.connect("http://localhost:9119");
      await ag.disconnect();
      await ag.disconnect();
    });
  });

  describe("register()", () => {
    async function connectedAg(): Promise<Agentified> {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
      const ag = new Agentified();
      await ag.connect("http://localhost:9119");
      return ag;
    }

    it("throws when tool has no type and no handler", async () => {
      const ag = await connectedAg();
      const badTool = { name: "broken", description: "no type no handler", parameters: {} } as AgentifiedTool;
      await expect(ag.register({ tools: [badTool] })).rejects.toThrow(/no type and no handler/);
      await ag.disconnect();
    });

    it("throws when tool has type 'client'", async () => {
      const ag = await connectedAg();
      await expect(ag.register({ tools: [{ name: "ui", description: "client", parameters: {}, type: "client" as const }] })).rejects.toThrow(/Client tools/);
      await ag.disconnect();
    });

    it("throws when tool has type 'mcp'", async () => {
      const ag = await connectedAg();
      await expect(ag.register({ tools: [{ name: "m", description: "mcp", parameters: {}, type: "mcp" as const, server: "http://mcp" }] })).rejects.toThrow(/MCP tools/);
      await ag.disconnect();
    });

    it("returns Instance with datasetId after registering tools", async () => {
      const ag = await connectedAg();
      mockRegister.mockResolvedValue({ registered: 1 });

      const tool: AgentifiedTool = {
        name: "myTool", description: "does stuff",
        parameters: { type: "object" }, handler: async () => "ok",
      };

      const instance = await ag.dataset("my-dataset").register({ tools: [tool] });
      expect(instance.instanceId).toBe("my-dataset");
      expect(instance.datasetId).toBe("my-dataset");
      await ag.disconnect();
    });

    it("uses 'default' dataset when called on Agentified directly", async () => {
      const ag = await connectedAg();
      mockRegister.mockResolvedValue({ registered: 1 });

      const tool: AgentifiedTool = {
        name: "myTool", description: "does stuff",
        parameters: {}, handler: async () => "ok",
      };

      const instance = await ag.register({ tools: [tool] });
      expect(instance.instanceId).toBe("default");
      await ag.disconnect();
    });
  });

  describe("Instance", () => {
    async function connectedAg(): Promise<Agentified> {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
      const ag = new Agentified();
      await ag.connect("http://localhost:9119");
      return ag;
    }

    function backendTool(name: string): AgentifiedTool {
      return { name, description: `${name} tool`, parameters: { type: "object" }, handler: async () => "ok" };
    }

    async function registerInstance(ag: Agentified, tools: AgentifiedTool[] = [backendTool("myTool")]) {
      mockRegister.mockResolvedValue({ registered: tools.length });
      return ag.register({ tools });
    }

    it("has a discoverTool from sdk.asDiscoverTool", async () => {
      const ag = await connectedAg();
      const instance = await registerInstance(ag);

      expect(instance.discoverTool).toBeDefined();
      expect(instance.discoverTool.definition.name).toBe("agentified_discover");
      expect(mockAsDiscoverTool).toHaveBeenCalledWith("default");
      await ag.disconnect();
    });

    it("session(id) returns Session with given id and default namespace", async () => {
      const ag = await connectedAg();
      const instance = await registerInstance(ag);

      const session = instance.session("chat-1");
      expect(session.id).toBe("chat-1");
      expect(session.namespaceId).toBe("default");
      await ag.disconnect();
    });

    it("namespace(id) returns Namespace", async () => {
      const ag = await connectedAg();
      const instance = await registerInstance(ag);

      const ns = instance.namespace("user-123");
      expect(ns.id).toBe("user-123");
      expect(ns.tools).toEqual({});
      await ag.disconnect();
    });

    it("namespace(id).session(id) returns Session with correct namespace", async () => {
      const ag = await connectedAg();
      const instance = await registerInstance(ag);

      const session = instance.namespace("user-123").session("chat-1");
      expect(session.id).toBe("chat-1");
      expect(session.namespaceId).toBe("user-123");
      await ag.disconnect();
    });

    it("prepareStep returns all registered tool names + agentified_discover", async () => {
      const ag = await connectedAg();
      const instance = await registerInstance(ag, [backendTool("toolA"), backendTool("toolB")]);

      const result = await instance.prepareStep({ stepNumber: 0, steps: [] });
      expect(result.activeTools).toContain("toolA");
      expect(result.activeTools).toContain("toolB");
      expect(result.activeTools).toContain("agentified_discover");
      expect(result.activeTools).toHaveLength(3);
      await ag.disconnect();
    });

    it("prepareStep adds discovered tool names from prior steps", async () => {
      const ag = await connectedAg();
      const instance = await registerInstance(ag, [backendTool("toolA")]);

      const steps = [{
        toolResults: [{
          toolName: "agentified_discover",
          result: [{ name: "discoveredTool1", score: 0.9 }, { name: "discoveredTool2", score: 0.8 }],
        }],
      }];

      const result = await instance.prepareStep({ stepNumber: 1, steps });
      expect(result.activeTools).toContain("discoveredTool1");
      expect(result.activeTools).toContain("discoveredTool2");
      expect(result.activeTools).toHaveLength(4);
      await ag.disconnect();
    });
  });

  describe("Session", () => {
    async function connectedAg(): Promise<Agentified> {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
      const ag = new Agentified();
      await ag.connect("http://localhost:9119");
      return ag;
    }

    function backendTool(name: string): AgentifiedTool {
      return { name, description: `${name} tool`, parameters: { type: "object" }, handler: async () => "ok" };
    }

    async function registerInstance(ag: Agentified, tools: AgentifiedTool[] = [backendTool("myTool")]) {
      mockRegister.mockResolvedValue({ registered: tools.length });
      return ag.register({ tools });
    }

    it("prepareStep persists assistant/tool messages from steps", async () => {
      const ag = await connectedAg();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      mockAppendMessages.mockResolvedValue({ appended: 3, firstSeq: 1, lastSeq: 3 });

      const steps = [{
        text: "I'll help you with that.",
        toolCalls: [{ id: "call-1", toolName: "toolA", args: { x: 1 } }],
        toolResults: [
          { toolName: "toolA", toolCallId: "call-1", result: { answer: 42 } },
        ],
      }];

      const result = await session.prepareStep({ stepNumber: 1, steps });

      expect(mockAppendMessages).toHaveBeenCalledWith(
        "default", "default", "chat-1",
        expect.arrayContaining([
          expect.objectContaining({ role: "assistant", content: "I'll help you with that." }),
          expect.objectContaining({ role: "assistant", content: "", tool_calls: steps[0]!.toolCalls }),
          expect.objectContaining({ role: "tool", content: JSON.stringify({ answer: 42 }), tool_call_id: "call-1" }),
        ]),
      );
      expect(result.activeTools).toContain("toolA");
      await ag.disconnect();
    });

    it("updateConversation persists all messages on empty session", async () => {
      const ag = await connectedAg();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      mockGetMessages.mockResolvedValue({ messages: [], hasMore: false, maxSeq: 0 });
      mockAppendMessages.mockResolvedValue({ appended: 2, firstSeq: 1, lastSeq: 2 });

      await session.updateConversation({ messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ]});

      expect(mockAppendMessages).toHaveBeenCalledWith("default", "default", "chat-1", [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ]);
      await ag.disconnect();
    });

    it("updateConversation deduplicates tail", async () => {
      const ag = await connectedAg();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      mockGetMessages.mockResolvedValue({
        messages: [
          { id: "m1", role: "user", content: "Hello", seq: 1 },
          { id: "m2", role: "assistant", content: "Hi there", seq: 2 },
        ],
        hasMore: false, maxSeq: 2,
      });
      mockAppendMessages.mockResolvedValue({ appended: 1, firstSeq: 3, lastSeq: 3 });

      await session.updateConversation({ messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "What's the weather?" },
      ]});

      expect(mockAppendMessages).toHaveBeenCalledWith("default", "default", "chat-1", [
        { role: "user", content: "What's the weather?" },
      ]);
      await ag.disconnect();
    });

    it("context.messages().assemble() returns assembled context", async () => {
      const ag = await connectedAg();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      mockGetContext.mockResolvedValue({
        messages: [{ id: "m1", role: "user", content: "Hello", seq: 1 }],
        strategyUsed: "recent",
        totalMessages: 5,
        includedMessages: 1,
        recalled: { tools: [], memories: [] },
        tokenEstimate: 10,
        conversationMessages: 5,
        fallback: false,
      });

      const ctx = await session.context
        .messages({ strategy: "recent", maxTokens: 2000 })
        .assemble();

      expect(mockGetContext).toHaveBeenCalledWith("default", "default", "chat-1", {
        strategy: "recent", maxTokens: 2000,
      });
      expect(ctx.messages).toHaveLength(1);
      expect(ctx.strategyUsed).toBe("recent");
      await ag.disconnect();
    });

    it("context.messages().recall().assemble() works (recall is no-op stub)", async () => {
      const ag = await connectedAg();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      mockGetContext.mockResolvedValue({
        messages: [], strategyUsed: "recent", totalMessages: 0,
        includedMessages: 0, recalled: { tools: [], memories: [] },
        tokenEstimate: 0, conversationMessages: 0, fallback: false,
      });

      const ctx = await session.context.messages({ strategy: "recent" }).recall().assemble();
      expect(ctx.messages).toEqual([]);
      await ag.disconnect();
    });

    it("conversation.append() returns seq range", async () => {
      const ag = await connectedAg();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      mockAppendMessages.mockResolvedValue({ appended: 2, firstSeq: 1, lastSeq: 2 });

      const result = await session.conversation.append([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ]);

      expect(result).toEqual({ appended: 2, firstSeq: 1, lastSeq: 2 });
      await ag.disconnect();
    });

    it("discoverTool is available on session", async () => {
      const ag = await connectedAg();
      const instance = await registerInstance(ag);
      const session = instance.session("chat-1");

      expect(session.discoverTool).toBeDefined();
      expect(session.discoverTool.definition.name).toBe("agentified_discover");
      await ag.disconnect();
    });
  });
});
