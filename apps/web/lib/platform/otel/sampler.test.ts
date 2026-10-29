import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_CONTEXT, SpanKind, TraceFlags, trace } from "@opentelemetry/api";
import { SamplingDecision } from "@opentelemetry/sdk-trace-base";
import { createSelfTelemetrySampler } from "./sampler";

const TRACE_ID = "0123456789abcdef0123456789abcdef";

test("regular API root spans are sampled", () => {
  const result = createSelfTelemetrySampler().shouldSample(
    ROOT_CONTEXT,
    TRACE_ID,
    "GET /api/projects",
    SpanKind.SERVER,
    { "http.route": "/api/projects" },
    [],
  );

  assert.equal(result.decision, SamplingDecision.RECORD_AND_SAMPLED);
});

test("the configured ratio controls regular API root sampling", () => {
  const result = createSelfTelemetrySampler(0).shouldSample(
    ROOT_CONTEXT,
    TRACE_ID,
    "GET /api/projects",
    SpanKind.SERVER,
    { "http.route": "/api/projects" },
    [],
  );

  assert.equal(result.decision, SamplingDecision.NOT_RECORD);
});

test("health, proxy ingest, Next asset, and favicon roots are dropped", () => {
  const sampler = createSelfTelemetrySampler();
  const noiseSpans = [
    {
      name: "GET",
      attributes: { "http.target": "/api/health?ready=1" },
    },
    {
      name: "GET",
      attributes: { "url.path": "/ingest/e/" },
    },
    {
      name: "GET /_next/static/chunks/app.js",
      attributes: {},
    },
    {
      name: "GET /favicon.ico",
      attributes: { "http.target": "/favicon.ico?cache=1" },
    },
  ];

  for (const { name, attributes } of noiseSpans) {
    const result = sampler.shouldSample(
      ROOT_CONTEXT,
      TRACE_ID,
      name,
      SpanKind.SERVER,
      attributes,
      [],
    );
    assert.equal(result.decision, SamplingDecision.NOT_RECORD, name);
  }
});

test("product OTLP ingest routes remain sampled", () => {
  const sampler = createSelfTelemetrySampler();

  for (const route of ["/api/v1/traces", "/api/v1/logs"]) {
    const result = sampler.shouldSample(
      ROOT_CONTEXT,
      TRACE_ID,
      `POST ${route}`,
      SpanKind.SERVER,
      { "http.route": route },
      [],
    );
    assert.equal(result.decision, SamplingDecision.RECORD_AND_SAMPLED, route);
  }
});

test("child spans inherit sampled and unsampled parent decisions", () => {
  const sampler = createSelfTelemetrySampler();

  for (const [traceFlags, expected] of [
    [TraceFlags.SAMPLED, SamplingDecision.RECORD_AND_SAMPLED],
    [TraceFlags.NONE, SamplingDecision.NOT_RECORD],
  ] as const) {
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: TRACE_ID,
      spanId: "0123456789abcdef",
      traceFlags,
      isRemote: false,
    });
    const result = sampler.shouldSample(
      parent,
      TRACE_ID,
      "SELECT projects",
      SpanKind.CLIENT,
      {},
      [],
    );
    assert.equal(result.decision, expected);
  }
});

test("remote sampled parents still obey the configured ratio", () => {
  const remoteParent = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: "0123456789abcdef",
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
  const result = createSelfTelemetrySampler(0).shouldSample(
    remoteParent,
    TRACE_ID,
    "POST /api/v1/traces",
    SpanKind.SERVER,
    { "http.route": "/api/v1/traces" },
    [],
  );

  assert.equal(result.decision, SamplingDecision.NOT_RECORD);
});
