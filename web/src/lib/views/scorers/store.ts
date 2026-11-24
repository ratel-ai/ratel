import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { getDb } from "@/lib/platform/db/client";
import { parseDefinition, parseFilter } from "./config";
import { type ScorerRow, scorers, traceScores } from "./schema";
import type { Scorer, ScorerDraft, TraceScore } from "./types";

type Db = ReturnType<typeof getDb>;
/** The database, or the transaction a caller already holds. */
export type ScorerDb = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

export interface NewTraceScore extends TraceScore {
  scorerId: string;
  projectId: string;
  traceId: string;
  traceStartedAt: Date;
}

/** A scorer's results over a window. `passRate` is null for a numeric judge, or without results. */
export interface ScorerSummary {
  scored: number;
  passRate: number | null;
  average: number | null;
}

export async function listScorers(projectId: string, db: ScorerDb = getDb()): Promise<Scorer[]> {
  const rows = await db
    .select()
    .from(scorers)
    .where(eq(scorers.projectId, projectId))
    .orderBy(asc(scorers.createdAt), asc(scorers.id));
  return rows.flatMap((row) => scorerOf(row) ?? []);
}

export async function getScorer(
  projectId: string,
  scorerId: string,
  db: ScorerDb = getDb(),
): Promise<Scorer | null> {
  const [row] = await db
    .select()
    .from(scorers)
    .where(and(eq(scorers.projectId, projectId), eq(scorers.id, scorerId)));
  return row ? scorerOf(row) : null;
}

export async function createScorer(
  projectId: string,
  draft: ScorerDraft,
  actor: string,
  db: ScorerDb = getDb(),
): Promise<string> {
  const [row] = await db
    .insert(scorers)
    .values({ projectId, ...draft, createdBy: actor, updatedBy: actor })
    .returning({ id: scorers.id });
  if (!row) throw new Error("the scorer insert returned no row");
  return row.id;
}

/** Replace a scorer's settings, except its kind. Stored results stay. False when there is none. */
export async function updateScorer(
  projectId: string,
  scorerId: string,
  draft: ScorerDraft,
  actor: string,
  db: ScorerDb = getDb(),
): Promise<boolean> {
  const { kind, enabled, ...settings } = draft;
  const rows = await db
    .update(scorers)
    .set({ ...settings, ...enabledChange(enabled), updatedBy: actor, updatedAt: new Date() })
    .where(and(eq(scorers.projectId, projectId), eq(scorers.id, scorerId), eq(scorers.kind, kind)))
    .returning({ id: scorers.id });
  return rows.length > 0;
}

/** Switch a scorer. On again, it starts at now: it does not score the time it was off. */
export async function setScorerEnabled(
  projectId: string,
  scorerId: string,
  enabled: boolean,
  actor: string,
  db: ScorerDb = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(scorers)
    .set({ ...enabledChange(enabled), updatedBy: actor, updatedAt: new Date() })
    .where(and(eq(scorers.projectId, projectId), eq(scorers.id, scorerId)))
    .returning({ id: scorers.id });
  return rows.length > 0;
}

/** Delete a scorer and every result it stored. */
export async function deleteScorer(
  projectId: string,
  scorerId: string,
  db: ScorerDb = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(scorers)
    .where(and(eq(scorers.projectId, projectId), eq(scorers.id, scorerId)))
    .returning({ id: scorers.id });
  return rows.length > 0;
}

/** Store results; a trace the scorer already scored keeps its first one. Returns the rows added. */
export async function insertTraceScores(
  scores: readonly NewTraceScore[],
  db: ScorerDb = getDb(),
): Promise<number> {
  if (scores.length === 0) return 0;
  const added = await db
    .insert(traceScores)
    .values([...scores])
    .onConflictDoNothing()
    .returning({ traceId: traceScores.traceId });
  return added.length;
}

