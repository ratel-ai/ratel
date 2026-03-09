import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreateInstance = vi.fn();
const mockHeartbeatInstance = vi.fn();
const mockDeleteInstance = vi.fn();

vi.mock("@agentified/sdk", () => ({
  ApiClient: vi.fn(() => ({
    createInstance: mockCreateInstance,
    heartbeatInstance: mockHeartbeatInstance,
    deleteInstance: mockDeleteInstance,
  })),
}));

import { Agentified } from "./agentified.js";

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

  describe("connect() without URL", () => {
    it("throws local spawn not implemented", async () => {
      const ag = new Agentified();
      await expect(ag.connect()).rejects.toThrow(/Local spawn not yet implemented/);
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
});
