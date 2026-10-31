import { and, asc, desc, eq, gt, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { enqueueJob, type JobsDb } from "@/lib/jobs/queries";
import { jobs } from "@/lib/jobs/schema";
import { getDb } from "@/lib/platform/db/client";
import { projects } from "@/lib/platform/projects/schema";
import { mergeMemberText } from "./member-text";
import { type NewQueryIntentOccurrence, queryIntentOccurrences, queryIntents } from "./schema";

/**
 * The recurring-asks queries (owned fragment of the upstream queries hub, ADR-0030): the
 * project's categorization watermark, the new search events a run reads, the canonical
 * lookups the pipeline matches against, the occurrence ledger write, and the drain's
 * count-based enqueue of `categorize_queries` runs.
 */

export type QueryIntentsDb = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update">;

// A query-bearing search event, from either integration path: `search` / `skill_search`
// (direct SDK) or `gateway_search` (the gateway's `search_capabilities`, a different wire tag).
const SEARCH_TYPES = ["search", "skill_search", "gateway_search"] as const;

/** The event's own time, falling back to when it was received. */
const traceEventTime = sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;

/** The project's query-intents watermark: the latest search-event time already folded
 * into query_intents. Null before the first categorize_queries run. */
export async function getQueryIntentsWatermark(
  projectId: string,
  db: QueryIntentsDb = getDb(),
): Promise<Date | null> {
  const [row] = await db
    .select({ through: projects.queryIntentsCategorizedThrough })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.through ?? null;
}

/** Advance the watermark, never backwards: a stale or overlapping run (an on-demand
 * trigger racing the drain) must not rewind it. */
export async function advanceQueryIntentsWatermark(
  projectId: string,
  through: Date,
  db: QueryIntentsDb = getDb(),
): Promise<void> {
  await db
    .update(projects)
    .set({
      queryIntentsCategorizedThrough: sql`greatest(coalesce(${projects.queryIntentsCategorizedThrough}, ${through}), ${through})`,
    })
    .where(eq(projects.id, projectId));
}

/** Caps one categorize_queries run so a large backlog drains over several runs. */
const QUERY_INTENT_EVENT_BATCH_LIMIT = 500;
/** Caps how many existing canonicals seed the Jaccard pass. */
const QUERY_INTENT_MATCH_LIMIT = 300;
/** The BM25 clusterer's seed cap: a sanity bound on a runaway project, not a tuning knob. */
export const QUERY_INTENT_MATCH_LIMIT_BM25 = 5000;

/**
 * Search-type trace_events with a query, newer than `since` (or all, when null): the raw
 * material a categorize_queries run reads. Oldest first, capped by
 * {@link QUERY_INTENT_EVENT_BATCH_LIMIT}.
 *
 * Tied-timestamp safety: the window key is not unique, so a group of events sharing one
 * timestamp could straddle the LIMIT boundary, and the strict `>` re-read after the
 * watermark advanced would lose the excluded half. When the result is truncated, the
 * trailing rows that share the last row's timestamp are dropped so the next run re-reads
 * that whole tied group. A full batch at a single timestamp is processed as-is.
 */
export async function listNewSearchQueryEvents(
  projectId: string,
  since: Date | null,
  db: Pick<ReturnType<typeof getDb>, "select"> = getDb(),
): Promise<
  Array<{
    id: string;
    query: string;
    occurredAt: Date;
    sessionId: string | null;
    endUserId: string | null;
  }>
> {
  const rows = await db
    .select({
      id: traceEvents.id,
      query: traceEvents.query,
      occurredAt: sql<
        string | Date
      >`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`,
      sessionId: traceEvents.sessionId,
      endUserId: traceEvents.endUserId,
    })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        inArray(traceEvents.type, [...SEARCH_TYPES]),
        isNotNull(traceEvents.query),
        since ? gt(traceEventTime, since) : undefined,
      ),
    )
    .orderBy(asc(traceEventTime))
    .limit(QUERY_INTENT_EVENT_BATCH_LIMIT);
  const mapped = rows.map((r) => ({
    id: r.id,
    query: r.query as string,
    occurredAt: new Date(r.occurredAt),
    sessionId: r.sessionId,
    endUserId: r.endUserId,
  }));

  const last = mapped[mapped.length - 1];
  if (mapped.length === QUERY_INTENT_EVENT_BATCH_LIMIT && last) {
    const lastTs = last.occurredAt.getTime();
    const withoutTiedTail = mapped.filter((r) => r.occurredAt.getTime() < lastTs);
    if (withoutTiedTail.length > 0) return withoutTiedTail;
  }
  return mapped;
}

