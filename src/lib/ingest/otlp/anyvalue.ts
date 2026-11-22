import type { AttrMap, AttrValue, RawAnyValue, RawKeyValue } from "./types";

/**
 * OTLP `AnyValue` → plain JS, and typed readers over the resulting attribute map.
 *
 * An `AnyValue` is a tagged union (`stringValue | boolValue | intValue |
 * doubleValue | arrayValue | kvlistValue | bytesValue`); both the protobuf decode
 * and OTLP/JSON produce that camelCase shape. `int64` rides the wire as a decimal
 * string (protobuf JSON mapping + protobufjs `longs:String`), so `intValue` is
 * coerced through `Number`. Reads are defensive: a wrong-typed or absent value
 * yields `undefined` rather than throwing, because ingest no longer Zod-gates the
 * payload.
 */

/** Flatten one OTLP `AnyValue` to a JS value (null when empty/unset). */
export function anyValueToJs(v: RawAnyValue | undefined | null): AttrValue {
  if (v == null) return null;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (v.intValue !== undefined) {
    const n = typeof v.intValue === "number" ? v.intValue : Number(v.intValue);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v.doubleValue === "number") return v.doubleValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(anyValueToJs);
  if (v.kvlistValue) return keyValuesToMap(v.kvlistValue.values ?? []);
  if (v.bytesValue !== undefined) return bytesToString(v.bytesValue);
  return null;
}

function bytesToString(b: string | Uint8Array | number[]): string {
  if (typeof b === "string") return b; // OTLP/JSON: already base64
  return Buffer.from(b as Uint8Array).toString("base64");
}

/** Build an attribute map from a repeated `KeyValue` list. Later keys win. */
export function keyValuesToMap(kvs: RawKeyValue[] | undefined | null): AttrMap {
  const out: AttrMap = {};
  if (!kvs) return out;
  for (const kv of kvs) {
    if (kv?.key) out[kv.key] = anyValueToJs(kv.value);
  }
  return out;
}

/* --- typed readers ------------------------------------------------------------ */

export function attrString(map: AttrMap, key: string): string | undefined {
  const v = map[key];
  return typeof v === "string" ? v : undefined;
}

export function attrNumber(map: AttrMap, key: string): number | undefined {
  const v = map[key];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function attrBool(map: AttrMap, key: string): boolean | undefined {
  const v = map[key];
  return typeof v === "boolean" ? v : undefined;
}

/** Read a string[] attribute, tolerating a single string or a numeric array. */
export function attrStringArray(map: AttrMap, key: string): string[] | undefined {
  const v = map[key];
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : String(x)));
  if (typeof v === "string") return [v];
  return undefined;
}

/**
 * Read a structured attribute (e.g. `gen_ai.input.messages`) that instrumentations
 * encode either natively (array/kvlist → already JS) or as a JSON string. Returns
 * the parsed JS value, or undefined when absent/unparseable.
 */
export function attrStructured(map: AttrMap, key: string): AttrValue | undefined {
  const v = map[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as AttrValue;
    } catch {
      return undefined;
    }
  }
  return v;
}
