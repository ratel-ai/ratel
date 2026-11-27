import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lt,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { storable } from "@/lib/platform/storable";
import type { CaseVersion } from "../domain/case";
import {
  type Experiment,
  type ExperimentState,
  emptyCounts,
  type Trial,
  type TrialOutcome,
  type TrialState,
  trialsOfCase,
  variantsOf,
} from "../domain/experiment";
import type { TrialResult } from "../domain/score";
import type { ExperimentStore } from "../ports/experiment-store";
import { evalCaseVersions, evalExperiments, evalRunRows, evalTrials } from "../schema";
import { toVersion } from "./drizzle-case-store";

type Db = Pick<ReturnType<typeof getDb>, "select" | "update" | "transaction">;

/** Rows of one insert: Postgres has a limit of 65,535 values. */
const CHUNK = 1_000;
const {
  output: _output,
  toolCalls: _toolCalls,
  claimedAt: _claimedAt,
  ...TRIAL
} = getTableColumns(evalTrials);

export function createDrizzleExperimentStore(db: Db): ExperimentStore {
  return {
    create(input, maxRunning) {
      return db.transaction(async (tx) => {
        // One start of a project at a time, so the count below is right.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`eval_experiments:${input.projectId}`}, 0))`,
        );
        const [running] = await tx
          .select({ count: count() })
          .from(evalExperiments)
          .where(
            and(
              eq(evalExperiments.projectId, input.projectId),
              eq(evalExperiments.state, "running"),
            ),
          );
        if ((running?.count ?? 0) >= maxRunning) return null;
        const { runRows = [], ...experiment } = input;
        const [row] = await tx
          .insert(evalExperiments)
          .values({
            ...experiment,
            params: storable(experiment.params),
            variants: storable(experiment.variants),
            changes: storable(experiment.changes),
          })
          .returning();
        if (!row) throw new Error("the experiment row is missing");
        const runRowValues = runRows.map((one, position) => ({
          id: one.id,
          experimentId: row.id,
          position,
          ...storable({
            name: one.name,
            input: { value: one.content.input ?? null },
            earlierTurns: one.content.earlierTurns,
            toolFixtures: one.content.toolFixtures,
            expectedOutput: one.content.expectedOutput,
            sourceOutput: one.sourceOutput,
          }),
          sourceTurnId: one.sourceTurnId,
        }));
        for (let start = 0; start < runRowValues.length; start += CHUNK) {
          await tx.insert(evalRunRows).values(runRowValues.slice(start, start + CHUNK));
        }
        let position = 0;
        // Each row, then each variant, then each trial: the rows start in their order.
        const variants = variantsOf(input);
        const rows = input.caseVersions.flatMap((frozen) =>
          variants.flatMap(({ index: variant }) =>
            Array.from({ length: trialsOfCase(input, frozen) }, (_, index) => ({
              experimentId: row.id,
              caseVersionId: frozen.versionId,
              position: position++,
              index,
              variant,
            })),
          ),
        );
        for (let start = 0; start < rows.length; start += CHUNK) {
          await tx.insert(evalTrials).values(rows.slice(start, start + CHUNK));
        }
        return toExperiment(row);
      });
    },

    async get(projectId, experimentId) {
      const [row] = await db
        .select()
        .from(evalExperiments)
        .where(and(eq(evalExperiments.projectId, projectId), eq(evalExperiments.id, experimentId)));
      return row ? toExperiment(row) : null;
    },

    async list(projectId, limit) {
      const rows = await db
        .select()
        .from(evalExperiments)
        .where(eq(evalExperiments.projectId, projectId))
        .orderBy(desc(evalExperiments.createdAt), desc(evalExperiments.id))
        .limit(limit);
      return rows.map(toExperiment);
    },

    async listOfEval(projectId, evalId, limit) {
      const rows = await db
        .select()
        .from(evalExperiments)
        .where(
          and(
            eq(evalExperiments.projectId, projectId),
            or(
              eq(evalExperiments.evalId, evalId),
              and(
                isNull(evalExperiments.evalId),
                sql`${evalExperiments.evalVersions} @> ${JSON.stringify([{ evalId }])}::jsonb`,
              ),
            ),
          ),
        )
        .orderBy(desc(evalExperiments.createdAt), desc(evalExperiments.id))
        .limit(limit);
      return rows.map(toExperiment);
    },

    async counts(experimentIds) {
      const counts = new Map(experimentIds.map((id) => [id, emptyCounts()]));
      if (experimentIds.length === 0) return counts;
      const rows = await db
        .select({
          experimentId: evalTrials.experimentId,
          result: evalTrials.result,
          count: count(),
        })
        .from(evalTrials)
        .where(inArray(evalTrials.experimentId, [...experimentIds]))
        .groupBy(evalTrials.experimentId, evalTrials.result);
      for (const row of rows) {
        const of = counts.get(row.experimentId);
        if (of) of[(row.result as TrialResult | null) ?? "open"] = row.count;
      }
      return counts;
    },

    async trials(experimentId) {
      const rows = await db
        .select(TRIAL)
        .from(evalTrials)
        .where(eq(evalTrials.experimentId, experimentId))
        .orderBy(asc(evalTrials.position));
      return rows.map(toTrial);
    },

    async trialEvidence(projectId, trialId) {
      const [row] = await db
        .select({ output: evalTrials.output, toolCalls: evalTrials.toolCalls })
        .from(evalTrials)
        .innerJoin(evalExperiments, eq(evalExperiments.id, evalTrials.experimentId))
        .where(and(eq(evalExperiments.projectId, projectId), eq(evalTrials.id, trialId)));
      return row ? { output: row.output?.value ?? null, toolCalls: row.toolCalls } : null;
    },

    async outputPreviews(experimentId, chars) {
      const rows = await db
        .select({
          id: evalTrials.id,
          text: sql<string>`left(${evalTrials.output}->'value' #>> '{}', ${chars})`,
        })
        .from(evalTrials)
        .where(
          and(
            eq(evalTrials.experimentId, experimentId),
            sql`${evalTrials.output}->'value' is not null`,
            sql`jsonb_typeof(${evalTrials.output}->'value') <> 'null'`,
          ),
        );
      return new Map(rows.map(({ id, text }) => [id, text]));
    },

    async caseVersions(versionIds) {
      if (versionIds.length === 0) return [];
      const ids = [...versionIds];
      const [rows, runRows] = await Promise.all([
        db.select().from(evalCaseVersions).where(inArray(evalCaseVersions.id, ids)),
        db.select().from(evalRunRows).where(inArray(evalRunRows.id, ids)),
      ]);
      return [...rows.map(toVersion), ...runRows.map(runRowVersion)];
    },

    async listRunning(limit) {
      const rows = await db
        .select()
        .from(evalExperiments)
        .where(eq(evalExperiments.state, "running"))
        .orderBy(sql`random()`)
        .limit(limit);
      return rows.map(toExperiment);
    },

    async caseVersion(versionId) {
      const [row] = await db
        .select()
        .from(evalCaseVersions)
        .where(eq(evalCaseVersions.id, versionId));
      if (row) return toVersion(row);
      const [runRow] = await db.select().from(evalRunRows).where(eq(evalRunRows.id, versionId));
      return runRow ? runRowVersion(runRow) : null;
    },

    claimStarts({ id: experimentId, projectId }, open, now) {
      return db.transaction(async (tx) => {
        // One claim of a project at a time, so the count below is right.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`eval_starts:${projectId}`}, 0))`,
        );
        const [row] = await tx
          .select({ open: count() })
          .from(evalTrials)
          .innerJoin(evalExperiments, eq(evalExperiments.id, evalTrials.experimentId))
          .where(
            and(
              eq(evalExperiments.projectId, projectId),
              eq(evalExperiments.state, "running"),
              inArray(evalTrials.state, ["starting", "running"]),
            ),
          );
        const room = open - (row?.open ?? 0);
        if (room <= 0) return [];
        const next = await tx
          .select({ id: evalTrials.id })
          .from(evalTrials)
          .where(and(eq(evalTrials.experimentId, experimentId), eq(evalTrials.state, "pending")))
          .orderBy(asc(evalTrials.position))
          .limit(room);
        if (next.length === 0) return [];
        const claimed = await tx
          .update(evalTrials)
          .set({ state: "starting", claimedAt: now })
          .where(
            and(
              inArray(
                evalTrials.id,
                next.map(({ id }) => id),
              ),
              eq(evalTrials.state, "pending"),
            ),
          )
          .returning(TRIAL);
        return claimed.sort((left, right) => left.position - right.position).map(toTrial);
      });
    },

    async markRunning(trialId, sandboxRunId) {
      await db
        .update(evalTrials)
        .set({ state: "running", sandboxRunId, claimedAt: null })
        .where(and(eq(evalTrials.id, trialId), eq(evalTrials.state, "starting")));
    },

    async releaseStart(trialId) {
      await db
        .update(evalTrials)
        .set({ state: "pending", claimedAt: null })
        .where(and(eq(evalTrials.id, trialId), eq(evalTrials.state, "starting")));
    },

    async listRunningTrials(experimentId, limit) {
      const rows = await db
        .select(TRIAL)
        .from(evalTrials)
        .where(and(eq(evalTrials.experimentId, experimentId), eq(evalTrials.state, "running")))
        .orderBy(asc(evalTrials.position))
        .limit(limit);
      return rows.map(toTrial);
    },

    async claimScoring(trialId, now) {
      const rows = await db
        .update(evalTrials)
        .set({ state: "scoring", claimedAt: now })
        .where(and(eq(evalTrials.id, trialId), eq(evalTrials.state, "running")))
        .returning({ id: evalTrials.id });
      return rows.length > 0;
    },

    async finish(trialId, outcome) {
      await db
        .update(evalTrials)
        .set(done(outcome))
        .where(and(eq(evalTrials.id, trialId), ne(evalTrials.state, "done")));
    },

    async releaseStoppedScorings(experimentId, before) {
      await db
        .update(evalTrials)
        .set({ state: "running", claimedAt: null })
        .where(stopped(experimentId, "scoring", before));
    },

    async endStoppedStarts(experimentId, before, outcome) {
      const ended = await db
        .update(evalTrials)
        .set(done(outcome))
        .where(stopped(experimentId, "starting", before))
        .returning({ id: evalTrials.id });
      return ended.length;
    },

    async close(experimentId, now) {
      const open = db
        .select({ id: evalTrials.id })
        .from(evalTrials)
        .where(and(eq(evalTrials.experimentId, experimentId), ne(evalTrials.state, "done")));
      const rows = await db
        .update(evalExperiments)
        .set({ state: "completed", finishedAt: now })
        .where(
          and(
            eq(evalExperiments.id, experimentId),
            eq(evalExperiments.state, "running"),
            notExists(open),
          ),
        )
        .returning({ id: evalExperiments.id });
      return rows.length > 0;
    },
  };
}

