import { Reader } from "protobufjs";
import { OtlpDecodeError } from "./decode";
import type { OtlpTransport } from "./http";

const JSON_PATH = {
  traces: ["resourceSpans", "scopeSpans", "spans"],
  logs: ["resourceLogs", "scopeLogs", "logRecords"],
} as const;

/**
 * Both export requests nest their items in the same fields: `resource_*` (1) of the request,
 * `scope_*` (2) of a resource, the items (2) of a scope.
 */
const PROTOBUF_PATH = [1, 2, 2] as const;
const LENGTH_DELIMITED = 2;

/**
 * How many spans or log records an export holds, by a walk of its outer structure: nothing of an
 * item is read. Throws {@link OtlpDecodeError} for a body that cannot be counted.
 */
export function countOtlpItems(
  signal: "traces" | "logs",
  transport: OtlpTransport,
  bytes: Uint8Array,
): number {
  return transport === "json"
    ? countJson(parse(bytes), JSON_PATH[signal])
    : countProtobuf(bytes, PROTOBUF_PATH);
}

function parse(bytes: Uint8Array): unknown {
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new OtlpDecodeError("JSON parse failed");
  }
  if (typeof body !== "object" || body === null) {
    throw new OtlpDecodeError("OTLP/JSON body must be an object.");
  }
  return body;
}

function countJson(value: unknown, [key, ...rest]: readonly string[]): number {
  if (typeof value !== "object" || value === null) {
    throw new OtlpDecodeError(`expected an object around ${key}`);
  }
  const list = (value as Record<string, unknown>)[key] ?? [];
  if (!Array.isArray(list)) throw new OtlpDecodeError(`${key} is not an array`);
  if (rest.length === 0) return list.length;
  return list.reduce<number>((sum, item) => sum + countJson(item, rest), 0);
}

function countProtobuf(bytes: Uint8Array, [field, ...rest]: readonly number[]): number {
  let count = 0;
  try {
    const reader = Reader.create(bytes);
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      if (tag >>> 3 !== field || (tag & 7) !== LENGTH_DELIMITED) {
        reader.skipType(tag & 7);
      } else if (rest.length === 0) {
        reader.skipType(LENGTH_DELIMITED);
        count += 1;
      } else {
        count += countProtobuf(reader.bytes(), rest);
      }
    }
  } catch (error) {
    if (error instanceof OtlpDecodeError) throw error;
    throw new OtlpDecodeError("protobuf walk failed");
  }
  return count;
}
