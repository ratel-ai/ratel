import { describe, expect, it } from "vitest";
import {
  ContentCapture,
  contentCaptureMode,
  DEFAULT_SERVICE_NAME,
  ENDPOINT_ENV,
  init,
  resolveOtlpConfig,
} from "./init.js";

describe("resolveOtlpConfig", () => {
  it("uses the apiKey form: endpoint from RATEL_URL, Bearer auth, default service name", () => {
    const cfg = resolveOtlpConfig(
      { apiKey: "secret" },
      { [ENDPOINT_ENV]: "https://collector.ratel.sh/v1/traces" },
    );
    expect(cfg.url).toBe("https://collector.ratel.sh/v1/traces");
    expect(cfg.headers.Authorization).toBe("Bearer secret");
    expect(cfg.serviceName).toBe(DEFAULT_SERVICE_NAME);
  });

  it("uses the endpoint+headers form verbatim, with no Authorization when no apiKey", () => {
    const cfg = resolveOtlpConfig(
      {
        endpoint: "http://localhost:4318/v1/traces",
        headers: { "x-custom": "1" },
      },
      {},
    );
    expect(cfg.url).toBe("http://localhost:4318/v1/traces");
    expect(cfg.headers).toEqual({ "x-custom": "1" });
    expect(cfg.headers.Authorization).toBeUndefined();
  });

  it("prefers an explicit endpoint over RATEL_URL", () => {
    const cfg = resolveOtlpConfig(
      { endpoint: "https://explicit/v1/traces", apiKey: "k" },
      { [ENDPOINT_ENV]: "https://env/v1/traces" },
    );
    expect(cfg.url).toBe("https://explicit/v1/traces");
    expect(cfg.headers.Authorization).toBe("Bearer k");
  });

  it("respects a custom service name", () => {
    const cfg = resolveOtlpConfig({ endpoint: "https://x/v1/traces", serviceName: "my-agent" }, {});
    expect(cfg.serviceName).toBe("my-agent");
  });

  it("throws when no endpoint and no RATEL_URL", () => {
    expect(() => resolveOtlpConfig({ apiKey: "k" }, {})).toThrow(ENDPOINT_ENV);
  });
});

describe("contentCaptureMode", () => {
  it("defaults to NO_CONTENT when unset or empty", () => {
    expect(contentCaptureMode({})).toBe(ContentCapture.NoContent);
    expect(contentCaptureMode({ OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "" })).toBe(
      ContentCapture.NoContent,
    );
  });

  it("parses each enum value, case-insensitively", () => {
    const env = (v: string) => ({
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: v,
    });
    expect(contentCaptureMode(env("NO_CONTENT"))).toBe(ContentCapture.NoContent);
    expect(contentCaptureMode(env("span_only"))).toBe(ContentCapture.SpanOnly);
    expect(contentCaptureMode(env("Event_Only"))).toBe(ContentCapture.EventOnly);
    expect(contentCaptureMode(env("SPAN_AND_EVENT"))).toBe(ContentCapture.SpanAndEvent);
  });

  it("maps the legacy boolean form (true -> full capture, false -> none)", () => {
    const env = (v: string) => ({
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: v,
    });
    expect(contentCaptureMode(env("true"))).toBe(ContentCapture.SpanAndEvent);
    expect(contentCaptureMode(env("false"))).toBe(ContentCapture.NoContent);
  });
});

describe("init", () => {
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
});
