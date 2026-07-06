import { trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ENDPOINT_ENV } from "@ratel-ai/telemetry";
import { afterEach, describe, expect, it } from "vitest";
import { init } from "./init.js";

describe("init", () => {
  // init() registers a global provider; reset it so each case starts clean.
  afterEach(() => {
    trace.disable();
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
});
