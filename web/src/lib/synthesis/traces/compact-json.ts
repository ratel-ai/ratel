import { deflateSync, inflateSync } from "fflate";

/** JSON as base64url of deflated UTF-8, for an address. Safe for the browser. */

export function pack(value: unknown): string {
  const bytes = deflateSync(new TextEncoder().encode(JSON.stringify(value)), { level: 9 });
  const text = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
  return text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The JSON of an address, or null for a damaged one or one over `maxBytes`. */
export function unpack(encoded: string, maxBytes: number): unknown {
  try {
    const bytes = base64Bytes(encoded);
    // Into a buffer of the most it may be: a longer one is damaged.
    return jsonOfBytes(inflateSync(bytes, { out: new Uint8Array(maxBytes) }));
  } catch {
    return null;
  }
}

/** The JSON of an address that is not deflated. */
export function unpackPlain(encoded: string): unknown {
  try {
    return jsonOfBytes(base64Bytes(encoded));
  } catch {
    return null;
  }
}

function base64Bytes(encoded: string): Uint8Array {
  const text = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function jsonOfBytes(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
