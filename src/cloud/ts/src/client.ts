import { MAX_BATCH, type SendResult, safeOnError, sendEventBatch } from "./transport.js";
import type { Event } from "./types.js";
import { validate } from "./validate.js";

/**
 * An {@link Event} as accepted by {@link RatelCloud.sendEvent}: `ts` may be omitted,
 * in which case the client stamps the current time. Everything else is identical.
 * The canonical wire schema still requires `ts` — this is client-side sugar for
 * the common live-recording case; pass `ts` explicitly for replayed or
 * backfilled events.
 */
export type EventInput = Omit<Event, "ts"> & { ts?: string };

export interface RatelCloudOptions {
  /** Ingest endpoint URL, e.g. `https://cloud.ratel.ai/api/v1/events`. */
  endpoint: string;
  /** Project API key, sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  /** Events per request. Default 100; capped at {@link MAX_BATCH}. */
  batchSize?: number;
  /** Auto-flush cadence in ms. Default 5_000; `0` disables the timer. */
  flushIntervalMs?: number;
  /** Validate each event on `sendEvent`, dropping invalid ones. Default true. */
  validateEvents?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
  /** Injectable for testing; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Clock for the `sendEvent` `ts` default; defaults to `() => new Date().toISOString()`. */
  now?: () => string;
  /** Observe dropped events and swallowed transport errors. */
  onError?: (err: unknown) => void;
}

/**
 * Non-blocking, best-effort client for Ratel Cloud telemetry. `sendEvent` validates
 * and enqueues without awaiting the network; batches flush on a timer, on reaching
 * `batchSize`, or explicitly via `flush`. Nothing here throws into the host app.
 */
export class RatelCloud {
  private readonly opts: RatelCloudOptions;
  private readonly batchSize: number;
  private readonly now: () => string;
  private queue: Event[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> = Promise.resolve();

  constructor(opts: RatelCloudOptions) {
    this.opts = opts;
    this.batchSize = Math.min(opts.batchSize ?? 100, MAX_BATCH);
    this.now = opts.now ?? (() => new Date().toISOString());

    const interval = opts.flushIntervalMs ?? 5_000;
    if (interval > 0) {
      const timer = setInterval(() => void this.flush(), interval);
      // Don't keep the process alive just for telemetry (Node-only; no-op elsewhere).
      (timer as unknown as { unref?: () => void }).unref?.();
      this.timer = timer;
    }
  }

  /**
   * Validate (unless disabled) and enqueue an event. `ts` is stamped with the
   * current time when omitted. Never blocks or throws.
   */
  sendEvent(event: EventInput): void {
    // Stamp only when omitted; a present-but-empty `ts` is left to fail validation.
    const stamped: Event = event.ts === undefined ? { ...event, ts: this.now() } : (event as Event);
    if (this.opts.validateEvents !== false) {
      const result = validate(stamped);
      if (!result.ok) {
        safeOnError(
          this.opts.onError,
          new Error(`ratel-cloud: dropped invalid event: ${describe(result.issues)}`),
        );
        return;
      }
    }
    this.queue.push(stamped);
    if (this.queue.length >= this.batchSize) {
      void this.flush();
    }
  }

  /** Drain the queue, sending in batches. Resolves when the queue is empty. */
  flush(): Promise<void> {
    // Serialize concurrent flushes so batches don't interleave or double-send. The
    // `.catch` keeps a single rejected drain from permanently poisoning the chain (so
    // every later flush would silently no-op) — `drain` shouldn't reject, but telemetry
    // must fail open, not brick the client.
    this.flushing = this.flushing
      .then(() => this.drain())
      .catch((err) => safeOnError(this.opts.onError, err));
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.batchSize);
      const result: SendResult = await sendEventBatch(batch, {
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
