import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ENDPOINT_ENV } from "@ratel-ai/telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ratelSignalFilter, ratelSpanProcessor, ratelTraceExporter } from "./processor.js";

// The filter reads only a span's name + attribute keys, so a minimal shape suffices.
const span = (name: string, attributes: Record<string, unknown> = {}): ReadableSpan =>
  ({ name, attributes }) as unknown as ReadableSpan;

describe("ratelSignalFilter", () => {
  it("forwards spans named ratel.*", () => {
    expect(ratelSignalFilter(span("ratel.search"))).toBe(true);
    expect(ratelSignalFilter(span("ratel.skill.load"))).toBe(true);
  });

  it("forwards spans carrying any gen_ai.* / ratel.* attribute (e.g. execute_tool)", () => {
    expect(
      ratelSignalFilter(span("execute_tool", { "gen_ai.operation.name": "execute_tool" })),
    ).toBe(true);
    expect(ratelSignalFilter(span("execute_tool", { "ratel.origin": "agent" }))).toBe(true);
    expect(ratelSignalFilter(span("chat gpt-4o", { "gen_ai.request.model": "gpt-4o" }))).toBe(true);
  });

  it("drops spans with neither a ratel.* name nor a gen_ai.*/ratel.* attribute", () => {
    expect(ratelSignalFilter(span("ai.generateText", { "ai.model.id": "gpt-4o" }))).toBe(false);
    expect(ratelSignalFilter(span("GET /health"))).toBe(false);
  });
});

describe("ratelTraceExporter", () => {
  it("builds an OTLP exporter at the resolved endpoint", () => {
    expect(ratelTraceExporter({ endpoint: "http://localhost:4318/v1/traces" })).toBeInstanceOf(
      OTLPTraceExporter,
    );
  });

  it("throws when there is no endpoint and no RATEL_URL", () => {
    const saved = process.env[ENDPOINT_ENV];
    delete process.env[ENDPOINT_ENV];
    try {
      expect(() => ratelTraceExporter({ apiKey: "k" })).toThrow(ENDPOINT_ENV);
    } finally {
      if (saved === undefined) delete process.env[ENDPOINT_ENV];
      else process.env[ENDPOINT_ENV] = saved;
    }
  });
});

describe("ratelSpanProcessor", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exposes the SpanProcessor interface", async () => {
    const proc = ratelSpanProcessor({ endpoint: "http://localhost:4318/v1/traces" });
    for (const method of ["onStart", "onEnd", "forceFlush", "shutdown"] as const) {
      expect(typeof proc[method]).toBe("function");
    }
    await proc.shutdown();
  });

  it("forwards only signal-bearing spans by default", async () => {
    const onEnd = vi.spyOn(BatchSpanProcessor.prototype, "onEnd").mockImplementation(() => {});
    const proc = ratelSpanProcessor({ endpoint: "http://localhost:4318/v1/traces" });
    proc.onEnd(span("ratel.search"));
    proc.onEnd(span("execute_tool", { "gen_ai.operation.name": "execute_tool" }));
    proc.onEnd(span("ai.generateText", { "ai.model.id": "gpt-4o" }));
    expect(onEnd).toHaveBeenCalledTimes(2);
    await proc.shutdown();
  });

  it("respects a custom spanFilter (() => true forwards everything)", async () => {
    const onEnd = vi.spyOn(BatchSpanProcessor.prototype, "onEnd").mockImplementation(() => {});
    const proc = ratelSpanProcessor({
      endpoint: "http://localhost:4318/v1/traces",
      spanFilter: () => true,
    });
    proc.onEnd(span("ai.generateText", { "ai.model.id": "gpt-4o" }));
    expect(onEnd).toHaveBeenCalledTimes(1);
    await proc.shutdown();
  });
});
