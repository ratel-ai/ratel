import { getDb } from "@/lib/platform/db/client";
import { dailyScoresFor, scorersFor, type TaskScorer } from "@/lib/views/task-scorers/store";
import type { ScorerKind as BuiltInKind } from "@/lib/views/task-scorers/types";
import { fromLegacy, legacyScorerId } from "./adapters/legacy";
import { type DailyRate, dailyRates, evalRunScores } from "./adapters/run-scores";
import { drizzleScorerRepository } from "./adapters/store";
import type { Scorer } from "./domain/types";
import { lastDays, type ScorerRow, scorerRows, suiteScorerHref, taskScorerHref } from "./view";

/** RC-615: what the scorer list and the detail pages read. The caller enforces `cloud-eval-gate`. */

type Db = ReturnType<typeof getDb>;

const LEGACY_ID = /^legacy:(.{1,500}):([a-z_]+)$/;

/** The task's scorers: its own, then the built-in ones with their daily counts. */
export async function taskScorerList(
  projectId: string,
  taskId: string,
  today: string,
  db: Db = getDb(),
): Promise<ScorerRow[]> {
  const days = lastDays(today);
  const [own, builtIn, daily] = await Promise.all([
    drizzleScorerRepository(db).list(projectId, { taskId, scope: "task" }),
    scorersFor(projectId, taskId, db),
    dailyScoresFor(projectId, taskId, db),
  ]);
  return scorerRows({
    own,
    rates: await ratesOf(projectId, own, db),
    days,
    hrefOf: (id) => taskScorerHref(projectId, taskId, id),
    builtIn: builtIn.map((scorer) => ({
      id: legacyScorerId(taskId, scorer.kind),
      name: fromLegacy(taskId, scorer).name,
      enabled: scorer.enabled,
      rates: daily
        .filter((row) => row.scorerKind === scorer.kind)
        .map((row) => ({ day: row.day, n: row.n, passed: row.passed })),
    })),
  });
}

/** The suite's scorers. */
export async function suiteScorerList(
  projectId: string,
  today: string,
  db: Db = getDb(),
): Promise<ScorerRow[]> {
  const own = await drizzleScorerRepository(db).list(projectId, { scope: "suite" });
  return scorerRows({
    own,
    builtIn: [],
    rates: await ratesOf(projectId, own, db),
    days: lastDays(today),
    hrefOf: (id) => suiteScorerHref(projectId, id),
  });
}

export type ScorerDetail =
  | { kind: "own"; scorer: Scorer; rates: DailyRate[] }
  | { kind: "built-in"; taskId: string; scorer: TaskScorer };

/** One scorer for its detail page; null when it is not in the project (or not this task's). */
export async function scorerDetail(
  projectId: string,
  scorerId: string,
  taskId: string | null,
  db: Db = getDb(),
): Promise<ScorerDetail | null> {
  const legacy = LEGACY_ID.exec(scorerId);
  if (legacy) {
    if (legacy[1] !== taskId) return null;
    const scorer = (await scorersFor(projectId, taskId, db)).find(
      (item) => item.kind === (legacy[2] as BuiltInKind),
    );
    return scorer ? { kind: "built-in", taskId, scorer } : null;
  }
  const scorer = await drizzleScorerRepository(db).get(projectId, scorerId);
  if (!scorer || scorer.taskId !== taskId) return null;
  return { kind: "own", scorer, rates: await dailyRates(projectId, scorer.id, db) };
}

/** The user scorers an eval inherits from its tasks and the suite, each with its switch for this eval. */
export async function evalScorerSwitches(
  projectId: string,
  evalId: string,
  tasks: readonly string[],
  db: Db = getDb(),
) {
  const repo = drizzleScorerRepository(db);
  const all = (await repo.list(projectId)).filter(
    (scorer) =>
      scorer.scope === "suite" || (scorer.taskId !== null && tasks.includes(scorer.taskId)),
  );
  const overrides = new Map(
    ((await repo.overrides(projectId, [evalId])).get(evalId) ?? []).map((override) => [
      override.scorerId,
      override.enabled,
    ]),
  );
  return all.map((scorer) => ({
    id: scorer.id,
    name: scorer.name,
    scope: scorer.scope,
    enabled: scorer.enabled,
    on: overrides.get(scorer.id) ?? scorer.enabled,
    overridden: overrides.has(scorer.id),
  }));
}

export type EvalScorerSwitch = Awaited<ReturnType<typeof evalScorerSwitches>>[number];

/** RC-628: each user scorer's reading of one eval in one run, with the scorers this eval switches off. */
export async function evalRunReadings(
  projectId: string,
  evalRunId: string,
  evalId: string,
  tasks: readonly string[],
  db: Db = getDb(),
) {
  const rows = (await evalRunScores(projectId, evalRunId, db)).filter(
    (row) => row.evalId === evalId,
  );
  const switches = await evalScorerSwitches(projectId, evalId, tasks, db);
  const names = new Map(switches.map((scorer) => [scorer.id, scorer.name]));
  return {
    readings: rows.map((row) => ({
      scorerId: row.scorerId,
      name: names.get(row.scorerId) ?? "Removed scorer",
      status: row.status,
      detail: row.detail,
    })),
    off: switches.filter((scorer) => !scorer.on).map((scorer) => scorer.name),
  };
}

export type EvalRunReadings = Awaited<ReturnType<typeof evalRunReadings>>;

async function ratesOf(projectId: string, scorers: readonly Scorer[], db: Db) {
  return new Map(
    await Promise.all(
      scorers.map(
        async (scorer) => [scorer.id, await dailyRates(projectId, scorer.id, db)] as const,
      ),
    ),
  );
}