/**
 * The canonical query intents whose `normalized_text` exactly matches one of the given
 * normalized texts: the pipeline's cheap exact-match pass. Deliberately uncapped: exact
 * match is O(1) per key on the unique index, and a literal repeat must always find its
 * canonical. Zombie rows (occurrences 0) are left out.
 */
export async function getQueryIntentsByNormalizedTexts(
  projectId: string,
  normalizedTexts: string[],
  db: QueryIntentsDb = getDb(),
): Promise<Array<{ id: string; normalizedText: string; text: string }>> {
  if (normalizedTexts.length === 0) return [];
  return db
    .select({
      id: queryIntents.id,
      normalizedText: queryIntents.normalizedText,
      text: queryIntents.text,
    })
    .from(queryIntents)
    .where(
      and(
        eq(queryIntents.projectId, projectId),
        gt(queryIntents.occurrences, 0),
        inArray(queryIntents.normalizedText, normalizedTexts),
      ),
    );
}

/** A project's canonical query intents, ranked as fuzzy-match seeds (most recurring, most
 * recent first) and capped; zombie rows left out. */
export async function listQueryIntentsForMatching(
  projectId: string,
  db: QueryIntentsDb = getDb(),
  opts: { limit?: number } = {},
): Promise<Array<{ id: string; normalizedText: string; text: string; memberText: string }>> {
  return db
    .select({
      id: queryIntents.id,
      normalizedText: queryIntents.normalizedText,
      text: queryIntents.text,
      memberText: queryIntents.memberText,
    })
    .from(queryIntents)
    .where(and(eq(queryIntents.projectId, projectId), gt(queryIntents.occurrences, 0)))
    .orderBy(desc(queryIntents.occurrences), desc(queryIntents.lastSeenAt))
    .limit(opts.limit ?? QUERY_INTENT_MATCH_LIMIT);
}

export type ResolvedQueryOccurrenceInput = {
  traceEventId: string;
  /** Which extracted intent of the source event this is (0-based); 0 when omitted. */
  intentIndex?: number;
  query: string;
  occurredAt: Date;
  sessionId: string | null;
  endUserId: string | null;
  /** The canonical this occurrence resolves to. */
  normalizedText: string;
  canonicalText: string;
  /** The cleaned phrase that was clustered, accumulated into the canonical's `member_text`. */
  intentText?: string;
};

/**
 * Persist a batch of resolved query occurrences: ensure a `query_intents` row per distinct
 * canonical (first-seen text wins as the display form), bulk-insert the ledger rows
 * idempotently on `(trace_event_id, intent_index)`, then recompute each touched
 * canonical's `occurrences` / `last_seen_at` straight from the ledger. The recompute,
 * not an increment, makes a retry or an overlapping run land on the same true count.
 */
