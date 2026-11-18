/**
 * Human feedback on an agent's work (thumbs, rating, comment), sent to Ratel
 * Cloud as one item per call: `POST {base}/api/v1/feedback`. Feedback is not a
 * runtime event; it goes straight to the cloud API and nowhere else.
 */

import { createRequire } from "node:module";
import { ambientProjection } from "./telemetry.js";

/** A feedback value: a thumbs boolean, a numeric rating, or a categorical label. */
export type ExperimentalFeedbackValue = boolean | number | string;

/**
 * Options for {@link experimentalFeedback}. Give at least one link: `traceId`,
 * `spanId`, `turnId`, `sessionId` or `endUserId`. Inside a turn scope,
 * `turnId` (when it is a UUID) and `endUserId` default from the turn; inside an
 * active OTel span, `traceId` and `spanId` default from the span.
 */
export interface ExperimentalFeedbackOptions {
  /** Feedback name, e.g. `"thumbs"`, `"rating"` or `"csat"`. */
  name: string;
  /** The value: a boolean, a finite number or a string. */
  value: ExperimentalFeedbackValue;
  /** OTel trace id the feedback is about. */
  traceId?: string;
  /** OTel span id the feedback is about. */
  spanId?: string;
  /** Turn id (a UUID) the feedback is about. */
  turnId?: string;
  /** Your session id. */
  sessionId?: string;
  /** Your pseudonymous id for the end user who gave the feedback. */
  endUserId?: string;
  /** Free-text comment. */
  comment?: string;
  /** Extra JSON fields, as a plain object. */
  metadata?: Record<string, unknown>;
  /** When the feedback was given. Defaults to now. */
  observedAt?: Date | string;
  /** Deduplication key. Defaults to a fresh UUID. Reuse it to retry safely. */
  idempotencyKey?: string;
  /** Ratel API key. Defaults to `RATEL_API_KEY`. */
  apiKey?: string;
  /**
   * Ratel Cloud base URL. Defaults to `RATEL_OTLP_ENDPOINT` without its
   * `/v1/traces` suffix, then `RATEL_URL`, then `https://cloud.ratel.sh`.
   */
  endpoint?: string;
  /** Transport. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Request timeout in milliseconds. Defaults to 10 000. */
  timeoutMs?: number;
}

/** The server's per-item outcome. */
export interface ExperimentalFeedbackItemResult {
  /** Position of the item in the request. */
  index: number;
  /** `"accepted"`, `"duplicate"` or `"rejected"`. */
  status: string;
  /** Id of the stored row, when the item was stored. */
  id?: string;
  /** Why the server rejected the item, e.g. `"bad_turn_id"`. */
  reason?: string;
}

/** The server's 200 body. */
export interface ExperimentalFeedbackResponseBody {
  /** Items the server received. */
  received: number;
  /** Items stored as new rows. */
  accepted: number;
  /** Items whose idempotency key the server already had. */
  duplicate: number;
  /** Items the server refused; see each result's `reason`. */
  rejected: number;
  /** One outcome per item, in request order. */
  results: ExperimentalFeedbackItemResult[];
}

/** The server answered 2xx: the item counts and the full body. */
export interface ExperimentalFeedbackSent {
  /** Always `true`: the request reached the server and it answered 2xx. */
  ok: true;
  /** HTTP status. */
  status: number;
  /** Items stored as new rows. */
  accepted: number;
  /** Items whose idempotency key the server already had. */
  duplicate: number;
  /** Items the server refused. */
  rejected: number;
  /** The server's full answer. */
  body: ExperimentalFeedbackResponseBody;
}

/** The feedback was not sent: a network error, a timeout or a non-2xx answer. */
export interface ExperimentalFeedbackFailed {
  /** Always `false`. */
  ok: false;
  /** HTTP status, when the server answered. */
  status?: number;
  /** What went wrong. */
  error: string;
}

/**
 * What {@link experimentalFeedback} resolves to. It never rejects on a network
 * error, a timeout or a non-2xx answer: those resolve `{ ok: false }`.
 */
export type ExperimentalFeedbackResult = ExperimentalFeedbackSent | ExperimentalFeedbackFailed;

const FEEDBACK_PATH = "/api/v1/feedback";
const DEFAULT_BASE_URL = "https://cloud.ratel.sh";
const DEFAULT_TIMEOUT_MS = 10_000;
const LINK_FIELDS = "traceId, spanId, turnId, sessionId or endUserId";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SDK_HEADER = `@ratel-ai/sdk/${packageVersion()}`;

