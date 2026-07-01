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
 * POST a batch of events to the ingest endpoint. Best-effort: retries transient
 * failures with exponential backoff + jitter, drops on permanent 4xx, and
 * **never throws** — failures are reported via `onError` and a falsy result.
 */
export async function sendEventBatch(events: Event[], opts: TransportOptions): Promise<SendResult> {
  if (events.length === 0) return { ok: true, accepted: 0 };

  const doFetch = opts.fetch ?? fetch;
  const maxRetries = opts.maxRetries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const sleep = opts.sleep ?? defaultSleep;
  const body = JSON.stringify(events);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await doFetch(opts.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        const accepted = await readAccepted(response, events.length);
        return { ok: true, accepted, status: response.status };
      }

      if (!isRetryableStatus(response.status) || attempt === maxRetries) {
        opts.onError?.(new Error(`ratel-cloud: ingest rejected with ${response.status}`));
        return { ok: false, accepted: 0, status: response.status };
      }
    } catch (err) {
      if (attempt === maxRetries) {
        opts.onError?.(err);
        return { ok: false, accepted: 0 };
      }
    }

    await sleep(backoffDelay(baseDelayMs, attempt));
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

function backoffDelay(baseDelayMs: number, attempt: number): number {
  const exponential = baseDelayMs * 2 ** attempt;
  // Full jitter in the top half of the window keeps a floor while spreading load.
  return exponential * (0.5 + Math.random() * 0.5);
}
