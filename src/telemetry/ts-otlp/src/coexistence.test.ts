/**
 * Coexistence proof for the TS Telemetry DX northstar (RS-43): Ratel telemetry sharing an
 * OpenTelemetry pipeline with Langfuse and the AI SDK 7 `@ai-sdk/otel` integration, using the
 * real vendor packages and in-memory export capture (no network). Mirrors appendix examples
 * 1, 3, 5, and 6 of the plan doc (15Pxf82c).
 *
 * Two composition modes are covered:
 *  - guest mode — a host `NodeTracerProvider` owns the pipeline; `ratelSpanProcessor` and
 *    `LangfuseSpanProcessor` are peer processors on it (examples 3, 5).
 *  - owner mode — `startTelemetry` owns the pipeline and AI SDK 7's `registerTelemetry(new
 *    OpenTelemetry())` emits `gen_ai.*` spans onto it, alongside a composed
 *    `LangfuseSpanProcessor` (examples 1, 6).
 *
 * Each backend is observed at its own OTLP exporter's `export` boundary — Ratel exports over
 * `@opentelemetry/exporter-trace-otlp-proto`, Langfuse over `-http`, so the two never collide.
 */

import { OpenTelemetry } from "@ai-sdk/otel";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { type Tracer, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { generateText, registerTelemetry } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startTelemetry } from "./init.js";
import { ratelSignalFilter, ratelSpanProcessor } from "./processor.js";

const ENDPOINT = "http://localhost:4318/v1/traces";
type Predicate = (arg: { otelSpan: { name: string } }) => boolean;
const ACCEPT_ALL: Predicate = () => true;
const RATEL_ONLY: Predicate = ({ otelSpan }) => otelSpan.name.startsWith("ratel.");

/** Capture the span names Ratel's OTLP-proto exporter would ship, network-free. */
function captureRatel(into: string[]): void {
  vi.spyOn(OTLPTraceExporter.prototype, "export").mockImplementation((spans, resultCallback) => {
    into.push(...spans.map((span) => span.name));
    resultCallback({ code: 0 });
  });
}

/** Build a `LangfuseSpanProcessor` whose internal OTLP-http exporter is captured, network-free. */
function langfuseCapturing(into: string[], shouldExportSpan: Predicate): LangfuseSpanProcessor {
  const processor = new LangfuseSpanProcessor({
    publicKey: "pk",
    secretKey: "sk",
    baseUrl: "http://127.0.0.1:1",
    shouldExportSpan,
  });
  const exporter = (processor as unknown as { processor: { _exporter: SpanExporter } }).processor
    ._exporter;
  vi.spyOn(exporter, "export").mockImplementation((spans, resultCallback) => {
    into.push(...spans.map((span) => span.name));
    resultCallback({ code: 0 });
  });
  return processor;
}

/** The northstar's mixed span stream: a Ratel span, a gen_ai span, AI SDK wrapper noise, and unrelated. */
function emitFixtureSpans(tracer: Tracer): void {
  tracer.startSpan("ratel.search").end();
  tracer.startSpan("chat gpt-4o", { attributes: { "gen_ai.request.model": "gpt-4o" } }).end();
  tracer.startSpan("ai.generateText", { attributes: { "ai.model.id": "gpt-4o" } }).end();
  tracer.startSpan("GET /health").end();
}

const mockModel = () =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      content: [{ type: "text", text: "hi" }],
      warnings: [],
    }),
  });

const sorted = (names: string[]): string[] => [...names].sort();