/**
 * **Experimental**: may change without a major version bump.
 *
 * Send one feedback item to Ratel Cloud. Invalid input and a missing API key
 * throw synchronously, before any request. A network error, a timeout or a
 * non-2xx answer never throws: the promise resolves `{ ok: false }` and the SDK
 * warns on the console.
 *
 * @example
 * ```ts
 * await experimentalFeedback({ name: "thumbs", value: false, traceId });
 * ```
 */
export function experimentalFeedback(
  options: ExperimentalFeedbackOptions,
): Promise<ExperimentalFeedbackResult> {
  const item = feedbackItem(options);
  const apiKey = options.apiKey ?? process.env.RATEL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ratel: experimentalFeedback needs an API key: pass apiKey or set RATEL_API_KEY",
    );
  }
  return send(item, {
    url: resolveBaseUrl(options.endpoint) + FEEDBACK_PATH,
    apiKey,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

/** Validate the options and build the snake_case wire item, ambient ids filled in. */
function feedbackItem(options: ExperimentalFeedbackOptions): Record<string, unknown> {
  const { name, value, metadata, observedAt } = options;
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("ratel: experimentalFeedback name must be a non-empty string");
  }
  if (!isFeedbackValue(value)) {
    throw new TypeError(
      "ratel: experimentalFeedback value must be a boolean, a finite number or a string",
    );
  }
  if (options.turnId !== undefined && !UUID.test(options.turnId)) {
    throw new TypeError("ratel: experimentalFeedback turnId must be a UUID");
  }
  if (metadata !== undefined && !isPlainObject(metadata)) {
    throw new TypeError("ratel: experimentalFeedback metadata must be a plain object");
  }
  const observed = observedAt === undefined ? new Date() : new Date(observedAt);
  if (Number.isNaN(observed.getTime())) {
    throw new TypeError("ratel: experimentalFeedback observedAt must be a valid date");
  }

  const ambient = ambientProjection();
  const ambientTurnId =
    ambient.turnId !== undefined && UUID.test(ambient.turnId) ? ambient.turnId : undefined;
  const links = {
    trace_id: options.traceId ?? ambient.traceId,
    span_id: options.spanId ?? ambient.spanId,
    turn_id: options.turnId ?? ambientTurnId,
    session_id: options.sessionId,
    end_user_id: options.endUserId ?? ambient.endUserId,
  };
  if (Object.values(links).every((link) => !link)) {
    throw new TypeError(`ratel: experimentalFeedback needs at least one link: ${LINK_FIELDS}`);
  }

  return dropUndefined({
    idempotency_key: options.idempotencyKey ?? crypto.randomUUID(),
    ...links,
    name,
    value,
    comment: options.comment,
    metadata,
    observed_at: observed.toISOString(),
  });
}

/** POST one item. Every failure resolves `{ ok: false }` and warns; nothing rejects. */
async function send(
  item: Record<string, unknown>,
  target: { url: string; apiKey: string; fetch: typeof fetch; timeoutMs: number },
): Promise<ExperimentalFeedbackResult> {
  try {
    const response = await target.fetch(target.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${target.apiKey}`,
        "x-ratel-sdk": SDK_HEADER,
      },
      body: JSON.stringify({ feedback: [item] }),
      signal: AbortSignal.timeout(target.timeoutMs),
    });
    if (!response.ok) {
      return failure(`HTTP ${response.status}: ${await safeText(response)}`, response.status);
    }
    const body = (await response.json()) as ExperimentalFeedbackResponseBody;
    for (const result of body.results ?? []) {
      if (result.status === "rejected") {
        console.warn(`ratel: feedback item rejected by the server: ${result.reason ?? "unknown"}`);
      }
    }
    return {
      ok: true,
      status: response.status,
      accepted: body.accepted,
      duplicate: body.duplicate,
      rejected: body.rejected,
      body,
    };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

function failure(error: string, status?: number): ExperimentalFeedbackResult {
  console.warn(`ratel: feedback was not sent: ${error}`);
  return status === undefined ? { ok: false, error } : { ok: false, status, error };
}

/** The base URL: the option, then the OTLP endpoint without `/v1/traces`, then `RATEL_URL`. */
function resolveBaseUrl(endpoint: string | undefined): string {
  const raw =
    endpoint || process.env.RATEL_OTLP_ENDPOINT || process.env.RATEL_URL || DEFAULT_BASE_URL;
  return raw
    .replace(/\/+$/, "")
    .replace(/\/v1\/traces$/, "")
    .replace(/\/+$/, "");
}

function isFeedbackValue(value: unknown): value is ExperimentalFeedbackValue {
  return (
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function dropUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "";
  }
}

/** This package's version, for the `x-ratel-sdk` header. `src/` and `dist/` both sit one level below package.json. */
function packageVersion(): string {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}
