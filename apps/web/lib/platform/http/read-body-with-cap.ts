/**
 * Bounded request-body reading for the API-key ingest handlers.
 *
 * A declared Content-Length above the cap fast-rejects before touching the
 * stream, and everything else is read incrementally with a running byte count —
 * the stream is cancelled the moment the cap is crossed. This is what keeps one
 * authenticated chunked request (which carries no Content-Length) from
 * buffering an arbitrarily large body into memory before the 413.
 */

/** Outcome of reading a request body under a hard byte cap. */
export type CappedBodyResult = { ok: true; bytes: Uint8Array } | { ok: false };

/** Read `request`'s body, refusing to buffer more than `maxBytes` bytes.
 * Stream read errors propagate to the caller, exactly like `arrayBuffer()`. */
export async function readBodyWithCap(
  request: Request,
  maxBytes: number,
): Promise<CappedBodyResult> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false };
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { ok: true, bytes: concat(chunks, total) };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
