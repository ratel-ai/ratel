import type { TraceSession } from "@ratel-ai/sdk";
import { CloudApiError, CloudAuthError } from "./errors.js";
import type { CloudHttp } from "./http.js";

export interface RejectedTraceEvent {
  index: number;
  error: string;
}

export interface CloudExporterOptions {
  /** How often the timer drains and posts. Default 5s. */
  flushIntervalMs?: number;
  /** Events per POST. Default 500, hard-capped at Cloud's 1000/request. */
  maxBatchSize?: number;
  /** Exporter-side buffer bound while Cloud is unreachable (drop-oldest). Default 10_000. */
  maxBufferedEvents?: number;
  /** Base backoff after a retryable failure; doubles up to `maxBackoffMs`. Default 1s. */
  retryBackoffMs?: number;
  /** Backoff ceiling. Default 30s. */
  maxBackoffMs?: number;
  /** Transport/auth failures land here (flushes never throw from the timer). */
  onError?: (err: Error) => void;
  /** Per-item 202 rejections — logged, never retried. */
  onRejected?: (rejected: RejectedTraceEvent[]) => void;
  /**
   * Opaque id of the customer's end-user this session serves (Cloud's
   * end-user dimension), stamped onto every buffered envelope that doesn't
   * already carry its own `end_user_id`. There is no per-event override at the
   * `TraceSession`/native layer today, so a host serving multiple end-users
   * from one process should use one `TraceSession` (and exporter) per end-user.
   */
  endUserId?: string;
}

const MAX_BATCH_HARD_CAP = 1000;

interface Envelope extends Record<string, unknown> {
  session_id: string;
  ts: number;
  seq?: number;
}

/**
 * Drain-timer exporter (ADR-0013): polls the shared `TraceSession` buffer and
 * POSTs batches to `POST /api/v1/trace-events`. Retries are idempotent via
 * `client_event_id = "<session_id>:<seq>"`; the session should have exactly
 * one drainer — this exporter.
 */
export class CloudExporter {
  private readonly session: TraceSession;
  private readonly http: CloudHttp;
  private readonly flushIntervalMs: number;
  private batchSize: number;
  private readonly maxBufferedEvents: number;
  private readonly retryBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly onError?: (err: Error) => void;
  private readonly onRejected?: (rejected: RejectedTraceEvent[]) => void;
  private readonly endUserId?: string;

  private pending: Envelope[] = [];
  private dropped = 0;
  private backoffUntil = 0;
  private currentBackoffMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | undefined;
  private readonly beforeExitHook = (): void => {
    void this.flush();
  };

  constructor(session: TraceSession, http: CloudHttp, opts: CloudExporterOptions = {}) {
    this.session = session;
    this.http = http;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5_000;
    this.batchSize = Math.min(opts.maxBatchSize ?? 500, MAX_BATCH_HARD_CAP);
    this.maxBufferedEvents = opts.maxBufferedEvents ?? 10_000;
    this.retryBackoffMs = opts.retryBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.currentBackoffMs = this.retryBackoffMs;
    if (opts.onError) this.onError = opts.onError;
    if (opts.onRejected) this.onRejected = opts.onRejected;
    if (opts.endUserId) this.endUserId = opts.endUserId;
  }

  /** Begin periodic flushing (unref'd — won't hold the process open). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch(() => {});
    }, this.flushIntervalMs);
    this.timer.unref?.();
    process.once("beforeExit", this.beforeExitHook);
  }

  isRunning(): boolean {
    return this.timer !== undefined;
  }

  /** Events dropped to the exporter buffer bound (session-side drops are separate). */
  droppedCount(): number {
    return this.dropped;
  }

  /** Drain + send now. Transport failures go to `onError`, never throw. */
  flush(): Promise<void> {
    // Serialize concurrent flushes (timer tick vs explicit call).
    const run = (this.flushing ?? Promise.resolve()).then(() => this.doFlush());
    this.flushing = run.catch(() => {});
    return run;
  }

  /** Stop the timer and perform a final best-effort flush. */
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    process.removeListener("beforeExit", this.beforeExitHook);
    await this.flush();
  }

  private stopOnAuthFailure(err: CloudAuthError): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    process.removeListener("beforeExit", this.beforeExitHook);
    this.onError?.(err);
  }

  private async doFlush(): Promise<void> {
    this.buffer(this.session.drain() as Envelope[]);
    if (Date.now() < this.backoffUntil) return;

    while (this.pending.length > 0) {
      const batch = this.pending.slice(0, this.batchSize);
      let response: Response;
      try {
        response = await this.http.request("/api/v1/trace-events", {
          method: "POST",
          body: JSON.stringify(batch),
        });
      } catch (err) {
        if (err instanceof CloudAuthError) {
          this.stopOnAuthFailure(err);
          return;
        }
        this.scheduleRetry(err as Error);
        return;
      }

      if (response.status === 413 && this.batchSize > 1) {
        // Payload too large: halve and retry immediately with smaller chunks.
        this.batchSize = Math.max(1, Math.floor(this.batchSize / 2));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        this.scheduleRetry(
          new CloudApiError(`trace-events flush failed (HTTP ${response.status})`, response.status),
        );
        return;
      }
      if (!response.ok && response.status !== 202) {
        // Unexpected 4xx: the batch will never be accepted — drop it, report.
        this.pending = this.pending.slice(batch.length);
        this.onError?.(
          new CloudApiError(
            `trace-events flush rejected (HTTP ${response.status})`,
            response.status,
          ),
        );
        continue;
      }

      this.pending = this.pending.slice(batch.length);
      this.currentBackoffMs = this.retryBackoffMs;
      const payload = (await response.json().catch(() => undefined)) as
        | { rejected?: RejectedTraceEvent[] }
        | undefined;
      if (payload?.rejected?.length) {
        this.onRejected?.(payload.rejected);
      }
    }
  }

  private buffer(events: Envelope[]): void {
    for (const envelope of events) {
      const endUserId = (envelope.end_user_id as string | undefined) ?? this.endUserId;
      this.pending.push({
        ...envelope,
        ...(endUserId !== undefined ? { end_user_id: endUserId } : {}),
        client_event_id: `${envelope.session_id}:${envelope.seq ?? cryptoFallbackId()}`,
        occurred_at: new Date(envelope.ts).toISOString(),
      });
    }
    if (this.pending.length > this.maxBufferedEvents) {
      const excess = this.pending.length - this.maxBufferedEvents;
      this.pending = this.pending.slice(excess);
      this.dropped += excess;
    }
  }

  private scheduleRetry(err: Error): void {
    this.backoffUntil = Date.now() + this.currentBackoffMs;
    this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.maxBackoffMs);
    this.onError?.(err);
  }
}

/** Legacy-path envelopes (no seq) still need a unique idempotency suffix. */
function cryptoFallbackId(): string {
  return globalThis.crypto.randomUUID();
}
