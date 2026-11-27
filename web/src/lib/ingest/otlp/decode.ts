import protobuf from "protobufjs";
import { keyValuesToMap } from "./anyvalue";
import descriptor from "./proto/otlp-trace.descriptor.json";
import type {
  DecodedEvent,
  DecodedLink,
  DecodedSpan,
  IExportTraceServiceRequest,
  RawSpan,
  RawSpanEvent,
  RawSpanLink,
} from "./types";

/**
 * Decode an OTLP `ExportTraceServiceRequest` (protobuf or OTLP/JSON) into
 * normalized `DecodedSpan`s.
 *
 * The protobuf schema is loaded from a checked-in JSON descriptor via
 * `Root.fromJSON` — a plain import, so Next's function bundler always includes it
 * (reading the `.proto` at runtime is unreliable on Vercel). Both wire formats
 * decode to the same camelCase object shape, then `normalize()` collapses ids to
 * hex, `fixed64` unix-nanos to epoch-ms, and `KeyValue[]` to attribute maps so
 * nothing downstream sees the transport.
 */

const root = protobuf.Root.fromJSON(descriptor as protobuf.INamespace);
const RequestType = root.lookupType("ratel.otlp.ExportTraceServiceRequest");

/** Thrown when a body can't be parsed as an OTLP request — surfaced as HTTP 400. */
export class OtlpDecodeError extends Error {}

/** Decode a protobuf (`application/x-protobuf`) OTLP export request. */
export function decodeProtobuf(bytes: Uint8Array): DecodedSpan[] {
  let request: IExportTraceServiceRequest;
  try {
    const msg = RequestType.decode(bytes);
    request = RequestType.toObject(msg, {
      longs: String, // fixed64/int64 → decimal strings (BigInt-safe below)
      bytes: Array, // ids → number[]; hex-encoded in normalize
      defaults: false,
      arrays: true,
      enums: Number,
    }) as IExportTraceServiceRequest;
  } catch (err) {
    throw new OtlpDecodeError(`protobuf decode failed: ${(err as Error).message}`);
  }
  return normalize(request);
}

/** Decode an OTLP/JSON (`application/json`) export request. */
export function decodeJson(bytes: Uint8Array): DecodedSpan[] {
  let request: IExportTraceServiceRequest;
  try {
    request = JSON.parse(Buffer.from(bytes).toString("utf8")) as IExportTraceServiceRequest;
  } catch (err) {
    throw new OtlpDecodeError(`JSON parse failed: ${(err as Error).message}`);
  }
  if (typeof request !== "object" || request === null) {
    throw new OtlpDecodeError("OTLP/JSON body must be an object.");
  }
  return normalize(request);
}

/** Decode by content-type. Unknown/absent type falls back to protobuf (the SDK default). */
export function decodeOtlp(contentType: string, bytes: Uint8Array): DecodedSpan[] {
  return contentType.includes("application/json") ? decodeJson(bytes) : decodeProtobuf(bytes);
}

/**
 * An export request as OTLP/JSON with every field kept (RC-454): trace state,
 * links, status message, scope version, nanosecond times as decimal strings,
 * doubles as doubles. Ids are lowercase hex; a protobuf `bytesValue` is base64.
 */
export function decodeOtlpRequest(
  contentType: string,
  bytes: Uint8Array,
): IExportTraceServiceRequest {
  let request: IExportTraceServiceRequest;
  if (contentType.includes("application/json")) {
    request = JSON.parse(Buffer.from(bytes).toString("utf8")) as IExportTraceServiceRequest;
    if (typeof request !== "object" || request === null)
      throw new OtlpDecodeError("OTLP/JSON body must be an object.");
  } else {
    request = RequestType.toObject(RequestType.decode(bytes), {
      longs: String,
      bytes: String,
      defaults: false,
      arrays: true,
      enums: Number,
    }) as IExportTraceServiceRequest;
  }
  for (const span of (request.resourceSpans ?? []).flatMap((rs) =>
    (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []),
  )) {
    hexIds(span);
    for (const link of span.links ?? []) hexIds(link);
  }
  return request;
}

