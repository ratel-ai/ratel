import { clientAddress } from "@/lib/platform/http/client-address";
import {
  createTokenBucketRateLimiter,
  type LocalTokenBucketRateLimiter,
} from "@/lib/platform/rate-limit";

/**
 * Abuse limits for ingest-only (publishable) keys (RC-585).
 *
 * A publishable key ships inside an app, so one key is shared by every install
 * and anyone can extract it. Two budgets cover that:
 *  - per key: a ceiling for the whole fleet, higher than a secret key's 120 a
 *    minute because thousands of clients share it. Set per key with
 *    `api_keys.rate_limit_per_minute`, or for every publishable key with
 *    `RATEL_PUBLISHABLE_KEY_LIMIT_PER_MINUTE`.
 *  - per source: one address may only use a small share of it
 *    (`RATEL_PUBLISHABLE_SOURCE_LIMIT_PER_MINUTE`), so a single abuser cannot
 *    spend the fleet's budget. The address is the last `X-Forwarded-For` hop,
 *    the one our ALB appends and no caller can forge (`clientAddress`).
 *
 * Both are charged twice: once per request before the body is read (so decode
 * work is bounded), and once per item after it (spans, log records, events),
 * because one request may carry thousands of them. The item budgets are
 * `ITEMS_PER_REQUEST` times the request budgets, or
 * `RATEL_PUBLISHABLE_KEY_ITEMS_PER_MINUTE` / `..._SOURCE_ITEMS_PER_MINUTE`.
 * IPv6 sources are bucketed by /64, the block one host is usually given, so
 * rotating addresses inside it buys nothing.
 *
 * The budget is shared by traces, logs and events, so the ceiling is one number
 * per key, not three. Process-local token buckets like every other limit here:
 * each task enforces its own share, which is best effort by design.
 *
 * Secret keys are untouched: their routes keep whatever limits they had.
 */

export const DEFAULT_PUBLISHABLE_KEY_LIMIT_PER_MINUTE = 6_000;
export const DEFAULT_PUBLISHABLE_SOURCE_LIMIT_PER_MINUTE = 120;
/** Items (spans, log records, events) a request's budget allows on average. */
export const ITEMS_PER_REQUEST = 10;

export type IngestLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; limit: "per_key" | "per_source" };

type LimitedKey = { id: string; rateLimitPerMinute: number | null };

export interface PublishableIngestLimits {
  /** Per request, before the body is read. */
  check(request: Request, key: LimitedKey): IngestLimitDecision;
  /** Per item, once the body says how many spans, records or events it holds. */
  chargeItems(request: Request, key: LimitedKey, items: number): IngestLimitDecision;
}

export interface PublishableIngestLimitOptions {
  perKeyPerMinute: number;
  perSourcePerMinute: number;
  /** Defaults to `ITEMS_PER_REQUEST` times the request budgets. */
  perKeyItemsPerMinute?: number;
  perSourceItemsPerMinute?: number;
  now?: () => number;
}

/**
 * The bucket a source address counts against: an IPv4 address as is, an IPv6
 * address by its /64 prefix.
 */
export function sourceBucket(address: string): string {
  if (!address.includes(":")) return address;
  const [head, tail = ""] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function publishableLimitOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PublishableIngestLimitOptions {
  const perKeyPerMinute = positiveInt(
    env.RATEL_PUBLISHABLE_KEY_LIMIT_PER_MINUTE,
    DEFAULT_PUBLISHABLE_KEY_LIMIT_PER_MINUTE,
  );
  const perSourcePerMinute = positiveInt(
    env.RATEL_PUBLISHABLE_SOURCE_LIMIT_PER_MINUTE,
    DEFAULT_PUBLISHABLE_SOURCE_LIMIT_PER_MINUTE,
  );
  return {
    perKeyPerMinute,
    perSourcePerMinute,
    perKeyItemsPerMinute: positiveInt(
      env.RATEL_PUBLISHABLE_KEY_ITEMS_PER_MINUTE,
      perKeyPerMinute * ITEMS_PER_REQUEST,
    ),
    perSourceItemsPerMinute: positiveInt(
      env.RATEL_PUBLISHABLE_SOURCE_ITEMS_PER_MINUTE,
      perSourcePerMinute * ITEMS_PER_REQUEST,
    ),
  };
}

export function createPublishableIngestLimits(
  options: PublishableIngestLimitOptions,
): PublishableIngestLimits {
  const bucket = (limitPerMinute: number) =>
    createTokenBucketRateLimiter({ limitPerMinute, burst: limitPerMinute * 2, now: options.now });
  const sourceItemsPerMinute =
    options.perSourceItemsPerMinute ?? options.perSourcePerMinute * ITEMS_PER_REQUEST;
  const perSource = {
    requests: bucket(options.perSourcePerMinute),
    items: bucket(sourceItemsPerMinute),
  };
  // One limiter per distinct ceiling, since a key may carry its own.
  const perKeyByLimit = new Map<string, LocalTokenBucketRateLimiter>();
  const perKeyLimiter = (kind: "requests" | "items", limit: number) => {
    const id = `${kind}:${limit}`;
    let limiter = perKeyByLimit.get(id);
    if (!limiter) {
      limiter = bucket(limit);
      perKeyByLimit.set(id, limiter);
    }
    return limiter;
  };
  const requestCeiling = (key: LimitedKey) =>
    key.rateLimitPerMinute && key.rateLimitPerMinute > 0
      ? key.rateLimitPerMinute
      : options.perKeyPerMinute;
  const itemCeiling = (key: LimitedKey) =>
    key.rateLimitPerMinute && key.rateLimitPerMinute > 0
      ? key.rateLimitPerMinute * ITEMS_PER_REQUEST
      : (options.perKeyItemsPerMinute ?? options.perKeyPerMinute * ITEMS_PER_REQUEST);

  function charge(
    request: Request,
    key: LimitedKey,
    kind: "requests" | "items",
    ceiling: number,
    cost: number,
  ): IngestLimitDecision {
    // The source is checked first and only it is charged when it is over,
    // so one noisy address never spends the fleet's shared budget.
    const source = perSource[kind].consume(
      `${key.id}:${sourceBucket(clientAddress(request))}`,
      cost,
    );
    if (!source.allowed) return { ...source, limit: "per_source" };
    const fleet = perKeyLimiter(kind, ceiling).consume(key.id, cost);
    if (!fleet.allowed) return { ...fleet, limit: "per_key" };
    return { allowed: true };
  }

  return {
    check: (request, key) => charge(request, key, "requests", requestCeiling(key), 1),
    chargeItems: (request, key, items) =>
      charge(request, key, "items", itemCeiling(key), Math.max(1, items)),
  };
}

/** The process-wide budget the three ingest routes share. */
export const publishableIngestLimits: PublishableIngestLimits = createPublishableIngestLimits(
  publishableLimitOptionsFromEnv(),
);

/** 429 with Retry-After, saying which budget ran out. */
export function ingestRateLimitedResponse(
  decision: Extract<IngestLimitDecision, { allowed: false }>,
): Response {
  const message =
    decision.limit === "per_source"
      ? "Too many requests from this address for this key. Slow down and retry."
      : "Too many requests for this key. Slow down and retry.";
  return Response.json(
    { error: "Rate limit exceeded.", reason: decision.limit, message },
    { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
  );
}
