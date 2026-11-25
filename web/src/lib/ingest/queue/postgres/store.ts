import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import { errorCode } from "@/lib/ingest/queue/port/settle";
import { ingestSpool } from "@/lib/ingest/queue/postgres/schema";
import type { getDb } from "@/lib/platform/db/client";

export type SpoolDb = ReturnType<typeof getDb>;

export interface ClaimedMessage {
  seq: number;
  token: string;
  projectId: string;
  messageId: string;
  frame: Uint8Array;
  /** This delivery included. */
  deliveries: number;
  outages: number;
}

export interface SpoolDeadLetter {
  seq: number;
  messageId: string;
  projectId: string;
  reason: string;
  deliveries: number;
  enqueuedAt: Date;
  firstFailedAt: Date;
  lastFailedAt: Date;
}

/** Dead letters are kept this long (ADR-0009). */
export const DEAD_LETTER_RETENTION_DAYS = 14;
const PRUNE_BATCH_SIZE = 500;
/** How many projects one claim tries when other consumers take them first. */
const CLAIM_CANDIDATES = 20;

export async function insertMessage(
  db: SpoolDb,
  message: { messageId: string; projectId: string; frame: Uint8Array },
): Promise<void> {
  try {
    await db.insert(ingestSpool).values(message);
  } catch (error) {
    // The query's error quotes its parameters, which are the customer's telemetry.
    throw new SpoolInsertError(errorCode(error));
  }
}

class SpoolInsertError extends Error {
  readonly code?: string;

  constructor(code: string | undefined) {
    super("ingest spool insert failed");
    this.name = "SpoolInsertError";
    if (code) this.code = code;
  }
}

/**
 * Claims the oldest message of one project that nobody has in hand. The check and the claim run
 * under a lock on the project, so two consumers cannot hold two messages of it, also when a
 * publish with a lower `seq` commits late.
 */
export async function claimMessage(db: SpoolDb, leaseMs: number): Promise<ClaimedMessage | null> {
  for (const projectId of await claimableProjects(db)) {
    const claimed = await claimHead(db, projectId, leaseMs);
    if (claimed) return claimed;
  }
  return null;
}

/** Reads one index entry per project that has queued messages, not one per message. */
async function claimableProjects(db: SpoolDb): Promise<string[]> {
  const { rows } = await db.execute<{ project_id: string }>(sql`
    with recursive queued as (
      (select project_id from ingest_spool where dead_at is null order by project_id limit 1)
      union all
      select (
        select s.project_id from ingest_spool s
        where s.dead_at is null and s.project_id > queued.project_id
        order by s.project_id limit 1
      )
      from queued where queued.project_id is not null
    )
    select queued.project_id
    from queued
    cross join lateral (
      select s.available_at from ingest_spool s
      where s.project_id = queued.project_id and s.dead_at is null
      order by s.seq limit 1
    ) head
    where queued.project_id is not null
      and head.available_at <= clock_timestamp()
      and not exists (${activeClaim(sql`queued.project_id`)})
    order by random()
    limit ${CLAIM_CANDIDATES}
  `);
  return rows.map((row) => row.project_id);
}

