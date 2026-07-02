import type { Event } from "./types.js";

/** Upper bound the ingest endpoint accepts in one request. */
export const MAX_BATCH = 500;

export interface TransportOptions {
  endpoint: string;
  apiKey: string;
  /** Injectable for testing; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Retries after the first attempt for transient failures. Default 3. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** Base backoff delay in ms (doubled per attempt, jittered). Default 200. */
  baseDelayMs?: number;
  /** Called with any swallowed error so the host can observe failures. */
  onError?: (err: unknown) => void;
  /** Injectable sleep, for testing. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SendResult {
  ok: boolean;
  accepted: number;
  status?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Transient HTTP statuses worth retrying. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Invoke a host-supplied error callback without ever letting it break us. The client
 * is contractually "never throws into the host"; a callback that throws must not defeat
 * that (nor, on the 4xx path, be caught by the retry loop and turn a permanent drop into
 * repeated retries).
 */
export function safeOnError(onError: ((err: unknown) => void) | undefined, err: unknown): void {
  if (!onError) return;
  try {
    onError(err);
  } catch {
    // A broken observer must not propagate — telemetry is best-effort.
  }
}

/**
 * POST a batch of events to the ingest endpoint. Best-effort: retries transient
 * failures with exponential backoff + jitter (honoring `Retry-After` on 429), drops
 * on permanent 4xx, and **never throws** — failures are reported via `onError` and a
 * falsy result.
 */
export async function sendEventBatch(events: Event[], opts: TransportOptions): Promise<SendResult> {
  if (events.length === 0) return { ok: true, accepted: 0 };

  const doFetch = opts.fetch ?? fetch;
  const maxRetries = Math.max(0, opts.maxRetries ?? 3);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const sleep = opts.sleep ?? defaultSleep;
  const body = JSON.stringify(events);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let retryAfterMs: number | undefined;
    try {
      // A fresh AbortController per attempt, cleared as soon as the fetch settles, so no
      // timer lingers after a fast response (unlike `AbortSignal.timeout`).
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await doFetch(opts.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        const accepted = await readAccepted(response, events.length);
        return { ok: true, accepted, status: response.status };
      }

      if (!isRetryableStatus(response.status) || attempt === maxRetries) {
        safeOnError(
          opts.onError,
          new Error(`ratel-cloud: ingest rejected with ${response.status}`),
        );
        return { ok: false, accepted: 0, status: response.status };
      }
      retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    } catch (err) {
      if (attempt === maxRetries) {
        safeOnError(opts.onError, err);
        return { ok: false, accepted: 0 };
      }
    }

    await sleep(retryAfterMs ?? backoffDelay(baseDelayMs, attempt));
  }

  return { ok: false, accepted: 0 };
}

async function readAccepted(response: Response, fallback: number): Promise<number> {
  try {
    const data = (await response.json()) as { accepted?: number };
    return typeof data.accepted === "number" ? data.accepted : fallback;
  } catch {
    return fallback;
  }
}

/** `Retry-After` in delta-seconds → ms; HTTP-date and malformed values fall back to backoff. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function backoffDelay(baseDelayMs: number, attempt: number): number {
  const exponential = baseDelayMs * 2 ** attempt;
  // Full jitter in the top half of the window keeps a floor while spreading load.
  return exponential * (0.5 + Math.random() * 0.5);
}