describe("telemetry coexistence", () => {
  afterEach(() => {
    trace.disable();
    logs.disable();
    vi.restoreAllMocks();
  });

  // Example 5: a partner already owns the provider; Ratel joins as a peer span-processor with
  // its default signal filter, Langfuse keeps everything. One shared stream, independent
  // per-destination export sets.
  describe("guest mode: host provider + LangfuseSpanProcessor + ratelSpanProcessor", () => {
    it("fans every span to both processors while each exports its own filtered set", async () => {
      const ratelNames: string[] = [];
      const langfuseNames: string[] = [];
      captureRatel(ratelNames);
      const host = new NodeTracerProvider({
        spanProcessors: [
          langfuseCapturing(langfuseNames, ACCEPT_ALL),
          ratelSpanProcessor({ endpoint: ENDPOINT, apiKey: "k" }),
        ],
      });

      emitFixtureSpans(host.getTracer("test"));
      await host.forceFlush();
      await host.shutdown();

      // Ratel's default ratelSignalFilter forwards only ratel.*/gen_ai.* — ai.* noise and
      // the unrelated span are dropped.
      expect(sorted(ratelNames)).toEqual(["chat gpt-4o", "ratel.search"]);
      // Langfuse, told to accept all, receives the full shared stream — proving both
      // processors saw every span and filtered independently.
      expect(sorted(langfuseNames)).toEqual([
        "GET /health",
        "ai.generateText",
        "chat gpt-4o",
        "ratel.search",
      ]);
    });
  });

  // Example 6: no foreign provider, so startTelemetry owns it; AI SDK 7's registerTelemetry
  // integration emits onto that same provider, and a composed LangfuseSpanProcessor rides along.
  // The @ai-sdk/otel OpenTelemetry integration memoizes its tracer on first use, so this mode
  // is proven with a single generateText cycle.
  describe("owner mode: startTelemetry + AI SDK 7 registerTelemetry(new OpenTelemetry())", () => {
    beforeAll(() => {
      // Global emit-side integration; register once so operations emit a single span set.
      registerTelemetry(new OpenTelemetry());
    });

    it("routes AI SDK 7 gen_ai spans and Ratel's own spans to both destinations", async () => {
      const ratelNames: string[] = [];
      const langfuseNames: string[] = [];
      captureRatel(ratelNames);
      const handle = startTelemetry({
        serviceName: "my-agent",
        endpoint: ENDPOINT,
        apiKey: "k",
        spanFilter: ratelSignalFilter,
        spanProcessors: [langfuseCapturing(langfuseNames, ACCEPT_ALL)],
      });

      // A ratel.* span rides the same owned provider automatically (no wiring on ratel())...
      trace.getTracer("ratel").startSpan("ratel.search").end();
      // ...alongside AI SDK 7's gen_ai.* spans, emitted via the registered integration.
      await generateText({
        model: mockModel(),
        prompt: "hello",
        experimental_telemetry: { isEnabled: true },
      });
      await handle.forceFlush();
      await handle.shutdown();

      // The integration emitted chat/step/invoke_agent onto startTelemetry's owned provider.
      // Those spans are gen_ai.*-tagged, so ratelSignalFilter keeps every one — the "drops ai.*
      // wrapper noise" caveat applies to the legacy experimental_telemetry path, not @ai-sdk/otel.
      expect(ratelNames).toContain("chat mock-model-id");
      expect(ratelNames).toContain("ratel.search");
      expect(ratelNames.every((name) => !name.startsWith("ai."))).toBe(true);
      // Both destinations saw the same shared stream (Langfuse accepts all; Ratel keeps the signal,
      // which here is everything because AI SDK 7 emits gen_ai.* rather than ai.* spans).
      expect(sorted(ratelNames)).toEqual(sorted(langfuseNames));
    });
  });

  // Example 3 (second block): the source can't be silenced, so each destination filters to
  // ratel.* independently — Ratel via spanFilter, Langfuse via shouldExportSpan.
  describe("per-destination filtering: only ratel.* spans reach both backends", () => {
    it("drops non-ratel spans on both the Ratel and Langfuse sides", async () => {
      const ratelNames: string[] = [];
      const langfuseNames: string[] = [];
      captureRatel(ratelNames);
      const handle = startTelemetry({
        serviceName: "my-agent",
        endpoint: ENDPOINT,
        apiKey: "k",
        spanFilter: (span) => span.name.startsWith("ratel."),
        spanProcessors: [langfuseCapturing(langfuseNames, RATEL_ONLY)],
      });

      emitFixtureSpans(trace.getTracer("test"));
      await handle.forceFlush();
      await handle.shutdown();

      expect(sorted(ratelNames)).toEqual(["ratel.search"]);
      expect(sorted(langfuseNames)).toEqual(["ratel.search"]);
    });
  });
});
