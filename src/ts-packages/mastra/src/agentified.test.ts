import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const mockCreateInstance = vi.fn();
const mockHeartbeatInstance = vi.fn();
const mockDeleteInstance = vi.fn();
const mockRegister = vi.fn();

vi.mock("@agentified/sdk", () => ({
  ApiClient: vi.fn(() => ({
    createInstance: mockCreateInstance,
    heartbeatInstance: mockHeartbeatInstance,
    deleteInstance: mockDeleteInstance,
    register: mockRegister,
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
});
