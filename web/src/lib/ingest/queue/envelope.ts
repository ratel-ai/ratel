/**
 * The queued ingest message and its one encoding (ADR-0010). Other writers and readers, in
 * other languages, must match it byte for byte: `__fixtures__` holds the samples they test
 * against.
 *
 * Frame: `RTLE`, one version byte, the header length (u32, big endian), the header, the body.
 * The header is the JSON of every field but `version` and `body`, in a fixed order and without
 * whitespace. No header value can hold a character that JSON encoders escape differently.
 */

export const ENVELOPE_VERSION = 1;

/** The body limit of the three ingest routes (`MAX_BODY_BYTES`), before decompression. */
export const MAX_ENVELOPE_BODY_BYTES = 4_000_000;

const MAX_HEADER_BYTES = 4_096;
const MAGIC = [0x52, 0x54, 0x4c, 0x45]; // "RTLE"
const VERSION_OFFSET = MAGIC.length;
const HEADER_LENGTH_OFFSET = VERSION_OFFSET + 1;
const HEADER_OFFSET = HEADER_LENGTH_OFFSET + 4;
/** 9999-12-31T23:59:59.999Z */
const MAX_RECEIVED_AT = 253_402_300_799_999;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const ENVELOPE_SIGNALS = ["traces", "logs", "events"] as const;
export type EnvelopeSignal = (typeof ENVELOPE_SIGNALS)[number];

export const ENVELOPE_CONTENT_TYPES = ["application/x-protobuf", "application/json"] as const;
export type EnvelopeContentType = (typeof ENVELOPE_CONTENT_TYPES)[number];

export const ENVELOPE_CONTENT_ENCODINGS = ["identity", "gzip", "deflate"] as const;
export type EnvelopeContentEncoding = (typeof ENVELOPE_CONTENT_ENCODINGS)[number];

/** One accepted ingest request. */
export interface Envelope {
  version: typeof ENVELOPE_VERSION;
  /** One per accepted request; a client retry gets a new one. */
  id: string;
  /** The unit of order. */
  projectId: string;
  /** At accept, for routing and archives. Process reads the project's current one. */
  organizationId: string;
  /** The API key's row id. Never the key or its hash. */
  keyId: string;
  /** The key's policy at accept (`ApiKeyPolicy`). */
  keyPolicy: { appendOnlyIngest: boolean; sharedKeyLimits: boolean };
  signal: EnvelopeSignal;
  /** Resolved by accept. `events` is always JSON. */
  contentType: EnvelopeContentType;
  /** Resolved by accept (`x-gzip` is `gzip`). `events` is always `identity`. */
  contentEncoding: EnvelopeContentEncoding;
  /** Unix milliseconds when accept took the request: the clock of process. */
  receivedAt: number;
  /** The request body as received, not decoded. */
  body: Uint8Array;
}

/**
 * `malformed`: not a valid envelope of a known version. `unsupported_version`: from a newer
 * writer. Neither can pass on a retry.
 */
export type EnvelopeErrorReason = "malformed" | "unsupported_version";

/** The message names the field and never holds its value, so it is safe to log and keep. */
export class EnvelopeError extends Error {
  readonly reason: EnvelopeErrorReason;

  constructor(reason: EnvelopeErrorReason, message: string) {
    super(message);
    this.name = "EnvelopeError";
    this.reason = reason;
  }
}

export function encodeEnvelope(envelope: Envelope): Uint8Array<ArrayBuffer> {
  checkVersion(envelope.version);
  const header = encodeHeader(readHeader(envelope, "envelope"));
  checkBodySize(envelope.body);

  const frame = new Uint8Array(HEADER_OFFSET + header.byteLength + envelope.body.byteLength);
  frame.set(MAGIC, 0);
  frame[VERSION_OFFSET] = ENVELOPE_VERSION;
  new DataView(frame.buffer).setUint32(HEADER_LENGTH_OFFSET, header.byteLength);
  frame.set(header, HEADER_OFFSET);
  frame.set(envelope.body, HEADER_OFFSET + header.byteLength);
  return frame;
}

