/** Test double: a chunked body stream that counts pulls and enqueued bytes, so
 * tests can prove how much of a request body a handler actually consumed. */

export interface ChunkedBodyCounters {
  pulls: number;
  enqueuedBytes: number;
}

export function chunkedCountingBody(opts: { chunkBytes: number; totalBytes: number }): {
  stream: ReadableStream<Uint8Array>;
  counters: ChunkedBodyCounters;
} {
  const counters: ChunkedBodyCounters = { pulls: 0, enqueuedBytes: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (counters.enqueuedBytes >= opts.totalBytes) {
          controller.close();
          return;
        }
        counters.pulls += 1;
        const size = Math.min(opts.chunkBytes, opts.totalBytes - counters.enqueuedBytes);
        counters.enqueuedBytes += size;
        controller.enqueue(new Uint8Array(size).fill(120));
      },
    },
    // Without this the stream primes itself with one eager pull at construction,
    // which would make "never pulled" assertions impossible.
    { highWaterMark: 0 },
  );
  return { stream, counters };
}
