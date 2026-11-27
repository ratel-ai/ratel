import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { decodeOtlp } from "@/lib/ingest/otlp/decode";
import { decodeOtlpLogs } from "@/lib/ingest/otlp/decode-logs";
import { MAX_BODY_BYTES as MAX_LOGS_BODY_BYTES } from "@/lib/ingest/otlp/logs-route-handler";
import { MAX_BODY_BYTES as MAX_TRACES_BODY_BYTES } from "@/lib/ingest/otlp/route-handler";
import { parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import { MAX_BODY_BYTES as MAX_EVENTS_BODY_BYTES } from "@/lib/ingest/trace-events/route-handler";
import {
  decodeEnvelope,
  ENVELOPE_VERSION,
  type Envelope,
  EnvelopeError,
  type EnvelopeErrorReason,
  encodeEnvelope,
  MAX_ENVELOPE_BODY_BYTES,
} from "./envelope";

const FIXTURES = join(import.meta.dirname, "__fixtures__");
const FRAME_PREFIX = 9;

/** A sample's decoded fields, as `<name>.json` states them for every implementation. */
type Sample = Omit<Envelope, "body"> & { bodyBytes: number; bodySha256: string };

const sampleNames = readdirSync(FIXTURES)
  .filter((file) => file.endsWith(".bin"))
  .map((file) => file.slice(0, -".bin".length));
const readable = sampleNames.filter((name) => !name.startsWith("newer-version"));

const frameOf = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, `${name}.bin`)));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    version: ENVELOPE_VERSION,
    id: "0d1f7a3c-5b1e-4c6a-9f00-000000000001",
    projectId: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    keyId: "33333333-3333-4333-8333-333333333333",
    keyPolicy: { appendOnlyIngest: false, sharedKeyLimits: false },
    signal: "traces",
    contentType: "application/x-protobuf",
    contentEncoding: "identity",
    receivedAt: 1_795_600_000_123,
    body: new Uint8Array([0, 1, 2, 255]),
    ...overrides,
  };
}