/** Throws {@link EnvelopeError}. The body is a copy, so the caller may reuse its buffer. */
export function decodeEnvelope(frame: Uint8Array): Envelope {
  if (MAGIC.some((byte, index) => frame[index] !== byte)) {
    throw malformed("envelope does not start with RTLE");
  }
  // Before the rest: a newer version may change everything after this byte.
  if (frame.byteLength <= VERSION_OFFSET) throw malformed("envelope is truncated");
  checkVersion(frame[VERSION_OFFSET]);

  if (frame.byteLength < HEADER_OFFSET) throw malformed("envelope is truncated");
  const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
    HEADER_LENGTH_OFFSET,
  );
  if (headerLength > MAX_HEADER_BYTES) {
    throw malformed(`envelope header is over ${MAX_HEADER_BYTES} bytes`);
  }
  const bodyOffset = HEADER_OFFSET + headerLength;
  if (frame.byteLength < bodyOffset) throw malformed("envelope is truncated");

  const header = decodeHeader(frame.subarray(HEADER_OFFSET, bodyOffset));
  const body = new Uint8Array(frame.subarray(bodyOffset));
  checkBodySize(body);
  return { version: ENVELOPE_VERSION, ...header, body };
}

type Header = Omit<Envelope, "version" | "body">;

/** Every header field, checked, in the order that the header has on the wire. */
function readHeader(value: unknown, label: string): Header {
  const raw = asRecord(value, label);
  const policy = asRecord(raw.keyPolicy, `${label} keyPolicy`);
  const header: Header = {
    id: uuid(raw.id, `${label} id`),
    projectId: uuid(raw.projectId, `${label} projectId`),
    organizationId: uuid(raw.organizationId, `${label} organizationId`),
    keyId: uuid(raw.keyId, `${label} keyId`),
    keyPolicy: {
      appendOnlyIngest: bool(policy.appendOnlyIngest, `${label} keyPolicy.appendOnlyIngest`),
      sharedKeyLimits: bool(policy.sharedKeyLimits, `${label} keyPolicy.sharedKeyLimits`),
    },
    signal: oneOf(ENVELOPE_SIGNALS, raw.signal, `${label} signal`),
    contentType: oneOf(ENVELOPE_CONTENT_TYPES, raw.contentType, `${label} contentType`),
    contentEncoding: oneOf(
      ENVELOPE_CONTENT_ENCODINGS,
      raw.contentEncoding,
      `${label} contentEncoding`,
    ),
    receivedAt: unixMs(raw.receivedAt, `${label} receivedAt`),
  };
  if (header.signal === "events" && header.contentType !== "application/json") {
    throw malformed(`${label} contentType must be application/json for events`);
  }
  if (header.signal === "events" && header.contentEncoding !== "identity") {
    throw malformed(`${label} contentEncoding must be identity for events`);
  }
  return header;
}

function encodeHeader(header: Header): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(header));
}

function decodeHeader(bytes: Uint8Array): Header {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // The parser's message quotes the input.
    throw malformed("envelope header is not JSON");
  }
  const header = readHeader(value, "envelope header");
  // Order, whitespace, unknown and repeated fields: anything that another writer would lose.
  const canonical = encodeHeader(header);
  if (
    canonical.byteLength !== bytes.byteLength ||
    canonical.some((byte, index) => byte !== bytes[index])
  ) {
    throw malformed("envelope header is not in its one encoding");
  }
  return header;
}

function checkVersion(version: number): void {
  if (version === ENVELOPE_VERSION) return;
  if (version > ENVELOPE_VERSION) {
    throw new EnvelopeError(
      "unsupported_version",
      `envelope version ${version} is newer than this process: it reads up to ${ENVELOPE_VERSION}`,
    );
  }
  throw malformed(`envelope version ${version} does not exist`);
}

function checkBodySize(body: Uint8Array): void {
  if (body.byteLength > MAX_ENVELOPE_BODY_BYTES) {
    throw malformed(`envelope body is over ${MAX_ENVELOPE_BODY_BYTES} bytes`);
  }
}

function malformed(message: string): EnvelopeError {
  return new EnvelopeError("malformed", message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw malformed(`${label} is not a lowercase UUID`);
  }
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw malformed(`${label} is not a boolean`);
  return value;
}

function oneOf<const T extends string>(allowed: readonly T[], value: unknown, label: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw malformed(`${label} is not one of ${allowed.join(", ")}`);
  return found;
}

function unixMs(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_RECEIVED_AT
  ) {
    throw malformed(`${label} is not a Unix time in milliseconds`);
  }
  return value === 0 ? 0 : value;
}
