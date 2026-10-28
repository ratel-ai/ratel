export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface TokenBucketRateLimiter {
  consume(key: string): RateLimitDecision;
}

export interface LocalTokenBucketRateLimiter extends TokenBucketRateLimiter {
  readonly bucketCount: number;
  /**
   * Whether a token is available, without taking one.
   *
   * For budgets that should only be charged on a particular outcome: check
   * before doing the work, charge afterwards only if it turned out badly.
   * Consuming up front would make the honest callers pay for the dishonest
   * ones, which is the opposite of what such a budget is for.
   */
  peek(key: string): RateLimitDecision;
}

export interface TokenBucketOptions {
  limitPerMinute: number;
  burst: number;
  now?: () => number;
  sweepThreshold?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const DEFAULT_SWEEP_THRESHOLD = 10_000;

/** Process-local token bucket suitable for best-effort per-credential API limits. */
export function createTokenBucketRateLimiter(
  options: TokenBucketOptions,
): LocalTokenBucketRateLimiter {
  const buckets = new Map<string, Bucket>();
  const now = options.now ?? Date.now;
  const tokensPerMs = options.limitPerMinute / 60_000;
  const sweepThreshold = Math.max(1, Math.floor(options.sweepThreshold ?? DEFAULT_SWEEP_THRESHOLD));

  /** An unseen key is full, so asking about one must not record it. */
  function tokensAt(key: string, currentTime: number): number {
    const previous = buckets.get(key);
    if (!previous) return options.burst;
    return Math.min(
      options.burst,
      previous.tokens + Math.max(0, currentTime - previous.updatedAt) * tokensPerMs,
    );
  }

  function decide(tokens: number): RateLimitDecision {
    if (tokens >= 1) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / tokensPerMs / 1_000)),
    };
  }

  return {
    get bucketCount() {
      return buckets.size;
    },
    peek(key) {
      return decide(tokensAt(key, now()));
    },
    consume(key) {
      const currentTime = now();
      if (!buckets.has(key) && buckets.size >= sweepThreshold) {
        sweepFullIdleBuckets(buckets, currentTime, options.burst, tokensPerMs);
      }
      const tokens = tokensAt(key, currentTime);
      const decision = decide(tokens);
      buckets.set(key, {
        tokens: decision.allowed ? tokens - 1 : tokens,
        updatedAt: currentTime,
      });
      return decision;
    },
  };
}

function sweepFullIdleBuckets(
  buckets: Map<string, Bucket>,
  currentTime: number,
  burst: number,
  tokensPerMs: number,
): void {
  for (const [key, bucket] of buckets) {
    const refilledTokens =
      bucket.tokens + Math.max(0, currentTime - bucket.updatedAt) * tokensPerMs;
    if (refilledTokens >= burst) buckets.delete(key);
  }
}
