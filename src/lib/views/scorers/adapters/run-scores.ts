import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import type { ScoreResult, Scorer } from "@/lib/views/scorers/domain/types";
import { runScores } from "@/lib/views/scorers/schema";

type Db = ReturnType<typeof getDb>;

/** One reading to store: a live run (`turnId`) or one eval of an eval run. */
export type RunScoreInput = {
  scorer: Pick<Scorer, "id" | "version">;
  result: ScoreResult;
  day: string;
} & ({ turnId: string } | { evalRunId: string; evalId: string });

export interface DailyRate {
  day: string;
  n: number;
  passed: number;
}

/** Write readings. A reading of the same run by the same scorer replaces the earlier one. */
export async function saveRunScores(
  projectId: string,
  inputs: readonly RunScoreInput[],
  db: Db = getDb(),
): Promise<void> {
  const turns = inputs.filter(
    (input): input is Extract<RunScoreInput, { turnId: string }> => "turnId" in input,
  );
  const evals = inputs.filter(
    (input): input is Extract<RunScoreInput, { evalRunId: string }> => "evalRunId" in input,
  );
  const set = {
    scorerVersion: sql`excluded.scorer_version`,
    day: sql`excluded.day`,
    status: sql`excluded.status`,
    value: sql`excluded.value`,
    passed: sql`excluded.passed`,
    detail: sql`excluded.detail`,
    scoredAt: sql`excluded.scored_at`,
  };
  if (turns.length > 0) {
    await db
      .insert(runScores)
      .values(turns.map((input) => ({ ...rowOf(projectId, input), turnId: input.turnId })))
      .onConflictDoUpdate({
        target: [runScores.scorerId, runScores.turnId],
        targetWhere: isNotNull(runScores.turnId),
        set,
      });
  }
  if (evals.length > 0) {
    await db
      .insert(runScores)
      .values(
        evals.map((input) => ({
          ...rowOf(projectId, input),
          evalRunId: input.evalRunId,
          evalId: input.evalId,
        })),
      )
      .onConflictDoUpdate({
        target: [runScores.scorerId, runScores.evalRunId, runScores.evalId],
        targetWhere: isNotNull(runScores.evalRunId),
        set,
      });
  }
}

/** For each scorer, the live runs it already read at its current version. */
export async function scoredTurns(
  projectId: string,
  scorers: readonly Pick<Scorer, "id" | "version">[],
  turnIds: readonly string[],
  db: Db = getDb(),
): Promise<Map<string, Set<string>>> {
  const out = new Map(scorers.map((scorer) => [scorer.id, new Set<string>()]));
  if (scorers.length === 0 || turnIds.length === 0) return out;
  const versions = new Map(scorers.map((scorer) => [scorer.id, scorer.version]));
  const rows = await db
    .select({
      scorerId: runScores.scorerId,
      turnId: runScores.turnId,
      version: runScores.scorerVersion,
    })
    .from(runScores)
    .where(
      and(
        eq(runScores.projectId, projectId),
        inArray(runScores.scorerId, [...versions.keys()]),
        inArray(runScores.turnId, [...turnIds]),
      ),
    );
  for (const row of rows)
    if (row.turnId && versions.get(row.scorerId) === row.version)
      out.get(row.scorerId)!.add(row.turnId);
  return out;
}

/** How many live runs each scorer read on a day, skips included: the model sample's count. */
export async function readingsOnDay(
  projectId: string,
  scorerIds: readonly string[],
  day: string,
  db: Db = getDb(),
): Promise<Map<string, number>> {
  const out = new Map(scorerIds.map((id) => [id, 0]));
  if (scorerIds.length === 0) return out;
  const rows = await db
    .select({ scorerId: runScores.scorerId, n: sql<number>`count(*)::int` })
    .from(runScores)
    .where(
      and(
        eq(runScores.projectId, projectId),
        inArray(runScores.scorerId, [...scorerIds]),
        eq(runScores.day, day),
        isNotNull(runScores.turnId),
      ),
    )
    .groupBy(runScores.scorerId);
  for (const row of rows) out.set(row.scorerId, Number(row.n));
  return out;
}

/** One scorer's pass counts by day, skips left out: its chart. */
export async function dailyRates(
  projectId: string,
  scorerId: string,
  db: Db = getDb(),
): Promise<DailyRate[]> {
  const rows = await db
    .select({
      day: runScores.day,
      n: sql<number>`count(*) filter (where ${runScores.status} <> 'skip')::int`,
      passed: sql<number>`count(*) filter (where ${runScores.status} = 'pass')::int`,
    })
    .from(runScores)
    .where(and(eq(runScores.projectId, projectId), eq(runScores.scorerId, scorerId)))
    .groupBy(runScores.day)
    .orderBy(asc(runScores.day));
  return rows.map((row) => ({ day: row.day, n: Number(row.n), passed: Number(row.passed) }));
}

/** The readings of one eval run, by eval. */
export async function evalRunScores(projectId: string, evalRunId: string, db: Db = getDb()) {
  return db
    .select()
    .from(runScores)
    .where(and(eq(runScores.projectId, projectId), eq(runScores.evalRunId, evalRunId)))
    .orderBy(asc(runScores.evalId), asc(runScores.scoredAt));
}

function rowOf(projectId: string, input: RunScoreInput) {
  return {
    projectId,
    scorerId: input.scorer.id,
    scorerVersion: input.scorer.version,
    day: input.day,
    status: input.result.status,
    value: input.result.value,
    passed: input.result.status === "skip" ? null : input.result.status === "pass",
    detail: input.result.detail.slice(0, 500),
  };
}