async function claimHead(
  db: SpoolDb,
  projectId: string,
  leaseMs: number,
): Promise<ClaimedMessage | null> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`ingest_spool:${projectId}`}, 0)) as locked`,
    );
    if (!rows[0]?.locked) return null;
    // A statement of its own, so that its snapshot is newer than the lock.
    const token = randomUUID();
    const [claimed] = await tx
      .update(ingestSpool)
      .set({
        claimToken: token,
        claimedUntil: fromNow(leaseMs),
        deliveries: sql`${ingestSpool.deliveries} + 1`,
      })
      .where(
        and(
          eq(
            ingestSpool.seq,
            sql`(select s.seq from ingest_spool s where s.project_id = ${projectId} and s.dead_at is null order by s.seq limit 1)`,
          ),
          lte(ingestSpool.availableAt, sql`clock_timestamp()`),
          sql`not exists (${activeClaim(sql`${projectId}::uuid`)})`,
        ),
      )
      .returning({
        seq: ingestSpool.seq,
        projectId: ingestSpool.projectId,
        messageId: ingestSpool.messageId,
        frame: ingestSpool.frame,
        deliveries: ingestSpool.deliveries,
        outages: ingestSpool.outages,
      });
    return claimed ? { ...claimed, token } : null;
  });
}

const activeClaim = (projectId: ReturnType<typeof sql>) =>
  sql`select 1 from ingest_spool c where c.project_id = ${projectId} and c.claimed_until > clock_timestamp()`;

const fromNow = (ms: number) => sql`clock_timestamp() + make_interval(secs => ${ms / 1000})`;

/** The row as long as this claim holds it: a consumer that lost its claim changes nothing. */
const held = ({ seq, token }: Pick<ClaimedMessage, "seq" | "token">) =>
  and(eq(ingestSpool.seq, seq), eq(ingestSpool.claimToken, token));

const RELEASED = { claimToken: null, claimedUntil: null };

/** False when the claim was lost. */
export async function renewClaim(
  db: SpoolDb,
  claim: Pick<ClaimedMessage, "seq" | "token">,
  leaseMs: number,
): Promise<boolean> {
  const rows = await db
    .update(ingestSpool)
    .set({ claimedUntil: fromNow(leaseMs) })
    .where(held(claim))
    .returning({ seq: ingestSpool.seq });
  return rows.length > 0;
}

export async function removeMessage(db: SpoolDb, claim: ClaimedMessage): Promise<boolean> {
  const rows = await db.delete(ingestSpool).where(held(claim)).returning({ seq: ingestSpool.seq });
  return rows.length > 0;
}

export async function redeliverMessage(
  db: SpoolDb,
  claim: ClaimedMessage,
  { waitMs, outage, reason }: { waitMs: number; outage: boolean; reason: string },
): Promise<boolean> {
  const rows = await db
    .update(ingestSpool)
    .set({
      ...RELEASED,
      availableAt: fromNow(waitMs),
      reason,
      ...(outage
        ? {
            deliveries: sql`${ingestSpool.deliveries} - 1`,
            outages: sql`${ingestSpool.outages} + 1`,
          }
        : { ...failedNow(), outages: 0 }),
    })
    .where(held(claim))
    .returning({ seq: ingestSpool.seq });
  return rows.length > 0;
}

export async function deadLetterMessage(
  db: SpoolDb,
  claim: ClaimedMessage,
  reason: string,
  deliveries: number,
): Promise<boolean> {
  const rows = await db
    .update(ingestSpool)
    .set({ ...RELEASED, ...failedNow(), reason, deliveries, deadAt: sql`clock_timestamp()` })
    .where(held(claim))
    .returning({ seq: ingestSpool.seq });
  return rows.length > 0;
}

/** Gives back a message that was claimed and not delivered. */
export async function giveBackMessage(db: SpoolDb, claim: ClaimedMessage): Promise<void> {
  await db
    .update(ingestSpool)
    .set({ ...RELEASED, deliveries: sql`${ingestSpool.deliveries} - 1` })
    .where(held(claim));
}

const failedNow = () => ({
  firstFailedAt: sql`coalesce(${ingestSpool.firstFailedAt}, clock_timestamp())`,
  lastFailedAt: sql`clock_timestamp()`,
});

/** Newest first, without the frames. Every project's when none is named. */
export async function listDeadLetters(
  db: Pick<SpoolDb, "select">,
  { projectId, limit = 100 }: { projectId?: string; limit?: number } = {},
): Promise<SpoolDeadLetter[]> {
  const rows = await db
    .select({
      seq: ingestSpool.seq,
      messageId: ingestSpool.messageId,
      projectId: ingestSpool.projectId,
      reason: ingestSpool.reason,
      deliveries: ingestSpool.deliveries,
      enqueuedAt: ingestSpool.enqueuedAt,
      firstFailedAt: ingestSpool.firstFailedAt,
      lastFailedAt: ingestSpool.lastFailedAt,
      deadAt: ingestSpool.deadAt,
    })
    .from(ingestSpool)
    .where(
      and(
        isNotNull(ingestSpool.deadAt),
        projectId ? eq(ingestSpool.projectId, projectId) : undefined,
      ),
    )
    .orderBy(desc(ingestSpool.deadAt), desc(ingestSpool.seq))
    .limit(limit);
  return rows.map(({ deadAt, ...row }) => ({
    ...row,
    reason: row.reason ?? "",
    firstFailedAt: row.firstFailedAt ?? deadAt ?? row.enqueuedAt,
    lastFailedAt: row.lastFailedAt ?? deadAt ?? row.enqueuedAt,
  }));
}

/** A dead letter's envelope, as it was published. */
export async function readDeadLetterFrame(
  db: Pick<SpoolDb, "select">,
  seq: number,
): Promise<Uint8Array | null> {
  const [row] = await db
    .select({ frame: ingestSpool.frame })
    .from(ingestSpool)
    .where(and(eq(ingestSpool.seq, seq), isNotNull(ingestSpool.deadAt)));
  return row ? new Uint8Array(row.frame) : null;
}

/** Deletes one bounded batch of dead letters past their retention. */
export async function pruneDeadLetters(
  db: Pick<SpoolDb, "select" | "delete">,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - DEAD_LETTER_RETENTION_DAYS * 86_400_000);
  const expired = db
    .select({ seq: ingestSpool.seq })
    .from(ingestSpool)
    .where(lt(ingestSpool.deadAt, cutoff))
    .orderBy(asc(ingestSpool.deadAt), asc(ingestSpool.seq))
    .limit(PRUNE_BATCH_SIZE);
  const deleted = await db
    .delete(ingestSpool)
    .where(inArray(ingestSpool.seq, expired))
    .returning({ seq: ingestSpool.seq });
  return deleted.length;
}
