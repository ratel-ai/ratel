import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getDb } from "@/lib/platform/db/client";
import type * as schema from "@/lib/platform/db/tables";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The db surface a bounded read runs against. Typed as the base database rather
 * than the pool-specific `getDb()` return so the same callback accepts both the
 * pool and an open transaction (and a test PGlite).
 */
export type BoundReadDb = NodePgDatabase<typeof schema>;

/** The subset of the read span this module drives (real Span satisfies it). */
type BoundReadSpan = Pick<Span, "end" | "recordException" | "setStatus">;

type StartActiveSpan = <T>(
  name: string,
  callback: (span: BoundReadSpan) => Promise<T>,
) => Promise<T>;

export interface StatementTimeoutOptions {
  operation: string;
  db?: BoundReadDb;
  timeoutMs?: number | null;
  startActiveSpan?: StartActiveSpan;
}

/**
 * Default per-read `statement_timeout`. Heavy trace/experiment aggregates that
 * exceed this fail fast (Postgres cancels them) instead of hanging until the
 * ALB idle timeout closes the connection — letting the caller degrade
 * gracefully. Protective by default; set `DATABASE_READ_TIMEOUT_MS=0` to
 * disable.
 */
export const DEFAULT_READ_TIMEOUT_MS = 15_000;
export const DEFAULT_SUPPLEMENTARY_READ_TIMEOUT_MS = 5_000;

/**
 * Run `read` under a transaction-scoped `statement_timeout` so a runaway
 * aggregate is cancelled by Postgres rather than left to exhaust the request.
 * The timeout is applied with `SET LOCAL` semantics (via `set_config(..., true)`)
 * so it never leaks to other statements on the pooled connection. When the
 * timeout is disabled (`timeoutMs === null`) the read runs directly, preserving
 * the prior unbounded behavior exactly.
 */
export async function withStatementTimeout<T>(
  read: (db: BoundReadDb) => Promise<T>,
  dbOrOptions: BoundReadDb | StatementTimeoutOptions = getDb(),
  timeoutMs: number | null = readTimeoutMs(),
): Promise<T> {
  let db: BoundReadDb;
  let options: StatementTimeoutOptions | undefined;
  if (isStatementTimeoutOptions(dbOrOptions)) {
    options = dbOrOptions;
    db = options.db ?? getDb();
  } else {
    db = dbOrOptions;
  }
  const boundedTimeoutMs = options
    ? options.timeoutMs === undefined
      ? readTimeoutMs()
      : options.timeoutMs
    : timeoutMs;
  const operation = (options?.operation ?? read.name) || "unknown";
  const startActiveSpan = options?.startActiveSpan ?? defaultStartActiveSpan;

  return startActiveSpan(`db.read ${operation}`, async (span) => {
    // `await` inside the try (not `return read(...)`) so the span spans the
    // whole read — otherwise `finally` ends it before the promise settles — and
    // so a thrown/cancelled read is caught here rather than escaping unmarked.
    try {
      if (boundedTimeoutMs === null) return await read(db);
      return await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('statement_timeout', ${String(boundedTimeoutMs)}, true)`,
        );
        return read(tx);
      });
    } catch (error) {
      // Mark the failed read so it reads as errored in the waterfall this tier
      // exists to make legible, not as a normal-looking span.
      span.recordException(error instanceof Error ? error : { message: String(error) });
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Resolve the bounded-read timeout in milliseconds, or `null` when explicitly
 * disabled. Unset or malformed values keep the protective default so a
 * misconfiguration can never silently remove the guard; only an explicit `0`
 * turns it off.
 */
export function readTimeoutMs(env: Environment = process.env): number | null {
  return resolveTimeoutMs(env.DATABASE_READ_TIMEOUT_MS, DEFAULT_READ_TIMEOUT_MS);
}

/**
 * Resolve the shorter timeout for non-essential reads that can degrade to a
 * fallback without preventing the page's primary content from rendering.
 */
export function supplementaryReadTimeoutMs(env: Environment = process.env): number | null {
  return resolveTimeoutMs(
    env.DATABASE_SUPPLEMENTARY_READ_TIMEOUT_MS,
    DEFAULT_SUPPLEMENTARY_READ_TIMEOUT_MS,
  );
}

function resolveTimeoutMs(value: string | undefined, fallback: number): number | null {
  const raw = value?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (parsed === 0) return null;
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  return fallback;
}

function defaultStartActiveSpan<T>(
  name: string,
  callback: (span: BoundReadSpan) => Promise<T>,
): Promise<T> {
  return trace.getTracer("ratel.db").startActiveSpan(name, callback);
}

function isStatementTimeoutOptions(
  value: BoundReadDb | StatementTimeoutOptions,
): value is StatementTimeoutOptions {
  return "operation" in value;
}
