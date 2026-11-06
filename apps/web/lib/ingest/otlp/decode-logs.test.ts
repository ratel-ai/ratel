import assert from "node:assert/strict";
import { test } from "node:test";
import protobuf from "protobufjs";
import { decodeOtlpLogs, OtlpDecodeError } from "./decode-logs";
import descriptor from "./proto/otlp-logs.descriptor.json";
import type { AttrValue } from "./types";

const root = protobuf.Root.fromJSON(descriptor as protobuf.INamespace);
const RequestType = root.lookupType("ratel.otlp.ExportLogsServiceRequest");

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SPAN_ID = "1111111111111111";
const TIME_NS = "1751800000000123456";
const OBSERVED_TIME_NS = "1751800001000654321";

function anyValue(value: AttrValue): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(anyValue) } };
  }
  if (value && typeof value === "object") {
    return { kvlistValue: { values: keyValues(value) } };
  }
  return {};
}

function keyValues(attributes: Record<string, AttrValue>): Array<Record<string, unknown>> {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: anyValue(value),
  }));
}

function request(idBytes: boolean): Record<string, unknown> {
  const id = (hex: string) => (idBytes ? Buffer.from(hex, "hex") : hex);
  return {
    resourceLogs: [
      {
        resource: {
          attributes: keyValues({ "service.name": "ranking-agent" }),
        },
        scopeLogs: [
          {
            scope: { name: "@ratel-ai/sdk" },
            logRecords: [
              {
                timeUnixNano: TIME_NS,
                observedTimeUnixNano: OBSERVED_TIME_NS,
                severityNumber: 9,
                severityText: "INFO",
                body: anyValue({
                  label: "helpful",
                  scores: [0.8, 0.4],
                }),
                attributes: keyValues({
                  "ratel.experiment.id": "search-ranking",
                  "ratel.experiment.result_ids": ["doc-1", "doc-2"],
                  "ratel.experiment.agreement": {
                    exact_order: false,
                    jaccard_at_k: 0.5,
                  },
                }),
                traceId: id(TRACE_ID),
                spanId: id(SPAN_ID),
                eventName: "ratel.experiment.results",
              },
            ],
          },
        ],
      },
    ],
  };
}

function jsonBytes(): Uint8Array {
  return Buffer.from(JSON.stringify(request(false)), "utf8");
}

function protobufBytes(): Uint8Array {
  return RequestType.encode(RequestType.fromObject(request(true))).finish();
}

test("OTLP/JSON logs normalize ids, dual time, body, attrs, resource, and scope", () => {
  const records = decodeOtlpLogs("application/json", jsonBytes());

  assert.deepEqual(records, [
    {
      eventName: "ratel.experiment.results",
      timeUnixNano: TIME_NS,
      timeUnixMs: 1_751_800_000_000,
      observedTimeUnixNano: OBSERVED_TIME_NS,
      observedTimeUnixMs: 1_751_800_001_000,
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      severityNumber: 9,
      severityText: "INFO",
      body: { label: "helpful", scores: [0.8, 0.4] },
      attributes: {
        "ratel.experiment.id": "search-ranking",
        "ratel.experiment.result_ids": ["doc-1", "doc-2"],
        "ratel.experiment.agreement": {
          exact_order: false,
          jaccard_at_k: 0.5,
        },
      },
      catalogDefinition: null,
      resourceAttributes: { "service.name": "ranking-agent" },
      scopeName: "@ratel-ai/sdk",
    },
  ]);
});

test("protobuf and OTLP/JSON logs normalize identically, including event_name field 12", () => {
  assert.deepEqual(
    decodeOtlpLogs("application/x-protobuf", protobufBytes()),
    decodeOtlpLogs("application/json", jsonBytes()),
  );
});

test("event.name supplies a missing eventName and zero ids become null", () => {
  const bytes = Buffer.from(
    JSON.stringify({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: keyValues({
                    "event.name": "ratel.experiment.outcome",
                  }),
                  traceId: "00000000000000000000000000000000",
                  spanId: "0000000000000000",
                },
              ],
            },
          ],
        },
      ],
    }),
    "utf8",
  );

  const [record] = decodeOtlpLogs("application/json", bytes);

  assert.equal(record.eventName, "ratel.experiment.outcome");
  assert.equal(record.traceId, null);
  assert.equal(record.spanId, null);
});

test("catalog definitions accept any canonical JSON schema root", () => {
  const bytes = Buffer.from(
    JSON.stringify({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  eventName: "ratel.catalog.definition",
                  attributes: keyValues({
                    "ratel.catalog.kind": "tool",
                    "ratel.catalog.id": "allow_all",
                    "ratel.catalog.name": "allow_all",
                    "ratel.catalog.description": "Allow any value",
                    "ratel.catalog.tags": [],
                    "ratel.catalog.input_schema": "true",
                    "ratel.catalog.output_schema": "false",
                    "ratel.catalog.searchable_description": "Allow any value",
                    "ratel.catalog.searchable_description_overridden": false,
                    "ratel.catalog.content_hash": "a".repeat(64),
                  }),
                },
              ],
            },
          ],
        },
      ],
    }),
    "utf8",
  );

  const [record] = decodeOtlpLogs("application/json", bytes);

  assert.equal(record.catalogDefinition?.inputSchema, true);
  assert.equal(record.catalogDefinition?.outputSchema, false);
});

