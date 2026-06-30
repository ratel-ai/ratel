import { MAX_BATCH, type SendResult, sendBatch } from "./transport.js";
import type { Event } from "./types.js";
import { validate } from "./validate.js";

export interface RatelCloudOptions {
  /** Ingest endpoint URL, e.g. `https://cloud.ratel.ai/api/v1/events`. */
  endpoint: string;
  /** Project API key, sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  /** Events per request. Default 100; capped at {@link MAX_BATCH}. */
  batchSize?: number;
  /** Auto-flush cadence in ms. Default 5_000; `0` disables the timer. */
  flushIntervalMs?: number;
  /** Validate each event on `record`, dropping invalid ones. Default true. */
  validateEvents?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
  /** Injectable for testing; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Observe dropped events and swallowed transport errors. */
  onError?: (err: unknown) => void;
}

/**
 * Non-blocking, best-effort client for Ratel Cloud telemetry. `record` validates
 * and enqueues without awaiting the network; batches flush on a timer, on reaching
 * `batchSize`, or explicitly via `flush`. Nothing here throws into the host app.
 */
export class RatelCloud {
  private readonly opts: RatelCloudOptions;
  private readonly batchSize: number;
  private queue: Event[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> = Promise.resolve();

  constructor(opts: RatelCloudOptions) {
    this.opts = opts;
    this.batchSize = Math.min(opts.batchSize ?? 100, MAX_BATCH);

    const interval = opts.flushIntervalMs ?? 5_000;
    if (interval > 0) {
      const timer = setInterval(() => void this.flush(), interval);
      // Don't keep the process alive just for telemetry (Node-only; no-op elsewhere).
      (timer as unknown as { unref?: () => void }).unref?.();
      this.timer = timer;
    }
  }

  /** Validate (unless disabled) and enqueue an event. Never blocks or throws. */
  record(event: Event): void {
    if (this.opts.validateEvents !== false) {
      const result = validate(event);
      if (!result.ok) {
        this.opts.onError?.(
          new Error(`ratel-cloud: dropped invalid event: ${describe(result.issues)}`),
        );
        return;
      }
    }
    this.queue.push(event);
    if (this.queue.length >= this.batchSize) {
      void this.flush();
    }
  }

  /** Drain the queue, sending in batches. Resolves when the queue is empty. */
  flush(): Promise<void> {
    // Serialize concurrent flushes so batches don't interleave or double-send.
    this.flushing = this.flushing.then(() => this.drain());
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.batchSize);
      const result: SendResult = await sendBatch(batch, {
        endpoint: this.opts.endpoint,
        apiKey: this.opts.apiKey,
        fetch: this.opts.fetch,
        maxRetries: this.opts.maxRetries,
        timeoutMs: this.opts.timeoutMs,
        onError: this.opts.onError,
      });
      // Best-effort: a rejected batch is dropped, not requeued (avoids unbounded
      // growth and head-of-line blocking on a persistently failing endpoint).
      if (!result.ok) break;
    }
  }

  /** Stop the timer and flush whatever remains. */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }
}

function describe(issues: { path: string; message: string }[]): string {
  return issues.map((i) => `${i.path} ${i.message}`).join("; ");
}
