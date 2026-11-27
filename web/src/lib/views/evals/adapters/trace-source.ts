import { and, desc, eq, inArray } from "drizzle-orm";
import { QUERY_VERSION } from "@/lib/contracts/query";
import { traceTurns } from "@/lib/ledger/schema";
import type { getDb } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { projects } from "@/lib/platform/projects/schema";
import { runQuery } from "@/lib/synthesis/metrics/query";
import { RQL_LIMITS, RQL_VERSION } from "@/lib/synthesis/rql/compile";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import { selectTaskEvalRuns } from "@/lib/views/task-evals/selection";
import { chooseSpread } from "../domain/dataset";
import type { TraceSource } from "../ports/trace-source";
import { loadTurnContent } from "../turn-content";

type Db = ReturnType<typeof getDb>;

const OTLP_KEY = "otlp:";
const DAY_MS = 24 * 60 * 60_000;
/** The most turns that the task selection takes (`task-evals/selection.ts`). */
const MAX_TASK_SELECTION = 200;
/** "Let Ratel choose" reads this many recent turns for each row that it takes. */
const CANDIDATES_PER_ROW = 4;

/**
 * The traces, the tasks and RQL over their public functions. RQL reads the longest window that it
 * has. "Let Ratel choose" with a task is the selection of task evals; without a task it is
 * `chooseSpread` over the recent closed turns.
 */
export function createTraceSource(
  db: Db,
  deps: {
    readOnlyTools: TraceSource["readOnlyTools"];
    now: () => Date;
    /** Whether RQL is on for the project: the `customMonitoring` flag, as for `run_rql`. */
    rqlEnabled?: (projectId: string) => Promise<boolean>;
  },
): TraceSource {
  const rqlEnabled = deps.rqlEnabled ?? ((projectId: string) => rqlOn(db, projectId));
  const closedTurns = (projectId: string, limit: number, taskId?: string) =>
    db
      .select({
        id: traceTurns.id,
        workflowId: traceTurns.workflowId,
        errorCount: traceTurns.errorCount,
        abandoned: traceTurns.abandoned,
        endedAt: traceTurns.endedAt,
      })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, projectId),
          eq(traceTurns.status, "closed"),
          taskId === undefined ? undefined : eq(traceTurns.workflowId, taskId),
        ),
      )
      .orderBy(desc(traceTurns.endedAt), desc(traceTurns.id))
      .limit(limit);

  return {
    readContent: (projectId) => contentOptIn(projectId, db),

    async lastTurns(projectId, limit) {
      return (await closedTurns(projectId, limit)).map(({ id }) => id);
    },

    async taskTurns(projectId, taskId, limit) {
      return (await closedTurns(projectId, limit, taskId)).map(({ id }) => id);
    },

    async runRql(projectId, text) {
      if (!(await rqlEnabled(projectId))) {
        return {
          ok: false,
          message: "RQL is not on for this project, so an RQL dataset cannot resolve here.",
        };
      }
      const until = deps.now();
      const since = new Date(until.getTime() - RQL_LIMITS.maxWindowDays * DAY_MS);
      try {
        const result = await runQuery(
          projectId,
          { version: QUERY_VERSION, kind: "sql", text, rqlVersion: RQL_VERSION },
          { since, until },
        );
        return { ok: true, columns: result.columns, rows: result.rows };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },

    async turnsOfTraces(projectId, traceIds) {
      if (traceIds.length === 0) return new Map();
      const rows = await db
        .select({ id: traceTurns.id, turnKey: traceTurns.turnKey })
        .from(traceTurns)
        .where(
          and(
            eq(traceTurns.projectId, projectId),
            inArray(
              traceTurns.turnKey,
              traceIds.map((id) => `${OTLP_KEY}${id}`),
            ),
          ),
        );
      return new Map(rows.map(({ id, turnKey }) => [turnKey.slice(OTLP_KEY.length), id]));
    },

    async chooseTurns(projectId, taskId, limit) {
      if (taskId !== null) {
        const chosen = await selectTaskEvalRuns(
          { projectId, taskId, targetRuns: Math.min(limit, MAX_TASK_SELECTION) },
          db,
        );
        return chosen.map(({ turnId }) => turnId);
      }
      const recent = await closedTurns(projectId, limit * CANDIDATES_PER_ROW);
      return chooseSpread(
        recent.map(({ id, workflowId, errorCount, abandoned, endedAt }) => ({
          turnId: id,
          taskId: workflowId,
          failed: errorCount > 0 || abandoned === true,
          endedAt,
        })),
        limit,
      );
    },

    loadTurn: loadTurnContent,
    readOnlyTools: deps.readOnlyTools,
  };
}

/** The `customMonitoring` flag of the project's organization: the flag of `run_rql`. */
async function rqlOn(db: Db, projectId: string): Promise<boolean> {
  const [project] = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) return false;
  return featureEnabled("customMonitoring", {
    organizationId: project.organizationId,
    projectId,
    actor: `project:${projectId}`,
  });
}
