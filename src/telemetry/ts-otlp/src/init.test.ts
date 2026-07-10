import { trace } from "@opentelemetry/api";
import { BatchSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ENDPOINT_ENV } from "@ratel-ai/telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { init } from "./init.js";

describe("init", () => {
  // init() registers a global provider; reset it so each case starts clean.
  afterEach(() => {
    trace.disable();
    vi.restoreAllMocks();
  });

  it("returns a handle with a shutdown function", async () => {
    const handle = init({
      apiKey: "k",
      endpoint: "http://localhost:4318/v1/traces",
      serviceName: "test",
    });
    expect(typeof handle.shutdown).toBe("function");
    // Best-effort cleanup: the export target is absent in unit tests, so the
    // handle shape (not shutdown's network resolution) is the contract asserted.
    await handle.shutdown().catch(() => {});
  });

  it("returns a no-op handle without endpoint or provider side effects when disabled", async () => {
    const saved = process.env[ENDPOINT_ENV];
    delete process.env[ENDPOINT_ENV];
    const existing = new NodeTracerProvider();
    existing.register();
    const activeBefore = trace.getTracerProvider();
    try {
      const handle = init({ enabled: false });

      expect(trace.getTracerProvider()).toBe(activeBefore);
      await expect(handle.shutdown()).resolves.toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env[ENDPOINT_ENV];
      else process.env[ENDPOINT_ENV] = saved;
      await existing.shutdown();
    }
  });

  it("forwards only spans accepted by its spanFilter", async () => {
    const onEnd = vi.spyOn(BatchSpanProcessor.prototype, "onEnd").mockImplementation(() => {});
    const handle = init({
      endpoint: "http://localhost:4318/v1/traces",
      spanFilter: (span: ReadableSpan) => span.name.startsWith("ratel."),
    });

    trace.getTracer("test").startSpan("ratel.search").end();
    trace.getTracer("test").startSpan("GET /health").end();

    expect(onEnd).toHaveBeenCalledTimes(1);
    await handle.shutdown();
  });

  it("returns the same handle when its own provider is already active", async () => {
    const handle = init({ endpoint: "http://localhost:4318/v1/traces" });
    try {
      expect(init()).toBe(handle);
      expect(init({ enabled: false })).toBe(handle);
    } finally {
      await handle.shutdown().catch(() => {});
    }
  });

  it("recognizes its provider after the init module is re-evaluated", async () => {
    const handle = init({ endpoint: "http://localhost:4318/v1/traces" });
    try {
      vi.resetModules();
      const reloaded = await import("./init.js");

      expect(reloaded.init()).toBe(handle);
    } finally {
      await handle.shutdown().catch(() => {});
    }
  });

  it("throws on misconfiguration (no endpoint, no RATEL_URL)", () => {
    const saved = process.env[ENDPOINT_ENV];
    delete process.env[ENDPOINT_ENV];
    try {
      expect(() => init({ apiKey: "k" })).toThrow(ENDPOINT_ENV);
    } finally {
      if (saved === undefined) {
        delete process.env[ENDPOINT_ENV];
      } else {
        process.env[ENDPOINT_ENV] = saved;
      }
    }
  });

  it("throws — pointing at ratelSpanProcessor — when a provider is already registered", async () => {
    const existing = new NodeTracerProvider();
    existing.register();
    try {
      expect(() => init({ apiKey: "k", endpoint: "http://localhost:4318/v1/traces" })).toThrow(
        /ratelSpanProcessor/,
      );
    } finally {
      await existing.shutdown();
    }
  });

  it("reports a foreign provider before validating endpoint configuration", async () => {
    const saved = process.env[ENDPOINT_ENV];
    delete process.env[ENDPOINT_ENV];
    const existing = new NodeTracerProvider();
    existing.register();
    try {
      expect(() => init()).toThrow(/ratelSpanProcessor/);
    } finally {
      if (saved === undefined) delete process.env[ENDPOINT_ENV];
      else process.env[ENDPOINT_ENV] = saved;
      await existing.shutdown();
    }
  });
});
