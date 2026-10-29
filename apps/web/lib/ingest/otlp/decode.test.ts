import assert from "node:assert/strict";
import { test } from "node:test";
import protobuf from "protobufjs";
import { decodeJson, decodeOtlp, decodeProtobuf, OtlpDecodeError } from "./decode";
import descriptor from "./proto/otlp-trace.descriptor.json";
import type { AttrValue } from "./types";

/**
 * Decode-layer contract: protobuf and OTLP/JSON of the same logical export must
 * normalize to identical `DecodedSpan`s (hex ids, epoch-ms times, JS attribute
 * maps). A final case serializes REAL spans through `@opentelemetry/otlp-transformer`
 * (the same encoder the shipped exporter uses) to guard against proto field drift.
 */

const root = protobuf.Root.fromJSON(descriptor as protobuf.INamespace);
const RequestType = root.lookupType("ratel.otlp.ExportTraceServiceRequest");

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const ANCHOR_SPAN_ID = "1111111111111111";
const TOOL_SPAN_ID = "2222222222222222";
const START_NS = "1751800000000000000"; // 2025-07-06T…, well within plausible bounds
const END_NS = "1751800000450000000"; // +450ms

/** Build one OTLP `AnyValue` (plain object, camelCase) from a JS value. */
function anyValue(v: AttrValue): Record<string, unknown> {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } };
  if (v && typeof v === "object") {
    return { kvlistValue: { values: kvs(v as Record<string, AttrValue>) } };
  }
  return {};
}

function kvs(map: Record<string, AttrValue>): Array<Record<string, unknown>> {
  return Object.entries(map).map(([key, value]) => ({ key, value: anyValue(value) }));
}

/** Shared logical export; `idBytes` toggles Buffer ids (protobuf) vs hex strings (JSON). */
function buildRequest(idBytes: boolean): Record<string, unknown> {
  const id = (hex: string) => (idBytes ? Buffer.from(hex, "hex") : hex);
  const anchorAttrs: Record<string, AttrValue> = {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": "openai",
    "gen_ai.request.model": "gpt-5.5",
    "gen_ai.response.model": "gpt-5.5-2026",
    "gen_ai.usage.input_tokens": 1200,
    "gen_ai.usage.output_tokens": 340,
    "gen_ai.usage.cache_read.input_tokens": 800,
    "gen_ai.usage.reasoning.output_tokens": 64,
    "gen_ai.response.finish_reasons": ["stop"],
    "gen_ai.request.stream": true,
  };
  const detailsAttrs: Record<string, AttrValue> = {
    "gen_ai.system_instructions": [{ type: "text", content: "You are helpful." }],
    "gen_ai.input.messages": [{ role: "user", parts: [{ type: "text", content: "hi" }] }],
  };
  const toolAttrs: Record<string, AttrValue> = {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "search_docs",
    "ratel.origin": "agent",
  };

  return {
    resourceSpans: [
      {
        resource: { attributes: kvs({ "service.name": "my-agent" }) },
        scopeSpans: [
          {
            scope: { name: "ratel" },
            spans: [
              {
                traceId: id(TRACE_ID),
                spanId: id(ANCHOR_SPAN_ID),
                name: "chat gpt-5.5",
                kind: 3,
                startTimeUnixNano: START_NS,
                endTimeUnixNano: END_NS,
                attributes: kvs(anchorAttrs),
                events: [
                  {
                    name: "gen_ai.client.inference.operation.details",
                    timeUnixNano: START_NS,
                    attributes: kvs(detailsAttrs),
                  },
                ],
                status: { code: 1 },
              },
              {
                traceId: id(TRACE_ID),
                spanId: id(TOOL_SPAN_ID),
                parentSpanId: id(ANCHOR_SPAN_ID),
                name: "execute_tool",
                kind: 3,
                startTimeUnixNano: START_NS,
                endTimeUnixNano: END_NS,
                attributes: kvs(toolAttrs),
              },
            ],
          },
        ],
      },
    ],
  };
}

function jsonBytes(): Uint8Array {
  return Buffer.from(JSON.stringify(buildRequest(false)), "utf8");
}

function protoBytes(): Uint8Array {
  const obj = buildRequest(true);
  return RequestType.encode(RequestType.fromObject(obj)).finish();
}