/** A version 1 frame with this header text, as a writer with a bug would send it. */
function frameWithHeader(header: string, body: Uint8Array = new Uint8Array()): Uint8Array {
  const bytes = Buffer.from(header, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return new Uint8Array(
    Buffer.concat([Buffer.from("RTLE"), Buffer.from([ENVELOPE_VERSION]), length, bytes, body]),
  );
}

function headerText(value: Envelope = envelope()): string {
  const frame = Buffer.from(encodeEnvelope(value));
  return frame.subarray(FRAME_PREFIX, FRAME_PREFIX + frame.readUInt32BE(5)).toString("utf8");
}

function refuses(run: () => unknown, reason: EnvelopeErrorReason, message: RegExp): void {
  assert.throws(run, (err) => {
    assert.ok(err instanceof EnvelopeError, String(err));
    assert.equal(err.reason, reason);
    assert.match(err.message, message);
    return true;
  });
}

test("an envelope is a frame: magic, version, header length, header in fixed order, body", () => {
  const frame = Buffer.from(encodeEnvelope(envelope()));
  assert.equal(frame.subarray(0, 4).toString("ascii"), "RTLE");
  assert.equal(frame[4], 1);
  const header =
    '{"id":"0d1f7a3c-5b1e-4c6a-9f00-000000000001",' +
    '"projectId":"11111111-1111-4111-8111-111111111111",' +
    '"organizationId":"22222222-2222-4222-8222-222222222222",' +
    '"keyId":"33333333-3333-4333-8333-333333333333",' +
    '"keyPolicy":{"appendOnlyIngest":false,"sharedKeyLimits":false},' +
    '"signal":"traces","contentType":"application/x-protobuf",' +
    '"contentEncoding":"identity","receivedAt":1795600000123}';
  assert.equal(frame.readUInt32BE(5), header.length);
  assert.equal(frame.subarray(FRAME_PREFIX, FRAME_PREFIX + header.length).toString("utf8"), header);
  assert.deepEqual([...frame.subarray(FRAME_PREFIX + header.length)], [0, 1, 2, 255]);
});

test("the header does not follow the caller's key order", () => {
  const { body, ...rest } = envelope();
  const reversed = Object.fromEntries(Object.entries(rest).reverse());
  const shuffled = {
    ...reversed,
    body,
    keyPolicy: { sharedKeyLimits: false, appendOnlyIngest: false },
  } as unknown as Envelope;
  assert.deepEqual(encodeEnvelope(shuffled), encodeEnvelope(envelope()));
});

test("decode gives back every field", () => {
  const cases: Envelope[] = [
    envelope(),
    envelope({ body: new Uint8Array() }),
    envelope({
      signal: "logs",
      contentType: "application/json",
      contentEncoding: "gzip",
      keyPolicy: { appendOnlyIngest: true, sharedKeyLimits: true },
    }),
    envelope({ contentEncoding: "deflate", receivedAt: 0 }),
    envelope({ signal: "events", contentType: "application/json" }),
  ];
  for (const value of cases) assert.deepEqual(decodeEnvelope(encodeEnvelope(value)), value);
});

test("decode reads a frame inside a larger buffer and copies its body", () => {
  const frame = encodeEnvelope(envelope());
  const pool = new Uint8Array(frame.length + 16).fill(7);
  pool.set(frame, 8);
  const decoded = decodeEnvelope(pool.subarray(8, 8 + frame.length));
  pool.fill(0);
  assert.deepEqual(decoded, envelope());
});

test("the body limit is the one every ingest route has", () => {
  for (const limit of [MAX_TRACES_BODY_BYTES, MAX_LOGS_BODY_BYTES, MAX_EVENTS_BODY_BYTES]) {
    assert.equal(MAX_ENVELOPE_BODY_BYTES, limit);
  }
  const full = envelope({ body: new Uint8Array(MAX_ENVELOPE_BODY_BYTES) });
  assert.equal(decodeEnvelope(encodeEnvelope(full)).body.byteLength, MAX_ENVELOPE_BODY_BYTES);
  const over = new Uint8Array(MAX_ENVELOPE_BODY_BYTES + 1);
  refuses(() => encodeEnvelope(envelope({ body: over })), "malformed", /body.*4000000/);
  refuses(() => decodeEnvelope(frameWithHeader(headerText(), over)), "malformed", /body.*4000000/);
});

test("encode refuses a field that its type or the contract does not allow", () => {
  const bad: [string, unknown][] = [
    ["id", "not-a-uuid"],
    ["projectId", "11111111-1111-4111-8111-11111111111A"],
    ["organizationId", null],
    ["keyId", undefined],
    ["keyPolicy", { appendOnlyIngest: "false", sharedKeyLimits: false }],
    ["signal", "metrics"],
    ["contentType", "application/json; charset=utf-8"],
    ["contentEncoding", "x-gzip"],
    ["receivedAt", 1.5],
    ["receivedAt", -1],
    ["receivedAt", 253_402_300_800_000],
  ];
  for (const [field, value] of bad) {
    refuses(
      () => encodeEnvelope({ ...envelope(), [field]: value } as Envelope),
      "malformed",
      new RegExp(field),
    );
  }
});

test("events are JSON and not compressed, in both directions", () => {
  const protobuf = envelope({ signal: "events" });
  const gzipped = envelope({
    signal: "events",
    contentType: "application/json",
    contentEncoding: "gzip",
  });
  refuses(() => encodeEnvelope(protobuf), "malformed", /contentType/);
  refuses(() => encodeEnvelope(gzipped), "malformed", /contentEncoding/);
  const header = headerText().replace('"traces"', '"events"');
  refuses(() => decodeEnvelope(frameWithHeader(header)), "malformed", /contentType/);
});

test("decode refuses bytes that are not an envelope", () => {
  const frame = encodeEnvelope(envelope());
  const wrongMagic = frame.slice();
  wrongMagic[0] = 0;
  refuses(() => decodeEnvelope(wrongMagic), "malformed", /RTLE/);
  refuses(() => decodeEnvelope(new Uint8Array()), "malformed", /RTLE/);
  refuses(() => decodeEnvelope(frame.subarray(0, 4)), "malformed", /truncated/);
  refuses(() => decodeEnvelope(frame.subarray(0, 7)), "malformed", /truncated/);
  refuses(() => decodeEnvelope(frame.subarray(0, 40)), "malformed", /truncated/);
  const longHeader = frame.slice();
  longHeader.set([0xff, 0xff, 0xff, 0xff], 5);
  refuses(() => decodeEnvelope(longHeader), "malformed", /header.*4096/);
  const versionZero = frame.slice();
  versionZero[4] = 0;
  refuses(() => decodeEnvelope(versionZero), "malformed", /version 0/);
});

test("decode refuses a header that it would not write byte for byte", () => {
  const header = headerText();
  const bad = [
    "{}",
    "null",
    "[]",
    "not json",
    `${header} `,
    `﻿${header}`,
    header.replace(",", ", "),
    header.replace("1795600000123", "1795600000123.0"),
    header.replace("1795600000123}", '1795600000123,"extra":true}'),
    header.replace('"traces"', '"\\u0074races"'),
    header.replace(/"receivedAt":\d+/, '"receivedAt":1,"receivedAt":1795600000123'),
    header.replace(
      '"appendOnlyIngest":false,"sharedKeyLimits":false',
      '"sharedKeyLimits":false,"appendOnlyIngest":false',
    ),
  ];
  for (const text of bad) {
    refuses(() => decodeEnvelope(frameWithHeader(text)), "malformed", /header/);
  }
});

test("an error never quotes the envelope's content", () => {
  const header = headerText().replace('"traces"', '"a customer secret"');
  assert.throws(
    () => decodeEnvelope(frameWithHeader(header)),
    (err) => err instanceof EnvelopeError && !err.message.includes("secret"),
  );
});

test("there is a sample per signal, a compressed one and a newer version", () => {
  assert.deepEqual(sampleNames.sort(), [
    "events-json",
    "logs-json",
    "newer-version",
    "traces-json-gzip",
    "traces-protobuf",
  ]);
});

for (const name of readable) {
  test(`sample ${name} decodes to its stated fields and encodes to the same bytes`, () => {
    const frame = frameOf(name);
    const decoded = decodeEnvelope(frame);
    const { body, ...fields } = decoded;
    const stated = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Sample;
    assert.deepEqual({ ...fields, bodyBytes: body.byteLength, bodySha256: sha256(body) }, stated);
    assert.deepEqual(Buffer.from(encodeEnvelope(decoded)), Buffer.from(frame));
  });
}

test("a sample with a newer version is refused, by version, before anything else is read", () => {
  refuses(
    () => decodeEnvelope(frameOf("newer-version")),
    "unsupported_version",
    /version 2 .*newer.*reads up to 1/,
  );
  refuses(
    () => decodeEnvelope(new Uint8Array(Buffer.from("RTLE\u0002"))),
    "unsupported_version",
    /version 2/,
  );
  refuses(
    () => encodeEnvelope({ ...envelope(), version: 2 } as unknown as Envelope),
    "unsupported_version",
    /version 2/,
  );
});

test("the samples carry bodies that today's decoders read", () => {
  const protobuf = decodeEnvelope(frameOf("traces-protobuf"));
  assert.equal(decodeOtlp(protobuf.contentType, protobuf.body).length, 1);
  const gzipped = decodeEnvelope(frameOf("traces-json-gzip"));
  assert.equal(decodeOtlp(gzipped.contentType, gunzipSync(gzipped.body)).length, 1);
  const logs = decodeEnvelope(frameOf("logs-json"));
  assert.equal(decodeOtlpLogs(logs.contentType, logs.body).length, 1);
  const events = decodeEnvelope(frameOf("events-json"));
  const batch = JSON.parse(Buffer.from(events.body).toString("utf8")) as { events: unknown[] };
  const parsed = parseTraceEvents(batch.events);
  assert.equal(parsed.valid.length, 1);
  assert.equal(parsed.rejected.length, 0);
});
