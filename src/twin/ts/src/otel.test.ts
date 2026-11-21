import net from "node:net";
import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configHash } from "./hash.js";
import {
  RATEL_TWIN_CONFIG_HASH,
  RATEL_TWIN_ID,
  RATEL_TWIN_INPUT,
  resolveLocal,
  stampTwinInput,
} from "./index.js";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => provider.register());
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

const defaults = { model: "anthropic/claude-sonnet-5-5", system: "S", maxTokens: 400 };

function inSpan<T>(fn: () => T): { result: T; attributes: Record<string, unknown> } {
  exporter.reset();
  const result = trace.getTracer("t").startActiveSpan("invoke_agent label_workflows", (span) => {
    const r = fn();
    span.end();
    return r;
  });
  return { result, attributes: { ...exporter.getFinishedSpans()[0]?.attributes } };
}

describe("resolveLocal", () => {
  it("returns the defaults object itself", () => {
    expect(resolveLocal(defaults, { twin: "workflow-label" })).toBe(defaults);
  });

  it("stamps the twin id and the config hash on the active span", () => {
    const { attributes } = inSpan(() => resolveLocal(defaults, { twin: "workflow-label" }));
    expect(attributes[RATEL_TWIN_ID]).toBe("workflow-label");
    expect(attributes[RATEL_TWIN_CONFIG_HASH]).toBe(configHash(defaults));
  });

  it("is a no-op without an active span", () => {
    expect(() => resolveLocal(defaults, { twin: "workflow-label" })).not.toThrow();
  });

  it("does no network I/O", () => {
    const connect = vi.spyOn(net.Socket.prototype, "connect");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    inSpan(() => resolveLocal({ ...defaults }, { twin: "workflow-label" }));
    expect(connect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    connect.mockRestore();
    fetchSpy.mockRestore();
  });
});

describe("stampTwinInput", () => {
  it("stamps the input JSON on the active span", () => {
    const { attributes } = inSpan(() => stampTwinInput({ workflowId: "wf" }));
    expect(attributes[RATEL_TWIN_INPUT]).toBe('{"workflowId":"wf"}');
  });

  it("caps the stamped JSON at maxChars", () => {
    const { attributes } = inSpan(() =>
      stampTwinInput({ text: "x".repeat(100) }, { maxChars: 20 }),
    );
    expect(attributes[RATEL_TWIN_INPUT]).toHaveLength(20);
  });
});
