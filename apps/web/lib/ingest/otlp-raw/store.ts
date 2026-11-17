import { and, asc, eq, gt, gte, lt, or, sql } from "drizzle-orm";
import { otlpRawExports } from "@/lib/ingest/otlp-raw/schema";
import { getDb } from "@/lib/platform/db/client";
import {
  compressForStorage,
  type OtlpRawExportInput,
  type OtlpRawStore,
  type OtlpRawStoreResult,
  otlpRawDailyByteCap,
} from "./domain";

export type OtlpRawStoreDb = Pick<ReturnType<typeof getDb>, "insert" | "select">;

export interface OtlpRawExportPageQuery {
  projectId: string;
  since: Date;
  until?: Date;
  /** The last row of the previous page; absent for the first page. */
  after?: { receivedAt: Date; id: string };
  limit: number;
}

export interface OtlpRawExportBody {
  id: string;
  receivedAt: Date;
  signal: "traces" | "logs";
  contentType: string;
  body: Uint8Array;
}

export interface OtlpRawStoreOptions {
  db?: OtlpRawStoreDb;
  dailyCapBytes?: number;
  now?: () => Date;
}

/**
 * The Postgres adapter for raw OTLP capture. It checks the project's stored
 * bytes for the current UTC day before each insert. The check and the insert
 * are not one transaction, so concurrent exports can overshoot the cap by at
 * most their own sizes: a soft cap, which is enough to bound storage.
 */
export function createOtlpRawStore(options: OtlpRawStoreOptions = {}): OtlpRawStore {
  const db = options.db ?? getDb();
  const capBytes = options.dailyCapBytes ?? otlpRawDailyByteCap();
  const now = options.now ?? (() => new Date());

  return {
    async store(input: OtlpRawExportInput): Promise<OtlpRawStoreResult> {
      const body = compressForStorage(input);
      const rawBytes = input.body.byteLength;
      const storedBytes = body.byteLength;
      const receivedAt = now();
      const usedBytes = await storedBytesSince(db, input.projectId, startOfUtcDay(receivedAt));
      if (usedBytes + storedBytes > capBytes) {
        return {
          stored: false,
          skipped: "over_daily_cap",
          rawBytes,
          storedBytes,
          usedBytes,
          capBytes,
        };
      }
      const [row] = await insertExport(db, {
        projectId: input.projectId,
        receivedAt,
        signal: input.signal,
        contentType: input.contentType,
        body,
        rawBytes,
        storedBytes,
        itemCount: input.itemCount,
        traceIds: input.traceIds,
      });
      return { stored: true, id: row.id, rawBytes, storedBytes };
    },
  };
}

/** One page of a project's stored bodies in a window, oldest first. Read-only. */
export async function readOtlpRawExportPage(
  db: Pick<ReturnType<typeof getDb>, "select">,
  query: OtlpRawExportPageQuery,
): Promise<OtlpRawExportBody[]> {
  const { after } = query;
  return db
    .select({
      id: otlpRawExports.id,
      receivedAt: otlpRawExports.receivedAt,
      signal: otlpRawExports.signal,
      contentType: otlpRawExports.contentType,
      body: otlpRawExports.body,
    })
    .from(otlpRawExports)
    .where(
      and(
        eq(otlpRawExports.projectId, query.projectId),
        gte(otlpRawExports.receivedAt, query.since),
        query.until ? lt(otlpRawExports.receivedAt, query.until) : undefined,
        after
          ? or(
              gt(otlpRawExports.receivedAt, after.receivedAt),
              and(eq(otlpRawExports.receivedAt, after.receivedAt), gt(otlpRawExports.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(otlpRawExports.receivedAt), asc(otlpRawExports.id))
    .limit(query.limit);
}

/**
 * Insert one export. A failed query is rethrown as a static error with only
 * the Postgres code and constraint: the driver's error message lists every
 * query param, and here those are the customer's body and trace ids, which
 * must never reach a log line or an exception report.
 */
async function insertExport(
  db: OtlpRawStoreDb,
  values: typeof otlpRawExports.$inferInsert,
): Promise<Array<{ id: string }>> {
  try {
    return await db.insert(otlpRawExports).values(values).returning({ id: otlpRawExports.id });
  } catch (thrown) {
    throw new OtlpRawInsertError(thrown);
  }
}

class OtlpRawInsertError extends Error {
  readonly code?: string;
  readonly constraint?: string;

  constructor(thrown: unknown) {
    super("otlp raw insert failed");
    this.name = "OtlpRawInsertError";
    const pg = postgresError(thrown);
    if (pg?.code) this.code = pg.code;
    if (pg?.constraint) this.constraint = pg.constraint;
  }
}

function postgresError(thrown: unknown): { code?: string; constraint?: string } | undefined {
  for (let current = thrown, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") return undefined;
    const { code, constraint, cause } = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (typeof code === "string") {
      return { code, constraint: typeof constraint === "string" ? constraint : undefined };
    }
    current = cause;
  }
  return undefined;
}

async function storedBytesSince(
  db: OtlpRawStoreDb,
  projectId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({
      used: sql<string | number>`coalesce(sum(${otlpRawExports.storedBytes}), 0)`,
    })
    .from(otlpRawExports)
    .where(and(eq(otlpRawExports.projectId, projectId), gte(otlpRawExports.receivedAt, since)));
  return Number(row?.used ?? 0);
}

function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