/** An export with its spans edited in place, in the order they decode, in the format it came in. */
export function editOtlpExport(
  transport: "json" | "protobuf",
  bytes: Uint8Array,
  edit: (request: IExportTraceServiceRequest) => void,
): Uint8Array {
  if (transport === "json") {
    const request = JSON.parse(Buffer.from(bytes).toString("utf8")) as IExportTraceServiceRequest;
    edit(request);
    return new TextEncoder().encode(JSON.stringify(request));
  }
  const message = RequestType.decode(bytes);
  edit(message as unknown as IExportTraceServiceRequest);
  return RequestType.encode(message).finish();
}

/** Ids as lowercase hex: protobufjs gives base64 (`bytes: String`), and OTLP/JSON may send either. */
function hexIds(item: Pick<RawSpan, "traceId" | "spanId" | "parentSpanId">): void {
  for (const key of ["traceId", "spanId", "parentSpanId"] as const) {
    if (item[key] !== undefined) item[key] = toHexId(item[key]);
  }
}

/* --- normalization ------------------------------------------------------------ */

function normalize(request: IExportTraceServiceRequest): DecodedSpan[] {
  const out: DecodedSpan[] = [];
  for (const rs of request.resourceSpans ?? []) {
    const resourceAttributes = keyValuesToMap(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      const scopeName = ss.scope?.name ?? null;
      for (const span of ss.spans ?? []) {
        out.push(normalizeSpan(span, resourceAttributes, scopeName));
      }
    }
  }
  return out;
}

function normalizeSpan(
  span: RawSpan,
  resourceAttributes: DecodedSpan["resourceAttributes"],
  scopeName: string | null,
): DecodedSpan {
  return {
    traceId: toHexId(span.traceId),
    spanId: toHexId(span.spanId),
    parentSpanId: emptyToNull(toHexId(span.parentSpanId)),
    name: span.name ?? "",
    kind: typeof span.kind === "number" ? span.kind : 0,
    startUnixMs: toMs(span.startTimeUnixNano),
    endUnixMs: toMs(span.endTimeUnixNano),
    attributes: keyValuesToMap(span.attributes),
    events: (span.events ?? []).map(normalizeEvent),
    links: (span.links ?? []).map(normalizeLink),
    statusCode: span.status?.code ?? 0,
    resourceAttributes,
    scopeName,
  };
}

function normalizeEvent(ev: RawSpanEvent): DecodedEvent {
  return {
    name: ev.name ?? "",
    timeUnixMs: toMs(ev.timeUnixNano),
    attributes: keyValuesToMap(ev.attributes),
  };
}

function normalizeLink(link: RawSpanLink): DecodedLink {
  return {
    traceId: toHexId(link.traceId),
    spanId: toHexId(link.spanId),
    attributes: keyValuesToMap(link.attributes),
  };
}

/** Bytes / hex / base64 id → lowercase hex. */
export function toHexId(raw: string | Uint8Array | number[] | undefined): string {
  if (raw == null) return "";
  if (typeof raw !== "string") return Buffer.from(raw as Uint8Array).toString("hex");
  // A 16/32-char pure-hex string is already hex (the JS OTLP/JSON exporter emits
  // hex ids); anything else is standard protobuf-JSON base64 bytes.
  if (/^[0-9a-f]+$/i.test(raw) && (raw.length === 16 || raw.length === 32)) {
    return raw.toLowerCase();
  }
  return Buffer.from(raw, "base64").toString("hex");
}

function emptyToNull(hex: string): string | null {
  return hex.length > 0 ? hex : null;
}

/**
 * unix-nanos (decimal string or number) → epoch milliseconds, exact to the ms.
 * A digit string is truncated by dropping its last 6 chars (÷1e6) so nanosecond
 * magnitudes never overflow a JS number and no precision is lost at the ms scale.
 */
export function toMs(nano: string | number | undefined): number {
  if (nano == null) return 0;
  if (typeof nano === "number") return Math.floor(nano / 1e6);
  if (/^\d+$/.test(nano)) {
    return nano.length > 6 ? Number(nano.slice(0, -6)) : 0;
  }
  const n = Number(nano);
  return Number.isFinite(n) ? Math.floor(n / 1e6) : 0;
}