test("catalog definitions retain oversized tools when an emitted schema is omitted", () => {
  const bytes = Buffer.from(
    JSON.stringify({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  eventName: "ratel.catalog.definition",
                  attributes: keyValues({
                    "ratel.catalog.kind": "tool",
                    "ratel.catalog.id": "oversized",
                    "ratel.catalog.name": "oversized",
                    "ratel.catalog.description": "Oversized schema",
                    "ratel.catalog.tags": [],
                    "ratel.catalog.output_schema": '{"type":"object"}',
                    "ratel.catalog.schema_omitted": true,
                    "ratel.catalog.searchable_description": "Oversized schema",
                    "ratel.catalog.searchable_description_overridden": false,
                    "ratel.catalog.content_hash": "b".repeat(64),
                  }),
                },
              ],
            },
          ],
        },
      ],
    }),
    "utf8",
  );

  const [record] = decodeOtlpLogs("application/json", bytes);

  assert.equal(record.catalogDefinition?.inputSchema, null);
  assert.deepEqual(record.catalogDefinition?.outputSchema, { type: "object" });
});

test("catalog definitions decode attach mode and default an absent flag to false", () => {
  const definition = {
    "ratel.catalog.kind": "skill",
    "ratel.catalog.name": "review_code",
    "ratel.catalog.description": "Review source",
    "ratel.catalog.tags": ["quality"],
    "ratel.catalog.searchable_description": "Review source",
    "ratel.catalog.searchable_description_overridden": false,
    "ratel.catalog.content_hash": "b".repeat(64),
  };
  const bytes = Buffer.from(
    JSON.stringify({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  eventName: "ratel.catalog.definition",
                  attributes: keyValues({
                    ...definition,
                    "ratel.catalog.id": "attached",
                    "ratel.catalog.use_definition_overrides": true,
                  }),
                },
                {
                  eventName: "ratel.catalog.definition",
                  attributes: keyValues({
                    ...definition,
                    "ratel.catalog.id": "local",
                  }),
                },
              ],
            },
          ],
        },
      ],
    }),
    "utf8",
  );

  const records = decodeOtlpLogs("application/json", bytes);

  assert.equal(records[0]?.catalogDefinition?.useCloudDefinitions, true);
  assert.equal(records[1]?.catalogDefinition?.useCloudDefinitions, false);
});

test("malformed payloads fail through OtlpDecodeError", () => {
  assert.equal(typeof OtlpDecodeError, "function");
  assert.throws(
    () => decodeOtlpLogs("application/json", Buffer.from("{not json")),
    OtlpDecodeError,
  );
  assert.throws(
    () => decodeOtlpLogs("application/x-protobuf", Buffer.from([0xff, 0xff, 0xff, 0xff])),
    OtlpDecodeError,
  );
});

test("real ProtobufLogsSerializer output preserves eventName and trace context", async () => {
  const { context, trace, TraceFlags } = await import("@opentelemetry/api");
  const { SeverityNumber } = await import("@opentelemetry/api-logs");
  const { ProtobufLogsSerializer } = await import("@opentelemetry/otlp-transformer");
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } = await import(
    "@opentelemetry/sdk-logs"
  );

  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": "real-log-agent" }),
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  const logger = provider.getLogger("@ratel-ai/sdk");
  const logContext = trace.setSpanContext(context.active(), {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
  });

  logger.emit({
    eventName: "ratel.experiment.comparison",
    severityNumber: SeverityNumber.INFO,
    body: { comparison: "shadow" },
    attributes: {
      "ratel.experiment.id": "search-ranking",
      "ratel.experiment.agreement.jaccard_at_k": 0.5,
    },
    context: logContext,
  });

  const bytes = ProtobufLogsSerializer.serializeRequest(exporter.getFinishedLogRecords());
  assert.ok(bytes);
  const [record] = decodeOtlpLogs("application/x-protobuf", bytes as Uint8Array);
  assert.equal(record.eventName, "ratel.experiment.comparison");
  assert.equal(record.traceId, TRACE_ID);
  assert.equal(record.spanId, SPAN_ID);
  assert.equal(record.severityNumber, SeverityNumber.INFO);
  assert.equal(record.scopeName, "@ratel-ai/sdk");
  assert.equal(record.resourceAttributes["service.name"], "real-log-agent");
  assert.deepEqual(record.body, { comparison: "shadow" });
  assert.equal(record.attributes["ratel.experiment.agreement.jaccard_at_k"], 0.5);

  await provider.shutdown();
});
