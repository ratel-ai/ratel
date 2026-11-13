import assert from "node:assert/strict";
import { test } from "node:test";
import { readBodyWithCap } from "./read-body-with-cap";
import { chunkedCountingBody } from "./test-support";

const MiB = 1024 * 1024;

/** A chunked request whose body is produced on demand, counting every pull so
 * tests can prove how much of the stream a reader actually consumed. */
function chunkedRequest(opts: { chunkBytes: number; totalBytes: number }) {
  const { stream, counters } = chunkedCountingBody(opts);
  const request = new Request("https://cloud.ratel.sh/api/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, counters };
}

test("a chunked body crossing the cap is rejected after ~cap bytes, not fully buffered", async () => {
  const cap = 4 * MiB;
  const { request, counters } = chunkedRequest({ chunkBytes: MiB, totalBytes: 8 * MiB });

  const result = await readBodyWithCap(request, cap);

  assert.deepEqual(result, { ok: false });
  assert.ok(
    counters.enqueuedBytes <= cap + 2 * MiB,
    `stream should stop near the cap; enqueued ${counters.enqueuedBytes} bytes`,
  );
});

test("a declared content-length over the cap rejects without pulling the stream", async () => {
  const { request, counters } = chunkedRequest({ chunkBytes: MiB, totalBytes: 8 * MiB });
  request.headers.set("content-length", String(8 * MiB));

  const result = await readBodyWithCap(request, 4 * MiB);

  assert.deepEqual(result, { ok: false });
  assert.equal(counters.pulls, 0);
});

test("bodies under the cap round-trip intact", async () => {
  const request = new Request("https://cloud.ratel.sh/api/v1/events", {
    method: "POST",
    body: JSON.stringify({ events: [] }),
  });

  const result = await readBodyWithCap(request, 4 * MiB);

  assert.ok(result.ok);
  assert.equal(new TextDecoder().decode(result.bytes), '{"events":[]}');
});

test("a body exactly at the cap is accepted", async () => {
  const cap = 3 * MiB;
  const { request } = chunkedRequest({ chunkBytes: MiB, totalBytes: cap });

  const result = await readBodyWithCap(request, cap);

  assert.ok(result.ok);
  assert.equal(result.bytes.byteLength, cap);
});

test("a bodiless request reads as zero bytes", async () => {
  const request = new Request("https://cloud.ratel.sh/api/v1/events", { method: "POST" });

  const result = await readBodyWithCap(request, 4 * MiB);

  assert.ok(result.ok);
  assert.equal(result.bytes.byteLength, 0);
});
