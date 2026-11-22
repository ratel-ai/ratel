import assert from "node:assert/strict";
import { test } from "node:test";
import protobuf from "protobufjs";
import { decodeOtlpRequest } from "./decode";
import logsDescriptor from "./proto/otlp-logs.descriptor.json";
import traceDescriptor from "./proto/otlp-trace.descriptor.json";
import {
  CLIENT_ADDRESS_STRIP_FLAG,
  clientAddressStripEnabled,
  isClientAddressKey,
  stripClientAddresses,
} from "./strip-client-address";

const TraceRequest = protobuf.Root.fromJSON(traceDescriptor as protobuf.INamespace).lookupType(
  "ratel.otlp.ExportTraceServiceRequest",
);
const LogsRequest = protobuf.Root.fromJSON(logsDescriptor as protobuf.INamespace).lookupType(
  "ratel.otlp.ExportLogsServiceRequest",
);

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });

function traceExport() {
  return {
    resourceSpans: [
      {
        resource: { attributes: [str("service.name", "beluga"), str("host.ip", "192.0.2.10")] },
        scopeSpans: [
          {
            scope: { name: "beluga", attributes: [str("net.host.ip", "192.0.2.11")] },
            spans: [
              {
                traceId: "0000000000000000000000000000000a",
                spanId: "000000000000000a",
                name: "chat",
                startTimeUnixNano: "1751800000000000000",
                endTimeUnixNano: "1751800000200000000",
                attributes: [
                  str("gen_ai.operation.name", "chat"),
                  str("client.address", "203.0.113.7"),
                  str("server.address", "api.anthropic.com"),
                ],
                events: [
                  {
                    name: "e",
                    timeUnixNano: "1751800000100000000",
                    attributes: [str("network.peer.address", "198.51.100.2")],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function logsExport() {
  return {
    resourceLogs: [
      {
        resource: { attributes: [str("service.name", "beluga"), str("host.ip", "192.0.2.10")] },
        scopeLogs: [
          {
            scope: { name: "beluga" },
            logRecords: [
              {
                timeUnixNano: "1751800000000000000",
                eventName: "claude_code.api_request",
                body: { stringValue: "hello" },
                attributes: [str("ratel.experiment.id", "x"), str("client.address", "203.0.113.7")],
              },
            ],
          },
        ],
      },
    ],
  };
}

function keysOf(value: unknown): string[] {
  const keys: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    for (const [field, child] of Object.entries(node)) {
      if (field === "attributes" && Array.isArray(child)) {
        for (const kv of child) keys.push((kv as { key: string }).key);
      }
      walk(child);
    }
  };
  walk(value);
  return keys;
}

/** The strip itself, switched on: the switch has its own tests below. */
const strip = (...args: Parameters<typeof stripClientAddresses>) =>
  stripClientAddresses(args[0], args[1], args[2], true);
const encode = (text: string) => new TextEncoder().encode(text);
const decodeJson = (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString("utf8"));

test("an OTLP/JSON trace export loses every client address key and keeps the rest", () => {
  const result = strip("traces", "json", encode(JSON.stringify(traceExport())));
  assert.equal(result.stripped, true);
  assert.deepEqual(keysOf(decodeJson(result.bytes)), [
    "service.name",
    "gen_ai.operation.name",
    "server.address",
  ]);
});

test("an OTLP/JSON export without client address keys comes back as the same bytes", () => {
  const body = encode(
    JSON.stringify({
      resourceSpans: [{ resource: { attributes: [str("service.name", "beluga")] } }],
    }),
  );
  const result = strip("traces", "json", body);
  assert.equal(result.stripped, false);
  assert.equal(result.bytes, body);
});

test("a key name that appears only inside a value is left alone", () => {
  const body = encode(
    JSON.stringify({
      resourceSpans: [{ resource: { attributes: [str("note", "client.address and host.ip")] } }],
    }),
  );
  const result = strip("traces", "json", body);
  assert.equal(result.stripped, false);
  assert.equal(result.bytes, body);
});

test("a protobuf trace export loses every client address key and still decodes", () => {
  const payload = traceExport();
  for (const span of payload.resourceSpans[0]?.scopeSpans[0]?.spans ?? []) {
    (span as Record<string, unknown>).traceId = Buffer.from(span.traceId, "hex");
    (span as Record<string, unknown>).spanId = Buffer.from(span.spanId, "hex");
  }
  const body = TraceRequest.encode(TraceRequest.fromObject(payload)).finish();
  const result = strip("traces", "protobuf", body);
  assert.equal(result.stripped, true);
  const decoded = decodeOtlpRequest("application/x-protobuf", result.bytes);
  assert.deepEqual(keysOf(decoded).sort(), [
    "gen_ai.operation.name",
    "server.address",
    "service.name",
  ]);
  assert.equal(decoded.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.spanId, "000000000000000a");
});

test("OTLP log exports lose client address keys in JSON and protobuf", () => {
  const json = strip("logs", "json", encode(JSON.stringify(logsExport())));
  assert.equal(json.stripped, true);
  assert.deepEqual(keysOf(decodeJson(json.bytes)), ["service.name", "ratel.experiment.id"]);

  const proto = strip(
    "logs",
    "protobuf",
    LogsRequest.encode(LogsRequest.fromObject(logsExport())).finish(),
  );
  assert.equal(proto.stripped, true);
  assert.deepEqual(keysOf(LogsRequest.toObject(LogsRequest.decode(proto.bytes))), [
    "service.name",
    "ratel.experiment.id",
  ]);
});

test("a body that does not parse is returned untouched for the decoder to refuse", () => {
  const body = encode('{"client.address": ');
  const result = strip("traces", "json", body);
  assert.equal(result.stripped, false);
  assert.equal(result.bytes, body);
});

test("the key list names the OTel attributes that carry a sender's IP address", () => {
  for (const key of [
    "client.address",
    "client.socket.address",
    "host.ip",
    "network.peer.address",
    "net.peer.ip",
    "http.client_ip",
    "http.request.header.x-forwarded-for",
    "http.request.header.x_forwarded_for",
    "http.request.header.x-real-ip",
    "http.request.header.forwarded",
    "http.request.header.X-Forwarded-For",
    "http.request.header.x-forwarded-for.0",
    "Http.Request.Header.X-Forwarded-For",
    "HOST.IP",
    "Client.Address",
    "http.request.header.true-client-ip",
    "http.request.header.true_client_ip",
    "http.request.header.cf-connecting-ip",
    "http.request.header.CF_Connecting_IP.0",
  ]) {
    assert.ok(isClientAddressKey(key), key);
  }
  for (const key of [
    "server.address",
    "http.request.header.user-agent",
    "http.request.header.x-forwarded-proto",
  ]) {
    assert.equal(isClientAddressKey(key), false, key);
  }
});

test("captured forwarding headers go, in string, array and flattened forms", () => {
  const forwarded = (key: string) => ({
    key,
    value: { arrayValue: { values: [{ stringValue: "203.0.113.7, 10.0.0.1" }] } },
  });
  const body = encode(
    JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [str("client.socket.address", "203.0.113.7")] },
          scopeSpans: [
            {
              spans: [
                {
                  attributes: [
                    forwarded("http.request.header.x-forwarded-for"),
                    str("http.request.header.x-real-ip", "203.0.113.7"),
                    str("http.request.header.forwarded.0", "for=203.0.113.7"),
                    str("http.request.header.user-agent", "beluga"),
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const result = strip("traces", "json", body);
  assert.equal(result.stripped, true);
  assert.doesNotMatch(Buffer.from(result.bytes).toString("utf8"), /203\.0\.113\.7/);
  assert.deepEqual(keysOf(decodeJson(result.bytes)), ["http.request.header.user-agent"]);
});

test("a mixed-case key is stripped from the body too", () => {
  const body = encode(
    JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              str("Http.Request.Header.X-Forwarded-For", "203.0.113.7"),
              str("Host.IP", "192.0.2.10"),
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  attributes: [
                    str("http.request.header.cf-connecting-ip", "203.0.113.7"),
                    str("ok", "1"),
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const result = strip("traces", "json", body);
  assert.equal(result.stripped, true);
  assert.deepEqual(keysOf(decodeJson(result.bytes)), ["ok"]);
});

test("IP keys nested in a kvlistValue go too: an attribute value and a log record body", () => {
  const nested = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                body: {
                  kvlistValue: {
                    values: [str("client.address", "203.0.113.7"), str("event", "turn")],
                  },
                },
                attributes: [
                  {
                    key: "ratel.request",
                    value: {
                      kvlistValue: {
                        values: [
                          {
                            key: "peer",
                            value: {
                              kvlistValue: {
                                values: [str("net.peer.ip", "198.51.100.2"), str("port", "443")],
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const json = strip("logs", "json", encode(JSON.stringify(nested)));
  assert.equal(json.stripped, true);
  const text = Buffer.from(json.bytes).toString("utf8");
  assert.doesNotMatch(text, /203\.0\.113\.7|198\.51\.100\.2/);
  assert.match(text, /"event"/);
  assert.match(text, /"port"/);

  const proto = strip(
    "logs",
    "protobuf",
    LogsRequest.encode(LogsRequest.fromObject(nested)).finish(),
  );
  assert.equal(proto.stripped, true);
  const decoded = JSON.stringify(LogsRequest.toObject(LogsRequest.decode(proto.bytes)));
  assert.doesNotMatch(decoded, /203\.0\.113\.7|198\.51\.100\.2/);
  assert.match(decoded, /"port"/);
});

test("the strip is the deployment switch FF_INGEST_STRIP_CLIENT_ADDRESS, off by default", () => {
  assert.equal(CLIENT_ADDRESS_STRIP_FLAG, "FF_INGEST_STRIP_CLIENT_ADDRESS");
  assert.equal(clientAddressStripEnabled({}, "Ratel Cloud"), false);
  for (const value of ["1", "true", " TRUE "]) {
    assert.equal(
      clientAddressStripEnabled({ FF_INGEST_STRIP_CLIENT_ADDRESS: value }, "Ratel Cloud"),
      true,
      value,
    );
  }
  for (const value of ["0", "false", "yes"]) {
    assert.equal(
      clientAddressStripEnabled({ FF_INGEST_STRIP_CLIENT_ADDRESS: value }, "Ratel Cloud"),
      false,
      value,
    );
  }
});

test("in the open-source edition, RATEL_EXPERIMENTAL_FEATURES turns the strip on too", () => {
  assert.equal(clientAddressStripEnabled({ RATEL_EXPERIMENTAL_FEATURES: "1" }, "Ratel OSS"), true);
  assert.equal(
    clientAddressStripEnabled({ RATEL_EXPERIMENTAL_FEATURES: "1" }, "Ratel Cloud"),
    false,
  );
});

test("with the strip off, the body comes back as sent", () => {
  const body = encode(JSON.stringify(traceExport()));
  const result = stripClientAddresses("traces", "json", body, false);
  assert.equal(result.stripped, false);
  assert.equal(result.bytes, body);
});
