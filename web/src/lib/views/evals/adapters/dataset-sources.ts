import { and, avg, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { QUERY_VERSION } from "@/lib/contracts/query";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { QueryError, runQuery, type SqlResult } from "@/lib/synthesis/metrics/query";
import { RQL_VERSION } from "@/lib/synthesis/rql/compile";
import { traceScores } from "@/lib/views/scorers/schema";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import { selectTaskEvalRuns } from "@/lib/views/task-evals/selection";
import { readOnlyTools } from "../console-deps";
import { caseFromTurn } from "../domain/from-turn";
import type { DatasetSources } from "../ports/dataset-sources";
import { loadTurnContent } from "../turn-content";

type Db = Pick<ReturnType<typeof getDb>, "select" | "selectDistinct">;

/** An OTLP turn is the run of one trace: its key is `otlp:<trace id>`. */
const OTLP_KEY = "otlp:";
/** The most turns that the task selection takes at once (`selection.ts`). */
const MAX_SELECTION = 200;

/**
 * The reads of a query dataset over the real database, RQL and the task selection. Each read is of
 * one project: the turns, the traces and the scores of another project are never read.
 */
export function createDatasetSources(db: Db = getDb()): DatasetSources {
  const closedTurns = (projectId: string) =>
    and(eq(traceTurns.projectId, projectId), eq(traceTurns.status, "closed"));
  return {
    readContent: (projectId) => contentOptIn(projectId),

    async newestTurns(projectId, limit) {
      const rows = await db
        .select({ id: traceTurns.id })
        .from(traceTurns)
        .where(closedTurns(projectId))
        .orderBy(desc(traceTurns.endedAt), desc(traceTurns.id))
        .limit(limit);
      return rows.map(({ id }) => id);
    },

    async taskTurns(projectId, taskId, limit) {
      const rows = await db
        .select({ id: traceTurns.id })
        .from(traceTurns)
        .where(and(closedTurns(projectId), eq(traceTurns.workflowId, taskId)))
        .orderBy(desc(traceTurns.endedAt), desc(traceTurns.id))
        .limit(limit);
      return rows.map(({ id }) => id);
    },

    async rqlTraces(projectId, text, window) {
      // RQL is behind custom monitoring (ADR 0011): a dataset does not open it.
      if (!(await featureEnabled("customMonitoring", { projectId }))) {
        return {
          ok: false,
          message: "RQL is not on for this project, so a dataset of kind rql cannot run.",
        };
      }
      let result: SqlResult;
      try {
        result = (await runQuery(
          projectId,
          { version: QUERY_VERSION, kind: "sql", text, rqlVersion: RQL_VERSION },
          window,
        )) as SqlResult;
      } catch (error) {
        if (error instanceof QueryError) return { ok: false, message: error.message };
        throw error;
      }
      const column = result.columns.findIndex(({ name }) => name === "trace_id");
      if (column < 0) {
        return {
          ok: false,
          message: "The query gives no trace_id column. Select trace_id, for example from traces.",
        };
      }
      const traceIds = result.rows.flatMap((row) => {
        const value = row[column];
        return typeof value === "string" && value ? [value.toLowerCase()] : [];
      });
      return { ok: true, traceIds, truncated: result.truncated };
    },

    async turnsOfTraces(projectId, traceIds) {
      const ids = [...new Set(traceIds.map((id) => id.toLowerCase()))];
      if (ids.length === 0) return [];
      const [otlp, runtime] = await Promise.all([
        db
          .select({ id: traceTurns.id, key: traceTurns.turnKey })
          .from(traceTurns)
          .where(
            and(
              closedTurns(projectId),
              inArray(
                traceTurns.turnKey,
                ids.map((id) => `${OTLP_KEY}${id}`),
              ),
            ),
          ),
        db
          .selectDistinct({ id: traceTurnSteps.turnId, traceId: traceEvents.traceId })
          .from(traceTurnSteps)
          .innerJoin(
            traceEvents,
            and(
              eq(traceEvents.projectId, projectId),
              eq(traceEvents.id, traceTurnSteps.traceEventId),
            ),
          )
          .innerJoin(traceTurns, eq(traceTurns.id, traceTurnSteps.turnId))
          .where(
            and(
              eq(traceTurnSteps.projectId, projectId),
              closedTurns(projectId),
              isNotNull(traceEvents.traceId),
              inArray(traceEvents.traceId, ids),
            ),
          ),
      ]);
      const byTrace = new Map<string, string[]>();
      for (const { id, key } of otlp) byTrace.set(key.slice(OTLP_KEY.length), [id]);
      for (const { id, traceId } of runtime) {
        if (!traceId) continue;
        byTrace.set(traceId, [...(byTrace.get(traceId) ?? []), id]);
      }
      // In the order of the query.
      return [...new Set(ids.flatMap((id) => byTrace.get(id) ?? []))];
    },

    async chooseCandidates(projectId, limit) {
      const turns = await db
        .select({
          turnId: traceTurns.id,
          taskId: traceTurns.workflowId,
          endedAt: traceTurns.endedAt,
          key: traceTurns.turnKey,
          errors: traceTurns.errorCount,
        })
        .from(traceTurns)
        .where(closedTurns(projectId))
        .orderBy(desc(traceTurns.endedAt), desc(traceTurns.id))
        .limit(limit);
      const traceIds = turns.flatMap(({ key }) =>
        key.startsWith(OTLP_KEY) ? [key.slice(OTLP_KEY.length)] : [],
      );
      const scores =
        traceIds.length === 0
          ? []
          : await db
              .select({
                traceId: traceScores.traceId,
                score: avg(sql<number>`case when ${traceScores.passed} then 1 else 0 end`),
              })
              .from(traceScores)
              .where(
                and(
                  eq(traceScores.projectId, projectId),
                  inArray(traceScores.traceId, traceIds),
                  isNotNull(traceScores.passed),
                ),
              )
              .groupBy(traceScores.traceId);
      const scoreOf = new Map(scores.map(({ traceId, score }) => [traceId, Number(score)]));
      return turns.map(({ turnId, taskId, endedAt, key, errors }) => ({
        turnId,
        taskId,
        endedAt,
        failed: errors > 0,
        score: key.startsWith(OTLP_KEY) ? (scoreOf.get(key.slice(OTLP_KEY.length)) ?? null) : null,
      }));
    },

    async chooseForTask(projectId, taskId, limit) {
      const picked = await selectTaskEvalRuns({
        projectId,
        taskId,
        targetRuns: Math.min(limit, MAX_SELECTION),
      });
      return picked.map(({ turnId }) => turnId);
    },

    async turnRow(projectId, turnId) {
      const turn = await loadTurnContent(projectId, turnId);
      const made = turn && caseFromTurn(turn, await readOnlyTools(projectId));
      if (!made) return null;
      return {
        name: made.name,
        content: made.content,
        sourceTurnId: turnId,
        sourceOutput: made.sourceOutput,
      };
    },
  };
}
