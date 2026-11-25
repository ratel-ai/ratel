import { and, asc, count, desc, eq, inArray, lt, ne, notExists, sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { storable } from "@/lib/platform/storable";
import type { Experiment, ExperimentState, Trial, TrialState } from "../domain/experiment";
import type { TrialResult } from "../domain/score";
import type { ExperimentStore } from "../ports/experiment-store";
import { evalCaseVersions, evalExperiments, evalTrials } from "../schema";
import { toVersion } from "./drizzle-case-store";

type Db = Pick<ReturnType<typeof getDb>, "select" | "update" | "transaction">;

/** Rows of one insert: Postgres has a limit of 65,535 values. */
const CHUNK = 1_000;

export function createDrizzleExperimentStore(db: Db): ExperimentStore {
  return {
    create(input) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(evalExperiments)
          .values({ ...input, params: storable(input.params) })
          .returning();
        if (!row) throw new Error("the experiment row is missing");
        const rows = input.caseVersions.flatMap(({ versionId }, position) =>
          Array.from({ length: input.trialsPerCase }, (_, index) => ({
            experimentId: row.id,
            caseVersionId: versionId,
            position: position * input.trialsPerCase + index,
            index,
          })),
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
      if (rows.length === 0) return [];
      const trials = await db
        .select({ experimentId: evalTrials.experimentId, result: evalTrials.result })
        .from(evalTrials)
        .where(
          inArray(
            evalTrials.experimentId,
            rows.map(({ id }) => id),
          ),
        );
      const byExperiment = Map.groupBy(trials, ({ experimentId }) => experimentId);
      return rows.map((row) => ({
        experiment: toExperiment(row),
        trials: (byExperiment.get(row.id) ?? []).map(({ result }) => ({
          result: result as TrialResult | null,
        })),
      }));
    },

    async trials(experimentId) {
      const rows = await db
        .select()
        .from(evalTrials)
        .where(eq(evalTrials.experimentId, experimentId))
        .orderBy(asc(evalTrials.position));
      return rows.map(toTrial);
    },

    async listRunning(limit) {
      const rows = await db
        .select()
        .from(evalExperiments)
        .where(eq(evalExperiments.state, "running"))
        .orderBy(asc(evalExperiments.createdAt))
        .limit(limit);
      return rows.map(toExperiment);
    },

    async caseVersion(versionId) {
      const [row] = await db
        .select()
        .from(evalCaseVersions)
        .where(eq(evalCaseVersions.id, versionId));
      return row ? toVersion(row) : null;
    },

    claimStarts(experimentId, open, now) {
      return db.transaction(async (tx) => {
        // One claim of an experiment at a time, so the count below is right.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`eval_starts:${experimentId}`}, 0))`,
        );
        const [row] = await tx
          .select({ open: count() })
          .from(evalTrials)
          .where(
            and(
              eq(evalTrials.experimentId, experimentId),
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
          .returning();
        return claimed.sort((left, right) => left.position - right.position).map(toTrial);
      });
    },

    async markRunning(trialId, sandboxRunId) {
      await db
        .update(evalTrials)
        .set({ state: "running", sandboxRunId, claimedAt: null })
        .where(and(eq(evalTrials.id, trialId), eq(evalTrials.state, "starting")));
    },

    async listRunningTrials(experimentId, limit) {
      const rows = await db
        .select()
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
      const { output, toolCalls, scorers, reason, ...rest } = outcome;
      await db
        .update(evalTrials)
        .set({
          ...rest,
          ...storable({ output: output ?? null, toolCalls, scorers, reason }),
          state: "done",
          claimedAt: null,
        })
        .where(and(eq(evalTrials.id, trialId), ne(evalTrials.state, "done")));
    },

    async releaseStopped(experimentId, before) {
      const stopped = and(
        eq(evalTrials.experimentId, experimentId),
        lt(evalTrials.claimedAt, before),
      );
      await db
        .update(evalTrials)
        .set({ state: "running", claimedAt: null })
        .where(and(stopped, eq(evalTrials.state, "scoring")));
      const left = await db
        .select()
        .from(evalTrials)
        .where(and(stopped, eq(evalTrials.state, "starting")));
      return left.map(toTrial);
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

function toExperiment(row: typeof evalExperiments.$inferSelect): Experiment {
  return { ...row, state: row.state as ExperimentState };
}

function toTrial(row: typeof evalTrials.$inferSelect): Trial {
  const { position: _, claimedAt: __, ...rest } = row;
  return {
    ...rest,
    state: row.state as TrialState,
    result: row.result as TrialResult | null,
    output: row.output ?? null,
  };
}
