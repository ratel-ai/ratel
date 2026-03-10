import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const mockCreateInstance = vi.fn();
const mockHeartbeatInstance = vi.fn();
const mockDeleteInstance = vi.fn();
const mockRegister = vi.fn();
const mockAsDiscoverTool = vi.fn();
const mockAppendMessages = vi.fn();
const mockGetMessages = vi.fn();
const mockGetContext = vi.fn();

vi.mock("@agentified/sdk", () => ({
  ApiClient: vi.fn(() => ({
    createInstance: mockCreateInstance,
    heartbeatInstance: mockHeartbeatInstance,
    deleteInstance: mockDeleteInstance,
    register: mockRegister,
    asDiscoverTool: mockAsDiscoverTool,
    appendMessages: mockAppendMessages,
    getMessages: mockGetMessages,
    getContext: mockGetContext,
  })),
}));

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

vi.mock("./spawn-utils.js", () => ({
  resolveBinaryPath: mockResolveBinary,
  findFreePort: mockFindFreePort,
}));

import { Agentified, type AgentifiedTool } from "./agentified.js";

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

    it("passes an AbortSignal with 5s timeout to fetch", async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });

      const ag = new Agentified();
      await ag.connect("http://localhost:9119");

      const options = fetchSpy.mock.calls[0][1];
      expect(options.signal).toBeInstanceOf(AbortSignal);
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

      // health check succeeds on first attempt
      fetchSpy.mockResolvedValue({ ok: true, status: 200 });

      const ag = new Agentified();
      await ag.connect();

      expect(mockSpawn).toHaveBeenCalledWith(
        "/path/to/agentified-core",
        expect.arrayContaining(["--port", "9200"]),
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
      );
      expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:9200/health");
      expect(ag.sdk).not.toBeNull();

      await ag.disconnect();
    });

    it("throws and kills process after 25 failed health checks", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      mockResolveBinary.mockReturnValue("/path/to/agentified-core");
      mockFindFreePort.mockResolvedValue(9300);

      const fakeChild = Object.assign(new EventEmitter(), {
        pid: 5678,
        kill: vi.fn(),
        stdin: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      mockSpawn.mockReturnValue(fakeChild);

      fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

      const ag = new Agentified();
      ag.healthCheckDelayMs = 0;

      await expect(ag.connect()).rejects.toThrow(/failed to start/i);

      expect(fakeChild.kill).toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(25);
    });

    it("registers signal cleanup handlers after spawn", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      mockResolveBinary.mockReturnValue("/path/to/agentified-core");
      mockFindFreePort.mockResolvedValue(9201);

      const fakeChild = Object.assign(new EventEmitter(), {
        pid: 1234,
        kill: vi.fn(),
        stdin: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      mockSpawn.mockReturnValue(fakeChild);
      fetchSpy.mockResolvedValue({ ok: true, status: 200 });

      const onSpy = vi.spyOn(process, "on");

      const ag = new Agentified();
      await ag.connect();

      const registeredEvents = onSpy.mock.calls.map((c) => c[0]);
      expect(registeredEvents).toContain("SIGINT");
      expect(registeredEvents).toContain("SIGTERM");

      onSpy.mockRestore();
      await ag.disconnect();
    });

    it("auto-restarts once on unexpected crash", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      mockResolveBinary.mockReturnValue("/path/to/agentified-core");
      mockFindFreePort.mockResolvedValue(9202);

      const fakeChild1 = Object.assign(new EventEmitter(), {
        pid: 1111,
        kill: vi.fn(),
        stdin: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      const fakeChild2 = Object.assign(new EventEmitter(), {
        pid: 2222,
        kill: vi.fn(),
        stdin: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      mockSpawn.mockReturnValueOnce(fakeChild1).mockReturnValueOnce(fakeChild2);
      fetchSpy.mockResolvedValue({ ok: true, status: 200 });

      const ag = new Agentified();
      await ag.connect();

      // simulate unexpected crash
      fakeChild1.emit("exit", 1, null);

      // give event loop a tick to process restart
      await new Promise((r) => setTimeout(r, 10));

      // should have spawned a second process
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect((ag as any).spawnedProcess.pid).toBe(2222);

      await ag.disconnect();
    });

    it("does not restart more than once", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      mockResolveBinary.mockReturnValue("/path/to/agentified-core");
      mockFindFreePort.mockResolvedValue(9203);

      const fakeChild1 = Object.assign(new EventEmitter(), {
        pid: 3333,
        kill: vi.fn(),
        stdin: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      const fakeChild2 = Object.assign(new EventEmitter(), {
        pid: 4444,
        kill: vi.fn(),
        stdin: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      mockSpawn.mockReturnValueOnce(fakeChild1).mockReturnValueOnce(fakeChild2);
      fetchSpy.mockResolvedValue({ ok: true, status: 200 });

      const ag = new Agentified();
      await ag.connect();

      // first crash → restart
      fakeChild1.emit("exit", 1, null);
      await new Promise((r) => setTimeout(r, 10));

      // second crash → no restart
      fakeChild2.emit("exit", 1, null);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockSpawn).toHaveBeenCalledTimes(2); // only 2, not 3
      await ag.disconnect();
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
      await ag.disconnect(); // should not throw
    });

    it("is idempotent - second disconnect is no-op", async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });

      const ag = new Agentified();
      await ag.connect("http://localhost:9119");
      await ag.disconnect();
      await ag.disconnect(); // should not throw
    });

    it("deletes all tracked instances on disconnect", async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
      mockDeleteInstance.mockResolvedValue(undefined);

      const ag = new Agentified();
      await ag.connect("http://localhost:9119");

      // Simulate tracked instances (would normally be created via register)
      (ag as any).activeInstances.add("inst-1");
      (ag as any).activeInstances.add("inst-2");

      await ag.disconnect();

      expect(mockDeleteInstance).toHaveBeenCalledWith("inst-1");
      expect(mockDeleteInstance).toHaveBeenCalledWith("inst-2");
    });

    it("clears heartbeat intervals on disconnect", async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
      const clearSpy = vi.spyOn(globalThis, "clearInterval");

      const ag = new Agentified();
      await ag.connect("http://localhost:9119");

      // Simulate a heartbeat interval
      const interval = setInterval(() => {}, 30000);
      (ag as any).heartbeatIntervals.set("inst-1", interval);
      (ag as any).activeInstances.add("inst-1");
      mockDeleteInstance.mockResolvedValue(undefined);

      await ag.disconnect();

      expect(clearSpy).toHaveBeenCalledWith(interval);
      clearSpy.mockRestore();
    });

    it("continues cleanup even if instance deletion fails", async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
      mockDeleteInstance
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(undefined);

      const ag = new Agentified();
      await ag.connect("http://localhost:9119");

      (ag as any).activeInstances.add("inst-1");
      (ag as any).activeInstances.add("inst-2");

      await ag.disconnect(); // should not throw

      expect(mockDeleteInstance).toHaveBeenCalledTimes(2);
    });
  });

  describe("register()", () => {
    async function connectedAgentified(): Promise<Agentified> {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
      const ag = new Agentified();
      await ag.connect("http://localhost:9119");
      return ag;
    }

    it("throws when tool has no type and no handler", async () => {
      const ag = await connectedAgentified();
      const badTool = { name: "broken", description: "no type no handler", parameters: {} } as AgentifiedTool;

      await expect(ag.register({ tools: [badTool] })).rejects.toThrow(
        /Tool 'broken' has no type and no handler/,
      );

      await ag.disconnect();
    });

    it("throws when tool has type 'client'", async () => {
      const ag = await connectedAgentified();
      const clientTool = { name: "ui-tool", description: "client", parameters: {}, type: "client" as const };

      await expect(ag.register({ tools: [clientTool] })).rejects.toThrow(
        /Client tools are not yet supported/,
      );
      await ag.disconnect();
    });

    it("throws when tool has type 'mcp'", async () => {
      const ag = await connectedAgentified();
      const mcpTool = { name: "mcp-tool", description: "mcp", parameters: {}, type: "mcp" as const, server: "http://mcp" };

      await expect(ag.register({ tools: [mcpTool] })).rejects.toThrow(
        /MCP tools are not yet supported/,
      );
      await ag.disconnect();
    });

    it("returns Instance with instanceId after registering tools (TC-003)", async () => {
      const ag = await connectedAgentified();
      mockCreateInstance.mockResolvedValue({ instanceId: "inst-abc" });
      mockRegister.mockResolvedValue({ registered: 1 });

      const tool: AgentifiedTool = {
        name: "myTool",
        description: "does stuff",
        parameters: { type: "object" },
        handler: async () => "ok",
      };

      const instance = await ag.dataset("my-dataset").register({ tools: [tool] });

      expect(instance.instanceId).toBe("inst-abc");
      expect(instance.datasetId).toBe("my-dataset");
      expect(mockCreateInstance).toHaveBeenCalledWith("my-dataset");

      await ag.disconnect();
    });

    it("uses 'default' dataset when called on Agentified directly (TC-004)", async () => {
      const ag = await connectedAgentified();
      mockCreateInstance.mockResolvedValue({ instanceId: "inst-def" });
      mockRegister.mockResolvedValue({ registered: 1 });

      const tool: AgentifiedTool = {
        name: "myTool",
        description: "does stuff",
        parameters: {},
        handler: async () => "ok",
      };

      const instance = await ag.register({ tools: [tool] });

      expect(instance.instanceId).toBe("inst-def");
      expect(instance.datasetId).toBe("default");
      expect(mockCreateInstance).toHaveBeenCalledWith("default");

      await ag.disconnect();
    });

    it("starts 30s heartbeat interval after register", async () => {
      const ag = await connectedAgentified();
      mockCreateInstance.mockResolvedValue({ instanceId: "inst-hb" });
      mockRegister.mockResolvedValue({ registered: 1 });
      mockHeartbeatInstance.mockResolvedValue(undefined);

      const tool: AgentifiedTool = {
        name: "t",
        description: "t",
        parameters: {},
        handler: async () => "ok",
      };

      await ag.register({ tools: [tool] });

      // Heartbeat interval is tracked
      expect((ag as any).heartbeatIntervals.has("inst-hb")).toBe(true);

      // Disconnect clears the interval (and calls deleteInstance)
      mockDeleteInstance.mockResolvedValue(undefined);
      await ag.disconnect();
      expect((ag as any).heartbeatIntervals.size).toBe(0);
    });

    it("tracks instance for cleanup on disconnect", async () => {
      const ag = await connectedAgentified();
      mockCreateInstance.mockResolvedValue({ instanceId: "inst-track" });
      mockRegister.mockResolvedValue({ registered: 1 });
      mockDeleteInstance.mockResolvedValue(undefined);

      const tool: AgentifiedTool = {
        name: "t",
        description: "t",
        parameters: {},
        handler: async () => "ok",
      };

      await ag.register({ tools: [tool] });
      expect((ag as any).activeInstances.has("inst-track")).toBe(true);

      await ag.disconnect();
      expect(mockDeleteInstance).toHaveBeenCalledWith("inst-track");
    });

    it("creates two separate instances for two register() calls (TC-014)", async () => {
      const ag = await connectedAgentified();
      mockCreateInstance
        .mockResolvedValueOnce({ instanceId: "inst-1" })
        .mockResolvedValueOnce({ instanceId: "inst-2" });
      mockRegister.mockResolvedValue({ registered: 1 });

      const tool: AgentifiedTool = {
        name: "t",
        description: "t",
        parameters: {},
        handler: async () => "ok",
      };

      const i1 = await ag.register({ tools: [tool] });
      const i2 = await ag.register({ tools: [tool] });

      expect(i1.instanceId).toBe("inst-1");
      expect(i2.instanceId).toBe("inst-2");
      expect(mockCreateInstance).toHaveBeenCalledTimes(2);

      await ag.disconnect();
    });

    it("cleans up instance on registration failure", async () => {
      const ag = await connectedAgentified();
      mockCreateInstance.mockResolvedValue({ instanceId: "inst-fail" });
      mockRegister.mockRejectedValue(new Error("registration error"));
      mockDeleteInstance.mockResolvedValue(undefined);

      const tool: AgentifiedTool = {
        name: "t",
        description: "t",
        parameters: {},
        handler: async () => "ok",
      };

      await expect(ag.register({ tools: [tool] })).rejects.toThrow("registration error");
      expect(mockDeleteInstance).toHaveBeenCalledWith("inst-fail");
    });

    it("defaults type to 'backend' when handler present without type", async () => {
      const ag = await connectedAgentified();
      mockCreateInstance.mockResolvedValue({ instanceId: "inst-type" });
      mockRegister.mockResolvedValue({ registered: 1 });

      const tool: AgentifiedTool = {
        name: "myTool",
        description: "has handler",
        parameters: {},
        handler: async () => "result",
      };

      // Should not throw — handler present implies backend type
      const instance = await ag.register({ tools: [tool] });
      expect(instance.instanceId).toBe("inst-type");

      await ag.disconnect();
    });
  });

  describe("Instance", () => {
    async function connectedAgentified(): Promise<Agentified> {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
      const ag = new Agentified();
      await ag.connect("http://localhost:9119");
      return ag;
    }

    function backendTool(name: string): AgentifiedTool {
      return {
        name,
        description: `${name} tool`,
        parameters: { type: "object" },
        handler: async () => "ok",
      };
    }

    async function registerInstance(ag: Agentified, tools: AgentifiedTool[] = [backendTool("myTool")]) {
      mockCreateInstance.mockResolvedValue({ instanceId: "inst-1" });
      mockRegister.mockResolvedValue({ registered: tools.length });
      mockAsDiscoverTool.mockReturnValue({
        definition: {
          name: "agentified_discover",
          description: "Find tools",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
        execute: vi.fn().mockResolvedValue([]),
      });
      return ag.register({ tools });
    }

    it("has a discoverTool that wraps sdk.asDiscoverTool as Mastra createTool", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag);

      expect(instance.discoverTool).toBeDefined();
      expect(mockAsDiscoverTool).toHaveBeenCalledWith("inst-1");
      expect(mockCreateTool).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "agentified_discover",
          description: "Find tools",
        }),
      );

      await ag.disconnect();
    });

    it("session(id) returns Session with given id and default namespace (TC-005)", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag);

      const session = instance.session("chat-1");

      expect(session).toBeDefined();
      expect(session.id).toBe("chat-1");
      expect(session.namespaceId).toBe("default");

      await ag.disconnect();
    });

    it("prepareStep returns all registered tool names + agentified_discover when no discover results (TC-007)", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag, [backendTool("toolA"), backendTool("toolB")]);

      const result = await instance.prepareStep({ stepNumber: 0, steps: [] });

      expect(result.activeTools).toContain("toolA");
      expect(result.activeTools).toContain("toolB");
      expect(result.activeTools).toContain("agentified_discover");
      expect(result.activeTools).toHaveLength(3);

      await ag.disconnect();
    });

    it("prepareStep adds discovered tool names from prior steps (TC-007)", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag, [backendTool("toolA")]);

      const steps = [
        {
          toolResults: [
            {
              toolName: "agentified_discover",
              result: [
                { name: "discoveredTool1", score: 0.9 },
                { name: "discoveredTool2", score: 0.8 },
              ],
            },
          ],
        },
      ];

      const result = await instance.prepareStep({ stepNumber: 1, steps });

      expect(result.activeTools).toContain("toolA");
      expect(result.activeTools).toContain("agentified_discover");
      expect(result.activeTools).toContain("discoveredTool1");
      expect(result.activeTools).toContain("discoveredTool2");
      expect(result.activeTools).toHaveLength(4);

      await ag.disconnect();
    });
  });

  describe("Session", () => {
    async function connectedAgentified(): Promise<Agentified> {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
      const ag = new Agentified();
      await ag.connect("http://localhost:9119");
      return ag;
    }

    function backendTool(name: string): AgentifiedTool {
      return {
        name,
        description: `${name} tool`,
        parameters: { type: "object" },
        handler: async () => "ok",
      };
    }

    async function registerInstance(ag: Agentified, tools: AgentifiedTool[] = [backendTool("myTool")]) {
      mockCreateInstance.mockResolvedValue({ instanceId: "inst-1" });
      mockRegister.mockResolvedValue({ registered: tools.length });
      mockAsDiscoverTool.mockReturnValue({
        definition: {
          name: "agentified_discover",
          description: "Find tools",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
        execute: vi.fn().mockResolvedValue([]),
      });
      return ag.register({ tools });
    }

    it("prepareStep returns initial tools when no steps (TC-007)", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag, [backendTool("toolA"), backendTool("toolB")]);
      const session = instance.session("chat-1");

      const result = await session.prepareStep({ stepNumber: 0, steps: [] });

      expect(result.activeTools).toContain("toolA");
      expect(result.activeTools).toContain("toolB");
      expect(result.activeTools).toContain("agentified_discover");
      expect(result.activeTools).toHaveLength(3);
      expect(mockAppendMessages).not.toHaveBeenCalled();

      await ag.disconnect();
    });

    it("prepareStep extracts and persists assistant/tool messages from steps (TC-008)", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      mockAppendMessages.mockResolvedValue({ appended: 3, firstSeq: 1, lastSeq: 3 });

      const steps = [
        {
          text: "I'll help you with that.",
          toolCalls: [{ id: "call-1", toolName: "toolA", args: { x: 1 } }],
          toolResults: [
            { toolName: "toolA", toolCallId: "call-1", result: { answer: 42 } },
          ],
        },
      ];

      const result = await session.prepareStep({ stepNumber: 1, steps });

      expect(mockAppendMessages).toHaveBeenCalledWith(
        "default", // dataset
        "default", // namespace
        "chat-1",  // session
        expect.arrayContaining([
          expect.objectContaining({ role: "assistant", content: "I'll help you with that." }),
          expect.objectContaining({ role: "assistant", content: "", tool_calls: steps[0].toolCalls }),
          expect.objectContaining({ role: "tool", content: JSON.stringify({ answer: 42 }), tool_call_id: "call-1" }),
        ]),
      );
      expect(result.activeTools).toContain("toolA");

      await ag.disconnect();
    });

    it("prepareStep is no-op when steps have no extractable messages (TC-008)", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      // Steps with no text, no toolCalls, no toolResults
      const steps = [{ someOtherField: true }];

      await session.prepareStep({ stepNumber: 1, steps });

      expect(mockAppendMessages).not.toHaveBeenCalled();

      await ag.disconnect();
    });

    it("prepareStep adds discovered tool names from prior steps (TC-007)", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      mockAppendMessages.mockResolvedValue({ appended: 2, firstSeq: 1, lastSeq: 2 });

      const steps = [
        {
          toolResults: [
            {
              toolName: "agentified_discover",
              result: [
                { name: "discoveredTool1", score: 0.9 },
                { name: "discoveredTool2", score: 0.8 },
              ],
              toolCallId: "dc-1",
            },
          ],
        },
      ];

      const result = await session.prepareStep({ stepNumber: 1, steps });

      expect(result.activeTools).toContain("toolA");
      expect(result.activeTools).toContain("agentified_discover");
      expect(result.activeTools).toContain("discoveredTool1");
      expect(result.activeTools).toContain("discoveredTool2");
      expect(result.activeTools).toHaveLength(4);

      await ag.disconnect();
    });

    it("updateConversation persists all messages on empty session (TC-009)", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      // Empty session — getMessages returns no messages
      mockGetMessages.mockResolvedValue({ messages: [], hasMore: false, maxSeq: 0 });
      mockAppendMessages.mockResolvedValue({ appended: 2, firstSeq: 1, lastSeq: 2 });

      const msgs = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];

      await session.updateConversation({ messages: msgs });

      expect(mockGetMessages).toHaveBeenCalledWith("default", "default", "chat-1", { limit: 2 });
      expect(mockAppendMessages).toHaveBeenCalledWith("default", "default", "chat-1", msgs);

      await ag.disconnect();
    });

    it("updateConversation deduplicates tail and persists only new messages (TC-009)", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      // Session already has 2 messages
      mockGetMessages.mockResolvedValue({
        messages: [
          { id: "m1", role: "user", content: "Hello", seq: 1 },
          { id: "m2", role: "assistant", content: "Hi there", seq: 2 },
        ],
        hasMore: false,
        maxSeq: 2,
      });
      mockAppendMessages.mockResolvedValue({ appended: 1, firstSeq: 3, lastSeq: 3 });

      // Incoming: 2 old + 1 new
      const msgs = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "What's the weather?" },
      ];

      await session.updateConversation({ messages: msgs });

      // Should only persist the new message
      expect(mockAppendMessages).toHaveBeenCalledWith("default", "default", "chat-1", [
        { role: "user", content: "What's the weather?" },
      ]);

      await ag.disconnect();
    });

    it("context.messages().assemble() returns assembled context from server (TC-009c)", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      mockGetContext.mockResolvedValue({
        messages: [
          { id: "m1", role: "user", content: "Hello", seq: 1, created_at: "2026-01-01" },
          { id: "m2", role: "assistant", content: "Hi", seq: 2, created_at: "2026-01-01" },
        ],
        strategyUsed: "recent",
        totalMessages: 5,
        includedMessages: 2,
        recalled: { tools: [], memories: [] },
        tokenEstimate: 10,
        conversationMessages: 5,
        fallback: false,
      });

      const ctx = await session.context
        .messages({ strategy: "recent", maxTokens: 2000 })
        .assemble();

      expect(mockGetContext).toHaveBeenCalledWith("default", "default", "chat-1", {
        strategy: "recent",
        maxTokens: 2000,
      });
      expect(ctx.messages).toHaveLength(2);
      expect(ctx.strategyUsed).toBe("recent");
      expect(ctx.totalMessages).toBe(5);
      expect(ctx.includedMessages).toBe(2);
      expect(ctx.tokenEstimate).toBe(10);
      expect(ctx.conversationMessages).toBe(5);
      expect(ctx.fallback).toBe(false);
      expect(ctx.recalled).toEqual({ tools: [], memories: [] });

      await ag.disconnect();
    });

    it("context.messages().recall().assemble() works (recall is no-op stub)", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      mockGetContext.mockResolvedValue({
        messages: [],
        strategyUsed: "recent",
        totalMessages: 0,
        includedMessages: 0,
        recalled: { tools: [], memories: [] },
        tokenEstimate: 0,
        conversationMessages: 0,
        fallback: false,
      });

      const ctx = await session.context
        .messages({ strategy: "recent" })
        .recall()
        .assemble();

      expect(ctx).toBeDefined();
      expect(ctx.messages).toEqual([]);

      await ag.disconnect();
    });

    it("conversation.append() returns seq range (TC-010)", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      mockAppendMessages.mockResolvedValue({ appended: 2, firstSeq: 1, lastSeq: 2 });

      const result = await session.conversation.append([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ]);

      expect(result).toEqual({ appended: 2, firstSeq: 1, lastSeq: 2 });
      expect(mockAppendMessages).toHaveBeenCalledWith("default", "default", "chat-1", [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ]);

      await ag.disconnect();
    });

    it("conversation.messages() returns stored messages (TC-011)", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      const stored = [
        { id: "m1", role: "user", content: "Hello", seq: 1, created_at: "2026-01-01" },
        { id: "m2", role: "assistant", content: "Hi", seq: 2, created_at: "2026-01-01" },
      ];
      mockGetMessages.mockResolvedValue({ messages: stored, hasMore: false, maxSeq: 2 });

      const msgs = await session.conversation.messages({ limit: 10 });

      expect(msgs).toEqual(stored);
      expect(mockGetMessages).toHaveBeenCalledWith("default", "default", "chat-1", { limit: 10 });

      await ag.disconnect();
    });

    it("getMessages() returns context via sdk.getContext (TC-009c)", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      mockGetContext.mockResolvedValue({
        messages: [
          { id: "m1", role: "user", content: "Hello", seq: 1, created_at: "2026-01-01" },
        ],
        strategyUsed: "recent",
        totalMessages: 3,
        includedMessages: 1,
        recalled: { tools: [], memories: [] },
        tokenEstimate: 5,
        conversationMessages: 3,
        fallback: false,
      });

      const result = await session.getMessages({ strategy: "recent", maxTokens: 2000 });

      expect(mockGetContext).toHaveBeenCalledWith("default", "default", "chat-1", {
        strategy: "recent",
        maxTokens: 2000,
      });
      expect(result.messages).toHaveLength(1);
      expect(result.strategyUsed).toBe("recent");
      expect(result.totalMessages).toBe(3);
      expect(result.includedMessages).toBe(1);
      expect(result.fallback).toBe(false);

      await ag.disconnect();
    });

    it("getMessages({ maxMessages }) truncates from oldest", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      mockGetContext.mockResolvedValue({
        messages: [
          { id: "m1", role: "user", content: "1", seq: 1, created_at: "2026-01-01" },
          { id: "m2", role: "assistant", content: "2", seq: 2, created_at: "2026-01-01" },
          { id: "m3", role: "user", content: "3", seq: 3, created_at: "2026-01-01" },
        ],
        strategyUsed: "recent",
        totalMessages: 3,
        includedMessages: 3,
        recalled: { tools: [], memories: [] },
        tokenEstimate: 15,
        conversationMessages: 3,
        fallback: false,
      });

      const result = await session.getMessages({ maxMessages: 2 });

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content).toBe("2");
      expect(result.messages[1].content).toBe("3");
      expect(result.includedMessages).toBe(2);

      await ag.disconnect();
    });

    it("updateConversation is no-op when all messages are duplicates (TC-009b)", async () => {
      const ag = await connectedAgentified();
      const instance = await registerInstance(ag, [backendTool("toolA")]);
      const session = instance.session("chat-1");

      const msgs = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];

      // First call: empty session
      mockGetMessages.mockResolvedValueOnce({ messages: [], hasMore: false, maxSeq: 0 });
      mockAppendMessages.mockResolvedValueOnce({ appended: 2, firstSeq: 1, lastSeq: 2 });
      await session.updateConversation({ messages: msgs });
      expect(mockAppendMessages).toHaveBeenCalledTimes(1);

      // Second call: same messages, now stored
      mockGetMessages.mockResolvedValueOnce({
        messages: [
          { id: "m1", role: "user", content: "Hello", seq: 1 },
          { id: "m2", role: "assistant", content: "Hi there", seq: 2 },
        ],
        hasMore: false,
        maxSeq: 2,
      });
      await session.updateConversation({ messages: msgs });

      // appendMessages should NOT have been called again
      expect(mockAppendMessages).toHaveBeenCalledTimes(1);

      await ag.disconnect();
    });
  });
});
