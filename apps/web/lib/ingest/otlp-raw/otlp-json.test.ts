import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeOtlpRequest } from "@/lib/ingest/otlp/decode";
import { traceOtlpJson } from "./otlp-json";
import { REDACTED } from "./redact";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const OTHER_TRACE = "11111111111111111111111111111111";

/** One export as an exporter sends it: every field the decoded spans drop. */
const EXPORT = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "agent" } }] },
      schemaUrl: "https://opentelemetry.io/schemas/1.26.0",
      scopeSpans: [
        {
          scope: { name: "scope-a", version: "1.2.3" },
          spans: [
            {
              traceId: TRACE_ID,
              spanId: "00f067aa0ba902b7",
              traceState: "vendor=1",
              name: "chat gpt-4o",
              kind: 3,
              startTimeUnixNano: "1700000000123456789",
              endTimeUnixNano: "1700000000456789012",
              attributes: [
                { key: "temperature", value: { doubleValue: 1 } },
                {
                  key: "http.request.header.authorization",
                  value: { stringValue: "Bearer sk-live" },
                },
                { key: "gen_ai.input.messages", value: { stringValue: "[]" } },
              ],
              events: [{ name: "tick", timeUnixNano: "1700000000200000001", attributes: [] }],
              links: [{ traceId: OTHER_TRACE, spanId: "b7ad6b7169203331", traceState: "linked=1" }],
              status: { code: 2, message: "rate limited" },
            },
            { traceId: OTHER_TRACE, spanId: "c7ad6b7169203332", name: "other trace" },
          ],
        },
      ],
    },
  ],
};

test("a downloaded trace keeps every field the exporter sent", () => {
  const request = decodeOtlpRequest(
    "application/json",
    new TextEncoder().encode(JSON.stringify(EXPORT)),
  );
  const json = traceOtlpJson([request], TRACE_ID, { readContent: true });

  const [resource] = json.resourceSpans;
  assert.equal(resource.schemaUrl, "https://opentelemetry.io/schemas/1.26.0");
  const [scoped] = resource.scopeSpans ?? [];
  assert.deepEqual(scoped.scope, { name: "scope-a", version: "1.2.3" });
  assert.equal(scoped.spans?.length, 1, "only this trace's spans");
  const span = scoped.spans![0] as Record<string, unknown>;
  assert.equal(span.traceState, "vendor=1");
  assert.equal(span.startTimeUnixNano, "1700000000123456789");
  assert.equal(span.endTimeUnixNano, "1700000000456789012");
  assert.deepEqual(span.status, { code: 2, message: "rate limited" });
  assert.deepEqual(span.links, [
    { traceId: OTHER_TRACE, spanId: "b7ad6b7169203331", traceState: "linked=1" },
  ]);
  assert.deepEqual(
    (span.events as Array<{ timeUnixNano: string }>)[0].timeUnixNano,
    "1700000000200000001",
  );
  assert.deepEqual(span.attributes, [
    { key: "temperature", value: { doubleValue: 1 } },
    { key: "http.request.header.authorization", value: { stringValue: REDACTED } },
    { key: "gen_ai.input.messages", value: { stringValue: "[]" } },
  ]);
});

test("a protobuf export keeps the same fields, with hex ids", async () => {
  const protobuf = (await import("protobufjs")).default;
  const descriptor = (await import("@/lib/ingest/otlp/proto/otlp-trace.descriptor.json")).default;
  const Request = protobuf.Root.fromJSON(descriptor as never).lookupType(
    "ratel.otlp.ExportTraceServiceRequest",
  );
  const hex = (id: string) => Buffer.from(id, "hex");
  const span = EXPORT.resourceSpans[0].scopeSpans[0].spans[0];
  const bytes = Request.encode(
    Request.fromObject({
      resourceSpans: [
        {
          scopeSpans: [
            {
              scope: { name: "scope-a", version: "1.2.3" },
              spans: [
                {
                  ...span,
                  traceId: hex(TRACE_ID),
                  spanId: hex(span.spanId),
                  links: [
                    {
                      traceId: hex(OTHER_TRACE),
                      spanId: hex("b7ad6b7169203331"),
                      traceState: "linked=1",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  ).finish();

  const [scoped] = traceOtlpJson([decodeOtlpRequest("application/x-protobuf", bytes)], TRACE_ID, {
    readContent: true,
  }).resourceSpans[0].scopeSpans!;
  const out = scoped.spans![0] as Record<string, unknown>;
  assert.equal(out.traceId, TRACE_ID);
  assert.equal(out.spanId, "00f067aa0ba902b7");
  assert.equal(out.startTimeUnixNano, "1700000000123456789");
  assert.deepEqual(out.status, { code: 2, message: "rate limited" });
  // protobuf lists an empty repeated field as `[]`: the same OTLP.
  assert.deepEqual(out.links, [
    { traceId: OTHER_TRACE, spanId: "b7ad6b7169203331", traceState: "linked=1", attributes: [] },
  ]);
  assert.deepEqual((out.attributes as unknown[])[0], {
    key: "temperature",
    value: { doubleValue: 1 },
  });
});

test("a span sent twice is kept once; read_content off drops content", () => {
  const request = decodeOtlpRequest(
    "application/json",
    new TextEncoder().encode(JSON.stringify(EXPORT)),
  );
  const json = traceOtlpJson([request, request], TRACE_ID, { readContent: false });

  const spans = json.resourceSpans.flatMap((resource) =>
    (resource.scopeSpans ?? []).flatMap((s) => s.spans ?? []),
  );
  assert.equal(spans.length, 1);
  assert.deepEqual(
    (spans[0].attributes ?? []).map((attribute) => attribute.key),
    ["http.request.header.authorization"],
  );
});

test("JSON ids sent as base64 come out as lowercase hex", () => {
  const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
  const body = {
    resourceSpans: [
      {
        scopeSpans: [
          { spans: [{ traceId: b64(TRACE_ID), spanId: b64("00f067aa0ba902b7"), name: "x" }] },
        ],
      },
    ],
  };
  const request = decodeOtlpRequest(
    "application/json",
    new TextEncoder().encode(JSON.stringify(body)),
  );
  const span = traceOtlpJson([request], TRACE_ID, { readContent: true }).resourceSpans[0]
    .scopeSpans![0].spans![0];

  assert.equal(span.traceId, TRACE_ID);
  assert.equal(span.spanId, "00f067aa0ba902b7");
});

test("the span name and status message have URL credentials redacted", () => {
  const body = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE_ID,
                spanId: "00f067aa0ba902b7",
                name: "GET /v1?api_key=X1",
                status: { code: 2, message: "failed: https://x.test/y?token=X2" },
              },
            ],
          },
        ],
      },
    ],
  };
  const request = decodeOtlpRequest(
    "application/json",
    new TextEncoder().encode(JSON.stringify(body)),
  );
  const span = traceOtlpJson([request], TRACE_ID, { readContent: true }).resourceSpans[0]
    .scopeSpans![0].spans![0];

  assert.equal(span.name, `GET /v1?api_key=${REDACTED}`);
  assert.equal(span.status?.message, `failed: https://x.test/y?token=${REDACTED}`);
});

test("no exports is an empty request", () => {
  assert.deepEqual(traceOtlpJson([], TRACE_ID, { readContent: true }), { resourceSpans: [] });
});