function done({ output, toolCalls, scorers, reason, ...rest }: TrialOutcome) {
  return {
    ...rest,
    ...storable({ output: { value: output ?? null }, toolCalls, scorers, reason }),
    state: "done",
    claimedAt: null,
  };
}

/** The claims of a process that ended. */
function stopped(experimentId: string, state: TrialState, before: Date) {
  return and(
    eq(evalTrials.experimentId, experimentId),
    eq(evalTrials.state, state),
    lt(evalTrials.claimedAt, before),
  );
}

/** A row of a run, read as a case version: its own case, version 1. */
function runRowVersion(row: typeof evalRunRows.$inferSelect): CaseVersion {
  const { id, input, earlierTurns, toolFixtures, expectedOutput, sourceTurnId, sourceOutput } = row;
  return {
    id,
    caseId: sourceTurnId ?? id,
    number: 1,
    input: input.value ?? null,
    earlierTurns,
    toolFixtures,
    expectedOutput,
    sourceTurnId,
    sourceOutput,
    updatedAt: row.createdAt,
  };
}

function toExperiment(row: typeof evalExperiments.$inferSelect): Experiment {
  return { ...row, state: row.state as ExperimentState };
}

function toTrial({
  position: _,
  ...row
}: Pick<typeof evalTrials.$inferSelect, keyof typeof TRIAL>): Trial {
  return {
    ...row,
    state: row.state as TrialState,
    result: row.result as TrialResult | null,
  };
}
