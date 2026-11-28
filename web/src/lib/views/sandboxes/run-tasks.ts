import { sql } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import type { getDb } from "@/lib/platform/db/client";
import { SANDBOX_TASK_PREFIX } from "@/lib/readings/trace-signals/workflows/sandbox-tasks";
import { EVAL_TRIAL_PREFIX } from "./domain/run";
import { sandboxes, sandboxRuns, sandboxVersions } from "./schema";

type Db = Pick<ReturnType<typeof getDb>, "execute">;

/** The runs that a sweep links: the turn of a run is built some time after its end. */
export const RUN_TASKS_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Gives the turn of each recent sandbox run the task of its sandbox (`sandbox:<name>`,
 * `sandbox-tasks.ts`), so "Save as eval case" offers the eval of that task at once. The turn of a
 * run is its OTLP trace (`otlp:<trace id>`): it exists only after the agent's spans arrive, so the
 * per-minute drain runs it. An eval trial is left out: it is a run of an eval, not of the task. A
 * turn that has a task keeps it. Returns the number of turns linked.
 */
export async function linkRunTasks(db: Db, now: Date): Promise<number> {
  const since = new Date(now.getTime() - RUN_TASKS_WINDOW_MS);
  const result = await db.execute<{ id: string }>(sql`
    update ${traceTurns} as t
    set workflow_id = ${SANDBOX_TASK_PREFIX} || s.name
    from ${sandboxRuns} as r
    join ${sandboxVersions} as v on v.id = r.version_id
    join ${sandboxes} as s on s.id = v.sandbox_id
    where t.project_id = r.project_id
      and t.turn_key = 'otlp:' || r.trace_id
      and t.workflow_id is null
      and r.trace_id is not null
      and r.created_at >= ${since.toISOString()}::timestamptz
      and r.requested_by not like ${`${EVAL_TRIAL_PREFIX}%`}
    returning t.id
  `);
  return result.rows.length;
}