test("OTLP/JSON decodes anchor span with hex ids, ms times, typed attrs", () => {
  const spans = decodeJson(jsonBytes());
  assert.equal(spans.length, 2);
  const anchor = spans.find((s) => s.name === "chat gpt-5.5");
  assert.ok(anchor);
  assert.equal(anchor.traceId, TRACE_ID);
  assert.equal(anchor.spanId, ANCHOR_SPAN_ID);
  assert.equal(anchor.parentSpanId, null);
  assert.equal(anchor.kind, 3);
  assert.equal(anchor.startUnixMs, 1751800000000);
  assert.equal(anchor.endUnixMs, 1751800000450);
  assert.equal(anchor.attributes["gen_ai.usage.input_tokens"], 1200);
  assert.equal(anchor.attributes["gen_ai.provider.name"], "openai");
  assert.deepEqual(anchor.attributes["gen_ai.response.finish_reasons"], ["stop"]);
  assert.equal(anchor.attributes["gen_ai.request.stream"], true);
  assert.equal(anchor.resourceAttributes["service.name"], "my-agent");
  assert.equal(anchor.scopeName, "ratel");
  assert.equal(anchor.events.length, 1);
  assert.equal(anchor.events[0].name, "gen_ai.client.inference.operation.details");
});

test("tool span keeps its parent linkage", () => {
  const spans = decodeJson(jsonBytes());
  const tool = spans.find((s) => s.name === "execute_tool");
  assert.ok(tool);
  assert.equal(tool.parentSpanId, ANCHOR_SPAN_ID);
  assert.equal(tool.attributes["gen_ai.tool.name"], "search_docs");
});

test("protobuf and OTLP/JSON decode to identical DecodedSpans", () => {
  assert.deepEqual(decodeProtobuf(protoBytes()), decodeJson(jsonBytes()));
});

test("decodeOtlp dispatches on content-type", () => {
  assert.equal(decodeOtlp("application/json", jsonBytes()).length, 2);
  assert.equal(decodeOtlp("application/x-protobuf", protoBytes()).length, 2);
  // Unknown type falls back to protobuf (the SDK default).
  assert.equal(decodeOtlp("", protoBytes()).length, 2);
});

test("nested structured attribute survives as JS", () => {
  const [, ...rest] = decodeJson(jsonBytes());
  void rest;
  const anchor = decodeJson(jsonBytes()).find((s) => s.name === "chat gpt-5.5")!;
  const messages = anchor.events[0].attributes["gen_ai.input.messages"];
  assert.deepEqual(messages, [{ role: "user", parts: [{ type: "text", content: "hi" }] }]);
});

test("malformed JSON → OtlpDecodeError", () => {
  assert.throws(() => decodeJson(Buffer.from("{not json", "utf8")), OtlpDecodeError);
});

test("garbage protobuf → OtlpDecodeError or empty (never throws TypeError)", () => {
  // Random bytes may decode to an empty/garbage message or fail cleanly; either way
  // it must be an OtlpDecodeError path, not an unhandled crash.
  try {
    const spans = decodeProtobuf(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    assert.ok(Array.isArray(spans));
  } catch (err) {
    assert.ok(err instanceof OtlpDecodeError);
  }
});

test("real emitter protobuf (otlp-transformer) decodes with correct gen_ai attrs", async () => {
  const { ProtobufTraceSerializer } = await import("@opentelemetry/otlp-transformer");
  const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import(
    "@opentelemetry/sdk-trace-base"
  );

  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("ratel-test");

  const span = tracer.startSpan("chat gpt-5.5");
  span.setAttribute("gen_ai.operation.name", "chat");
  span.setAttribute("gen_ai.provider.name", "anthropic");
  span.setAttribute("gen_ai.request.model", "claude-opus-4-8");
  span.setAttribute("gen_ai.usage.input_tokens", 500);
  span.setAttribute("gen_ai.usage.output_tokens", 120);
  span.addEvent("gen_ai.client.inference.operation.details");
  span.end();

  const finished = exporter.getFinishedSpans();
  assert.equal(finished.length, 1);

  const bytes = ProtobufTraceSerializer.serializeRequest(finished);
  assert.ok(bytes);
  const spans = decodeProtobuf(bytes as Uint8Array);
  assert.equal(spans.length, 1);
  const anchor = spans[0];
  assert.equal(anchor.name, "chat gpt-5.5");
  assert.equal(anchor.attributes["gen_ai.provider.name"], "anthropic");
  assert.equal(anchor.attributes["gen_ai.request.model"], "claude-opus-4-8");
  assert.equal(anchor.attributes["gen_ai.usage.input_tokens"], 500);
  assert.equal(anchor.attributes["gen_ai.usage.output_tokens"], 120);
  assert.equal(anchor.traceId.length, 32);
  assert.equal(anchor.spanId.length, 16);
  assert.equal(anchor.events[0].name, "gen_ai.client.inference.operation.details");

  await provider.shutdown();
});
