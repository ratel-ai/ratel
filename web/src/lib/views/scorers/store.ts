import { and, asc, count, desc, eq, gte, inArray, notInArray, type SQL, sql } from "drizzle-orm";

import { getDb } from "@/lib/platform/db/client";
import { parseDefinition, parseFilter } from "./config";
import { type ScorerRow, traceScorers, traceScorerTasks, traceScores } from "./schema";
import { taskTraces } from "./traces";
import type { Scorer, ScorerDraft, ScorerScope, TraceScore } from "./types";

type Db = ReturnType<typeof getDb>;
/** The database, or the transaction a caller already holds. */
export type ScorerDb = Pick<
  Db,
  "select" | "insert" | "update" | "delete" | "execute" | "transaction"
>;

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
    .from(traceScorers)
    .where(eq(traceScorers.projectId, projectId))
    .orderBy(asc(traceScorers.createdAt), asc(traceScorers.id));
  return scorersOf(rows, db);
}

/** The scorers attached to a task, oldest first. */
export async function listTaskScorers(
  projectId: string,
  taskId: string,
  db: ScorerDb = getDb(),
): Promise<Scorer[]> {
  const rows = await db
    .select({ scorer: traceScorers })
    .from(traceScorerTasks)
    .innerJoin(traceScorers, eq(traceScorers.id, traceScorerTasks.scorerId))
    .where(
      and(
        eq(traceScorerTasks.projectId, projectId),
        eq(traceScorerTasks.taskId, taskId),
        eq(traceScorers.scope, "tasks"),
      ),
    )
    .orderBy(asc(traceScorers.createdAt), asc(traceScorers.id));
  return scorersOf(
    rows.map((row) => row.scorer),
    db,
  );
}

export async function getScorer(
  projectId: string,
  scorerId: string,
  db: ScorerDb = getDb(),
): Promise<Scorer | null> {
  const [row] = await db
    .select()
    .from(traceScorers)
    .where(and(eq(traceScorers.projectId, projectId), eq(traceScorers.id, scorerId)));
  return row ? ((await scorersOf([row], db))[0] ?? null) : null;
}

export async function countScorers(projectId: string, db: ScorerDb = getDb()): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(traceScorers)
    .where(eq(traceScorers.projectId, projectId));
  return row?.count ?? 0;
}

export async function createScorer(
  projectId: string,
  draft: ScorerDraft,
  actor: string,
  db: ScorerDb = getDb(),
): Promise<string> {
  const { tasks, ...settings } = draft;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(traceScorers)
      .values({
        projectId,
        ...settings,
        scope: scopeOf(tasks),
        createdBy: actor,
        updatedBy: actor,
      })
      .returning({ id: traceScorers.id });
    if (!row) throw new Error("the scorer insert returned no row");
    await replaceTasks(projectId, row.id, tasks, tx);
    return row.id;
  });
}

/** Replace a scorer's settings, except its kind. Stored results stay. False when there is none. */
export async function updateScorer(
  projectId: string,
  scorerId: string,
  draft: ScorerDraft,
  actor: string,
  db: ScorerDb = getDb(),
): Promise<boolean> {
  const { kind, enabled, tasks, ...settings } = draft;
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(traceScorers)
      .set({
        ...settings,
        ...enabledChange(enabled),
        scope: scopeOf(tasks),
        updatedBy: actor,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(traceScorers.projectId, projectId),
          eq(traceScorers.id, scorerId),
          eq(traceScorers.kind, kind),
        ),
      )
      .returning({ id: traceScorers.id });
    if (rows.length === 0) return false;
    await replaceTasks(projectId, scorerId, tasks, tx);
    return true;
  });
}

/**
 * Attach a scorer to a task; from its next sweep it scores the task's traces. One that scores every
 * trace is narrowed to this task. False when there is none.
 */
export async function attachScorer(
  projectId: string,
  scorerId: string,
  taskId: string,
  actor: string,
  db: ScorerDb = getDb(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(traceScorers)
      .set({ scope: "tasks", updatedBy: actor, updatedAt: new Date() })
      .where(and(eq(traceScorers.projectId, projectId), eq(traceScorers.id, scorerId)))
      .returning({ id: traceScorers.id });
    if (rows.length === 0) return false;
    await tx.insert(traceScorerTasks).values({ projectId, scorerId, taskId }).onConflictDoNothing();
    return true;
  });
}

/**
 * Detach a scorer from a task: no new score for the task's traces. Stored results stay, and the
 * scorer keeps its scope, so one without a task left scores nothing. False when it was not attached.
 */
export async function detachScorer(
  projectId: string,
  scorerId: string,
  taskId: string,
  actor: string,
  db: ScorerDb = getDb(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .delete(traceScorerTasks)
      .where(
        and(
          eq(traceScorerTasks.projectId, projectId),
          eq(traceScorerTasks.scorerId, scorerId),
          eq(traceScorerTasks.taskId, taskId),
        ),
      )
      .returning({ scorerId: traceScorerTasks.scorerId });
    if (rows.length === 0) return false;
    await tx
      .update(traceScorers)
      .set({ updatedBy: actor, updatedAt: new Date() })
      .where(eq(traceScorers.id, scorerId));
    return true;
  });
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
    .update(traceScorers)
    .set({ ...enabledChange(enabled), updatedBy: actor, updatedAt: new Date() })
    .where(and(eq(traceScorers.projectId, projectId), eq(traceScorers.id, scorerId)))
    .returning({ id: traceScorers.id });
  return rows.length > 0;
}

