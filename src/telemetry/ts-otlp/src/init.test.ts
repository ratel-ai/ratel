import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
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
    logs.disable();
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

  it("registers an OTLP Logs provider for EventRecords", async () => {
    const onEmit = vi
      .spyOn(BatchLogRecordProcessor.prototype, "onEmit")
      .mockImplementation(() => {});
    const handle = init({
      endpoint: "http://localhost:4318/v1/traces",
      serviceName: "test",
    });

    logs.getLogger("test").emit({ eventName: "ratel.search.results" });

    expect(onEmit).toHaveBeenCalledTimes(1);
    await handle.shutdown();
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

  it("does not report success when its paired LoggerProvider is no longer active", async () => {
    const handle = init({ endpoint: "http://localhost:4318/v1/traces" });
    logs.disable();
    try {
      expect(() => init()).toThrow(/LoggerProvider/);
      expect(() => init({ enabled: false })).toThrow(/LoggerProvider/);
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

  it("re-initializes after both global providers are disabled", async () => {
    const first = init({ endpoint: "http://localhost:4318/v1/traces" });
    await first.shutdown().catch(() => {});
    trace.disable();
    logs.disable();
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

  it("rejects a foreign LoggerProvider before registering a tracer provider", async () => {
    const existing = new LoggerProvider();
    logs.setGlobalLoggerProvider(existing);
    const register = vi.spyOn(NodeTracerProvider.prototype, "register");
    try {
      expect(() => init({ endpoint: "http://localhost:4318/v1/traces" })).toThrow(
        /ratelLogRecordProcessor/,
      );
      expect(register).not.toHaveBeenCalled();
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

describe("startTelemetry compatibility", () => {
  afterEach(() => {
    trace.disable();
    logs.disable();
    vi.restoreAllMocks();
  });

  it("keeps init as an alias with forceFlush and shutdown", async () => {
    expect(init).toBe(startTelemetry);
    const handle = init({ endpoint: "http://localhost:4318/v1/traces" });
    try {
      expect(typeof handle.forceFlush).toBe("function");
      expect(typeof handle.shutdown).toBe("function");
      await expect(handle.forceFlush()).resolves.toBeUndefined();
    } finally {
      await handle.shutdown().catch(() => {});
    }
  });

  it("composes host span and log processors on the owned providers", async () => {
    vi.spyOn(BatchSpanProcessor.prototype, "onEnd").mockImplementation(() => {});
    vi.spyOn(BatchLogRecordProcessor.prototype, "onEmit").mockImplementation(() => {});
    const hostSpanOnEnd = vi.fn();
    const hostLogOnEmit = vi.fn();
    const hostSpanProcessor: SpanProcessor = {
      onStart: () => {},
      onEnd: hostSpanOnEnd,
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    const hostLogProcessor: LogRecordProcessor = {
      enabled: () => true,
      onEmit: hostLogOnEmit,
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    const handle = startTelemetry({
      endpoint: "http://localhost:4318/v1/traces",
      spanProcessors: [hostSpanProcessor],
      logRecordProcessors: [hostLogProcessor],
    });
    try {
      trace.getTracer("test").startSpan("ratel.search").end();
      logs.getLogger("test").emit({ eventName: "ratel.search.results" });

      expect(hostSpanOnEnd).toHaveBeenCalledTimes(1);
      expect((hostSpanOnEnd.mock.calls[0]?.[0] as ReadableSpan).name).toBe("ratel.search");
      expect(hostLogOnEmit).toHaveBeenCalledTimes(1);
      expect(hostLogOnEmit.mock.calls[0]?.[0].eventName).toBe("ratel.search.results");
    } finally {
      await handle.shutdown().catch(() => {});
    }
  });

  it("force-flushes every owned-provider processor", async () => {
    const hostSpanForceFlush = vi.fn(async () => {});
    const hostLogForceFlush = vi.fn(async () => {});
    const hostSpanProcessor: SpanProcessor = {
      onStart: () => {},
      onEnd: () => {},
      forceFlush: hostSpanForceFlush,
      shutdown: async () => {},
    };
    const hostLogProcessor: LogRecordProcessor = {
      enabled: () => true,
      onEmit: () => {},
      forceFlush: hostLogForceFlush,
      shutdown: async () => {},
    };
    const handle = startTelemetry({
      endpoint: "http://localhost:4318/v1/traces",
      spanProcessors: [hostSpanProcessor],
      logRecordProcessors: [hostLogProcessor],
    });
    try {
      await handle.forceFlush();

      expect(hostSpanForceFlush).toHaveBeenCalledTimes(1);
      expect(hostLogForceFlush).toHaveBeenCalledTimes(1);
    } finally {
      await handle.shutdown().catch(() => {});
    }
  });
});
