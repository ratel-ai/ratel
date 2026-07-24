import { trace } from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLP_ENDPOINT_ENV } from "@ratel-ai/telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { init, startTelemetry } from "./init.js";

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
    const saved = process.env[OTLP_ENDPOINT_ENV];
    delete process.env[OTLP_ENDPOINT_ENV];
    const existing = new NodeTracerProvider();
    existing.register();
    const activeBefore = trace.getTracerProvider();
    try {
      const handle = init({ enabled: false });

      expect(trace.getTracerProvider()).toBe(activeBefore);
      await expect(handle.shutdown()).resolves.toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env[OTLP_ENDPOINT_ENV];
      else process.env[OTLP_ENDPOINT_ENV] = saved;
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
    // Assert it forwarded the accepted span, not merely "exactly one span" — an inverted
    // predicate would also forward exactly one (the rejected one) and pass on count alone.
    expect((onEnd.mock.calls[0]?.[0] as ReadableSpan).name).toBe("ratel.search");
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

  it("throws on init() after shutdown instead of returning the dead handle", async () => {
    const handle = init({ endpoint: "http://localhost:4318/v1/traces" });
    await handle.shutdown().catch(() => {});
    // The provider stays the registered global after shutdown; re-init must fail loud rather
    // than hand back a handle whose exporter is dead (spans would silently drop).
    expect(() => init({ endpoint: "http://localhost:4318/v1/traces" })).toThrow(
      /already shut down/,
    );
    expect(() => init({ enabled: false })).toThrow(/already shut down/);
  });

  it("re-initializes with a fresh handle after trace.disable() clears the global", async () => {
    const first = init({ endpoint: "http://localhost:4318/v1/traces" });
    await first.shutdown().catch(() => {});
    trace.disable(); // the documented escape hatch to re-init in the same process
    const second = init({ endpoint: "http://localhost:4318/v1/traces" });
    try {
      expect(second).not.toBe(first);
    } finally {
      await second.shutdown().catch(() => {});
    }
  });

  it("throws on misconfiguration (no endpoint, no RATEL_OTLP_ENDPOINT)", () => {
    const saved = process.env[OTLP_ENDPOINT_ENV];
    delete process.env[OTLP_ENDPOINT_ENV];
    try {
      expect(() => init({ apiKey: "k" })).toThrow(OTLP_ENDPOINT_ENV);
    } finally {
      if (saved === undefined) {
        delete process.env[OTLP_ENDPOINT_ENV];
      } else {
        process.env[OTLP_ENDPOINT_ENV] = saved;
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
    const saved = process.env[OTLP_ENDPOINT_ENV];
    delete process.env[OTLP_ENDPOINT_ENV];
    const existing = new NodeTracerProvider();
    existing.register();
    try {
      expect(() => init()).toThrow(/ratelSpanProcessor/);
    } finally {
      if (saved === undefined) delete process.env[OTLP_ENDPOINT_ENV];
      else process.env[OTLP_ENDPOINT_ENV] = saved;
      await existing.shutdown();
    }
  });
});

describe("startTelemetry", () => {
  // startTelemetry registers a global provider; reset it so each case starts clean.
  afterEach(() => {
    trace.disable();
    vi.restoreAllMocks();
  });

  it("returns a handle exposing forceFlush and shutdown", async () => {
    const handle = startTelemetry({ endpoint: "http://localhost:4318/v1/traces" });
    try {
      expect(typeof handle.forceFlush).toBe("function");
      expect(typeof handle.shutdown).toBe("function");
      await expect(handle.forceFlush()).resolves.toBeUndefined();
    } finally {
      await handle.shutdown().catch(() => {});
    }
  });

  it("keeps init working as a back-compat alias carrying the new handle shape", async () => {
    const handle = init({ endpoint: "http://localhost:4318/v1/traces" });
    try {
      expect(typeof handle.forceFlush).toBe("function");
      expect(typeof handle.shutdown).toBe("function");
    } finally {
      await handle.shutdown().catch(() => {});
    }
  });

  it("fans finished spans out to host spanProcessors on the Ratel-owned provider", async () => {
    // Neutralize the Ratel BatchSpanProcessor's real export path (no network in unit tests);
    // the host processor below is a plain object, so its onEnd stays observable.
    vi.spyOn(BatchSpanProcessor.prototype, "onEnd").mockImplementation(() => {});
    const hostOnEnd = vi.fn();
    const host: SpanProcessor = {
      onStart: () => {},
      onEnd: hostOnEnd,
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    const handle = startTelemetry({
      endpoint: "http://localhost:4318/v1/traces",
      spanProcessors: [host],
    });
    try {
      trace.getTracer("test").startSpan("ratel.search").end();

      // The host processor is a first-class entry on the same provider, so it sees the
      // provider's whole span stream — independent of the Ratel processor's own filter.
      expect(hostOnEnd).toHaveBeenCalledTimes(1);
      expect((hostOnEnd.mock.calls[0]?.[0] as ReadableSpan).name).toBe("ratel.search");
    } finally {
      await handle.shutdown().catch(() => {});
    }
  });

  it("flushes every registered processor when the handle is force-flushed", async () => {
    const hostForceFlush = vi.fn(async () => {});
    const host: SpanProcessor = {
      onStart: () => {},
      onEnd: () => {},
      forceFlush: hostForceFlush,
      shutdown: async () => {},
    };
    const handle = startTelemetry({
      endpoint: "http://localhost:4318/v1/traces",
      spanProcessors: [host],
    });
    try {
      await handle.forceFlush();

      expect(hostForceFlush).toHaveBeenCalledTimes(1);
    } finally {
      await handle.shutdown().catch(() => {});
    }
  });
});