/** Delete a scorer and every result it stored. */
export async function deleteScorer(
  projectId: string,
  scorerId: string,
  db: ScorerDb = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(traceScorers)
    .where(and(eq(traceScorers.projectId, projectId), eq(traceScorers.id, scorerId)))
    .returning({ id: traceScorers.id });
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

/** Per scorer id, its results of traces that started at or after `since`; with a task, only of its traces. */
export async function scorerSummaries(
  projectId: string,
  since: Date,
  db: ScorerDb = getDb(),
  taskId?: string,
): Promise<Map<string, ScorerSummary>> {
  const rows = await db
    .select({ scorerId: traceScores.scorerId, ...summaryColumns })
    .from(traceScores)
    .where(
      and(
        eq(traceScores.projectId, projectId),
        gte(traceScores.traceStartedAt, since),
        ofTask(projectId, taskId),
      ),
    )
    .groupBy(traceScores.scorerId);
  return new Map(rows.map(({ scorerId, ...summary }) => [scorerId, summary]));
}

/** One scorer's results per UTC day, oldest first; with a task, only of its traces. A day without results has no row. */
export async function scorerTrend(
  projectId: string,
  scorerId: string,
  since: Date,
  db: ScorerDb = getDb(),
  taskId?: string,
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
        ofTask(projectId, taskId),
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
      scorerId: traceScorers.id,
      scorerName: traceScorers.name,
      value: traceScores.value,
      passed: traceScores.passed,
      confidence: traceScores.confidence,
    })
    .from(traceScores)
    .innerJoin(traceScorers, eq(traceScorers.id, traceScores.scorerId))
    .where(and(eq(traceScores.projectId, projectId), eq(traceScores.traceId, traceId)))
    .orderBy(asc(traceScorers.name), asc(traceScorers.id));
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

/** Rows as scorers with their tasks, in order. One whose stored settings no longer parse is left out (it is then never run). */
export async function scorersOf(
  rows: readonly ScorerRow[],
  db: ScorerDb = getDb(),
): Promise<Scorer[]> {
  const scoped = rows.filter((row) => row.scope === "tasks").map((row) => row.id);
  const links =
    scoped.length === 0
      ? []
      : await db
          .select({ scorerId: traceScorerTasks.scorerId, taskId: traceScorerTasks.taskId })
          .from(traceScorerTasks)
          .where(inArray(traceScorerTasks.scorerId, scoped))
          .orderBy(asc(traceScorerTasks.createdAt), asc(traceScorerTasks.taskId));
  const tasks = new Map<string, string[]>(scoped.map((id) => [id, []]));
  for (const { scorerId, taskId } of links) tasks.get(scorerId)?.push(taskId);
  return rows.flatMap((row) => scorerOf(row, tasks.get(row.id) ?? null) ?? []);
}

function scorerOf(row: ScorerRow, tasks: string[] | null): Scorer | null {
  const definition = parseDefinition(row.kind, row.config);
  const filter = parseFilter(row.filter);
  if ("ok" in definition || !filter) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    filter,
    tasks,
    sampleRate: row.sampleRate,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...definition,
  };
}

function scopeOf(tasks: ScorerDraft["tasks"]): ScorerScope {
  return tasks === null ? "all" : "tasks";
}

/** Make a scorer's links exactly these; a kept link keeps its place. */
async function replaceTasks(
  projectId: string,
  scorerId: string,
  tasks: ScorerDraft["tasks"],
  db: Pick<ScorerDb, "delete" | "insert">,
): Promise<void> {
  const ids = [...(tasks ?? [])];
  await db
    .delete(traceScorerTasks)
    .where(
      and(
        eq(traceScorerTasks.scorerId, scorerId),
        ids.length > 0 ? notInArray(traceScorerTasks.taskId, ids) : undefined,
      ),
    );
  if (ids.length > 0)
    await db
      .insert(traceScorerTasks)
      .values(ids.map((taskId) => ({ projectId, scorerId, taskId })))
      .onConflictDoNothing();
}

function ofTask(projectId: string, taskId: string | undefined): SQL | undefined {
  return taskId === undefined
    ? undefined
    : sql`${traceScores.traceId} in (${taskTraces(projectId, [taskId])})`;
}

const summaryColumns = {
  scored: sql<number>`count(*)::int`,
  passRate: sql<
    number | null
  >`avg(case when ${traceScores.passed} then 1.0 when not ${traceScores.passed} then 0.0 end)::float8`,
  average: sql<number | null>`avg(${traceScores.value})::float8`,
};

/** The column changes of a switch: a judge that waits is asked at once, and the cursor moves to now only on a change from off to on. */
function enabledChange(enabled: boolean) {
  return {
    enabled,
    judgeAttempts: 0,
    judgeRetryAt: null,
    cursorAt: sql`case when ${enabled} and not ${traceScorers.enabled} then now() else ${traceScorers.cursorAt} end`,
    cursorTraceId: sql`case when ${enabled} and not ${traceScorers.enabled} then '' else ${traceScorers.cursorTraceId} end`,
  };
}