/** Per scorer id, its results of traces that started at or after `since`. */
export async function scorerSummaries(
  projectId: string,
  since: Date,
  db: ScorerDb = getDb(),
): Promise<Map<string, ScorerSummary>> {
  const rows = await db
    .select({ scorerId: traceScores.scorerId, ...summaryColumns })
    .from(traceScores)
    .where(and(eq(traceScores.projectId, projectId), gte(traceScores.traceStartedAt, since)))
    .groupBy(traceScores.scorerId);
  return new Map(rows.map(({ scorerId, ...summary }) => [scorerId, summary]));
}

/** One scorer's results per UTC day, oldest first. A day without results has no row. */
export async function scorerTrend(
  projectId: string,
  scorerId: string,
  since: Date,
  db: ScorerDb = getDb(),
): Promise<(ScorerSummary & { day: string })[]> {
  const day = sql<string>`to_char(${traceScores.traceStartedAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  return db
    .select({ day, ...summaryColumns })
    .from(traceScores)
    .where(
      and(
        eq(traceScores.projectId, projectId),
        eq(traceScores.scorerId, scorerId),
        gte(traceScores.traceStartedAt, since),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);
}

export interface LatestScore extends TraceScore {
  traceId: string;
  traceStartedAt: Date;
  scoredAt: Date;
}

export async function latestScores(
  projectId: string,
  scorerId: string,
  limit: number,
  db: ScorerDb = getDb(),
): Promise<LatestScore[]> {
  return db
    .select({
      traceId: traceScores.traceId,
      traceStartedAt: traceScores.traceStartedAt,
      scoredAt: traceScores.scoredAt,
      value: traceScores.value,
      passed: traceScores.passed,
      confidence: traceScores.confidence,
    })
    .from(traceScores)
    .where(and(eq(traceScores.projectId, projectId), eq(traceScores.scorerId, scorerId)))
    .orderBy(desc(traceScores.traceStartedAt), desc(traceScores.traceId))
    .limit(limit);
}

export interface ScoreOfTrace extends TraceScore {
  scorerId: string;
  scorerName: string;
}

/** The results of one trace, by scorer name. */
export async function scoresOfTrace(
  projectId: string,
  traceId: string,
  db: ScorerDb = getDb(),
): Promise<ScoreOfTrace[]> {
  return db
    .select({
      scorerId: scorers.id,
      scorerName: scorers.name,
      value: traceScores.value,
      passed: traceScores.passed,
      confidence: traceScores.confidence,
    })
    .from(traceScores)
    .innerJoin(scorers, eq(scorers.id, traceScores.scorerId))
    .where(and(eq(traceScores.projectId, projectId), eq(traceScores.traceId, traceId)))
    .orderBy(asc(scorers.name), asc(scorers.id));
}

/** Which of these traces the scorer already scored. */
export async function scoredTraceIds(
  scorerId: string,
  traceIds: readonly string[],
  db: ScorerDb = getDb(),
): Promise<Set<string>> {
  if (traceIds.length === 0) return new Set();
  const rows = await db
    .select({ traceId: traceScores.traceId })
    .from(traceScores)
    .where(and(eq(traceScores.scorerId, scorerId), inArray(traceScores.traceId, [...traceIds])));
  return new Set(rows.map((row) => row.traceId));
}

/** A row as a scorer; null when its stored settings no longer parse (it is then never run). */
export function scorerOf(row: ScorerRow): Scorer | null {
  const definition = parseDefinition(row.kind, row.config);
  const filter = parseFilter(row.filter);
  if (typeof definition === "string" || !filter) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    filter,
    sampleRate: row.sampleRate,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...definition,
  };
}

const summaryColumns = {
  scored: sql<number>`count(*)::int`,
  passRate: sql<
    number | null
  >`avg(case when ${traceScores.passed} then 1.0 when not ${traceScores.passed} then 0.0 end)::float8`,
  average: sql<number | null>`avg(${traceScores.value})::float8`,
};

/** The column changes of a switch: the cursor moves to now only on a change from off to on. */
function enabledChange(enabled: boolean) {
  return {
    enabled,
    cursorAt: sql`case when ${enabled} and not ${scorers.enabled} then now() else ${scorers.cursorAt} end`,
    cursorTraceId: sql`case when ${enabled} and not ${scorers.enabled} then '' else ${scorers.cursorTraceId} end`,
  };
}
