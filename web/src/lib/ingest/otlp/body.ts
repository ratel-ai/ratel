import { gunzipSync, inflateSync } from "node:zlib";
import type { EnvelopeContentEncoding } from "@/lib/ingest/queue/envelope";

/** Reject bodies above this size, before decoding. */
export const MAX_BODY_BYTES = 4_000_000;
/** A compressed body may expand to this much, and no further (a small zip bomb stops here). */
export const MAX_INFLATED_BYTES = 4 * MAX_BODY_BYTES;

/** Cap spans decoded from one export so a giant batch can't stall the request. */
export const MAX_SPANS = 5_000;
export const MAX_LOG_RECORDS = 5_000;

export type InflateResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "unsupported" | "malformed" | "too_large" };

/** The body as sent, gunzipped or inflated when `Content-Encoding` says so, under {@link MAX_INFLATED_BYTES}. */
export function inflateBody(bytes: Uint8Array, contentEncoding: string | null): InflateResult {
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return { ok: true, bytes };
  if (encoding !== "gzip" && encoding !== "x-gzip" && encoding !== "deflate")
    return { ok: false, reason: "unsupported" };
  try {
    const options = { maxOutputLength: MAX_INFLATED_BYTES };
    const out = encoding === "deflate" ? inflateSync(bytes, options) : gunzipSync(bytes, options);
    return { ok: true, bytes: new Uint8Array(out.buffer, out.byteOffset, out.byteLength) };
  } catch (err) {
    return { ok: false, reason: err instanceof RangeError ? "too_large" : "malformed" };
  }
}

export function isGzipEncoding(contentEncoding: string | null): boolean {
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  return encoding === "gzip" || encoding === "x-gzip";
}

/** The encoding a request declares, or null for one that this ingest does not read. */
export function contentEncodingOf(contentEncoding: string | null): EnvelopeContentEncoding | null {
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return "identity";
  if (encoding === "gzip" || encoding === "x-gzip") return "gzip";
  return encoding === "deflate" ? "deflate" : null;
}