export async function recordQueryIntentOccurrences(
  projectId: string,
  occurrences: ResolvedQueryOccurrenceInput[],
  db: QueryIntentsDb = getDb(),
): Promise<{ intentsCreated: number; occurrencesAdded: number }> {
  if (occurrences.length === 0) return { intentsCreated: 0, occurrencesAdded: 0 };

  const canonicalTextByNormalized = new Map<string, string>();
  for (const o of occurrences) {
    if (!canonicalTextByNormalized.has(o.normalizedText)) {
      canonicalTextByNormalized.set(o.normalizedText, o.canonicalText);
    }
  }

  const idByNormalized = new Map<string, string>();
  let intentsCreated = 0;
  for (const [normalizedText, text] of canonicalTextByNormalized) {
    const [row] = await db
      .insert(queryIntents)
      .values({ projectId, normalizedText, text })
      .onConflictDoUpdate({
        target: [queryIntents.projectId, queryIntents.normalizedText],
        // A genuine no-op, only here so RETURNING surfaces the existing row's id.
        set: { normalizedText: sql`${queryIntents.normalizedText}` },
      })
      .returning({ id: queryIntents.id, inserted: sql<boolean>`(xmax = 0)` });
    if (!row) continue;
    idByNormalized.set(normalizedText, row.id);
    if (row.inserted) intentsCreated++;
  }

  const occRows: NewQueryIntentOccurrence[] = [];
  for (const o of occurrences) {
    const queryIntentId = idByNormalized.get(o.normalizedText);
    if (!queryIntentId) continue;
    occRows.push({
      queryIntentId,
      projectId,
      traceEventId: o.traceEventId,
      intentIndex: o.intentIndex ?? 0,
      query: o.query,
      sessionId: o.sessionId,
      endUserId: o.endUserId,
      occurredAt: o.occurredAt,
    });
  }
  const inserted =
    occRows.length === 0
      ? []
      : await db
          .insert(queryIntentOccurrences)
          .values(occRows)
          .onConflictDoNothing({
            target: [queryIntentOccurrences.traceEventId, queryIntentOccurrences.intentIndex],
          })
          .returning({ id: queryIntentOccurrences.id });

  // The cleaned phrases each canonical absorbed in this batch, for `member_text`.
  const phrasesByNormalized = new Map<string, string[]>();
  for (const o of occurrences) {
    if (!o.intentText) continue;
    const arr = phrasesByNormalized.get(o.normalizedText) ?? [];
    arr.push(o.intentText);
    phrasesByNormalized.set(o.normalizedText, arr);
  }

  for (const [normalizedText, queryIntentId] of idByNormalized) {
    // Read-merge-write: not atomic under a concurrent run (last writer wins), which is
    // tolerable since the next run re-adds any phrase that was lost.
    let memberText: string | undefined;
    const phrases = phrasesByNormalized.get(normalizedText);
    if (phrases && phrases.length > 0) {
      const [current] = await db
        .select({ memberText: queryIntents.memberText })
        .from(queryIntents)
        .where(eq(queryIntents.id, queryIntentId))
        .limit(1);
      const merged = mergeMemberText(current?.memberText ?? "", phrases, normalizedText);
      if (merged !== (current?.memberText ?? "")) memberText = merged;
    }
    await db
      .update(queryIntents)
      .set({
        ...(memberText === undefined ? {} : { memberText }),
        // count(distinct trace_event_id), not count(*): a "recurring ask" counts distinct
        // source queries, not the per-query fan-out rows.
        occurrences: sql`(select count(distinct ${queryIntentOccurrences.traceEventId})::int from ${queryIntentOccurrences} where ${queryIntentOccurrences.queryIntentId} = ${queryIntentId})`,
        lastSeenAt: sql`coalesce((select max(${queryIntentOccurrences.occurredAt}) from ${queryIntentOccurrences} where ${queryIntentOccurrences.queryIntentId} = ${queryIntentId}), ${queryIntents.lastSeenAt})`,
      })
      .where(eq(queryIntents.id, queryIntentId));
  }

  return { intentsCreated, occurrencesAdded: inserted.length };
}

/**
 * How many un-categorized search events a project accumulates before the drain enqueues
 * a `categorize_queries` job for it. Count-based, not time-based: a busy project is
 * analyzed as soon as it crosses the threshold, a quiet one waits until it has enough
 * new queries to be worth a run. `QUERY_INTENTS_TRIGGER_COUNT=1` categorizes on
 * essentially every new query.
 */
export const QUERY_INTENTS_TRIGGER_COUNT = Math.max(
  1,
  Number.parseInt(process.env.QUERY_INTENTS_TRIGGER_COUNT ?? "", 10) || 40,
);

/**
 * Enqueue a `categorize_queries` job for every project with at least `threshold` search
 * events past its watermark and no such job queued or running. After a run advances the
 * watermark the pending count drops below the threshold, so a project is not re-enqueued
 * until it accumulates enough new queries.
 */
export async function enqueueDueQueryCategorizations(
  db: JobsDb = getDb(),
  threshold: number = QUERY_INTENTS_TRIGGER_COUNT,
): Promise<{ enqueued: number }> {
  const due = await db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(
      traceEvents,
      and(
        eq(traceEvents.projectId, projects.id),
        inArray(traceEvents.type, [...SEARCH_TYPES]),
        isNotNull(traceEvents.query),
        sql`${traceEventTime} > coalesce(${projects.queryIntentsCategorizedThrough}, '-infinity'::timestamptz)`,
      ),
    )
    .where(
      notExists(
        db
          .select({ one: sql`1` })
          .from(jobs)
          .where(
            and(
              eq(jobs.projectId, projects.id),
              eq(jobs.kind, "categorize_queries"),
              inArray(jobs.status, ["queued", "running"]),
            ),
          ),
      ),
    )
    .groupBy(projects.id)
    .having(sql`count(${traceEvents.id}) >= ${threshold}`);

  for (const p of due) {
    await enqueueJob({ projectId: p.id, kind: "categorize_queries" }, db);
  }
  return { enqueued: due.length };
}
