import { and, eq, gt, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import { traceTopicInsights, traceTopics } from "@/lib/readings/topics/schema";
import { TOPIC_INSIGHTS_VERSION } from "@/lib/readings/topics/types";
import { traceWorkflowInsights } from "@/lib/readings/trace-signals/schema";
import { loadCatalogNames } from "@/lib/readings/trace-signals/signals/analysis-context";
import type { WorkflowInsights } from "@/lib/readings/trace-signals/workflows/decide";
import { loadWorkflowLabels } from "@/lib/readings/trace-signals/workflows/label-queries";
import { parseStoredWorkflows } from "@/lib/views/health/workflows-view";
import type { IntentsRead, TasksRead } from "@/lib/views/home/glance";
import { buildTaskList } from "@/lib/views/tasks/model";
import { loadLatestTasksRun } from "@/lib/views/tasks/queries";

/**
 * The Overview's reads of Intents and Tasks: each page's latest stored
 * reading, trimmed in the database to the counts a tile shows. Every function
 * runs its queries one after another on the `db` it is given: the loader
 * bounds each with a statement timeout, and a bounded read is one connection.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * The latest intents reading, as the Intents page reads it (a row of another
 * version, or missing its parts, is no reading): each intent's asks and
 * answered asks. Names come from the stored intents; ids and counts only
 * otherwise. Null without a reading.
 */
export async function readIntents(db: BoundReadDb, projectId: string): Promise<IntentsRead | null> {
  const data = traceTopicInsights.data;
  const [row] = await db
    .select({
      valid: sql<boolean>`(${data} -> 'version') = to_jsonb(${TOPIC_INSIGHTS_VERSION}::int)
        and jsonb_typeof(${data} -> 'turns') = 'number'
        and jsonb_typeof(${data} -> 'topics') = 'array'
        and jsonb_typeof(${data} -> 'tools') = 'array'
        and jsonb_typeof(${data} -> 'verdicts') = 'object'
        and jsonb_typeof(${data} -> 'sources') = 'object'`,
      topics: sql<unknown>`case when jsonb_typeof(${data} -> 'topics') = 'array' then (
        select coalesce(jsonb_agg(jsonb_build_object('id', t -> 'id', 'turns', t -> 'turns', 'answered', t -> 'answered')), '[]'::jsonb)
        from jsonb_array_elements(${data} -> 'topics') t
      ) end`,
    })
    .from(traceTopicInsights)
    .where(eq(traceTopicInsights.projectId, projectId))
    .limit(1);
  if (!row || !row.valid) return null;
  const names = await db
    .select({ id: traceTopics.topicId, name: traceTopics.name })
    .from(traceTopics)
    .where(eq(traceTopics.projectId, projectId));
  return {
    topics: Array.isArray(row.topics)
      ? row.topics.flatMap((topic) =>
          isRecord(topic) && typeof topic.id === "string"
            ? [{ id: topic.id, turns: count(topic.turns), answered: count(topic.answered) }]
            : [],
        )
      : [],
    names: new Map(names.map((name) => [name.id, name.name])),
  };
}

/**
 * Asks placed in each task by the decision step, from the stored insights
 * when they are of the version Tasks reads (the rest of the row, which holds
 * people's asks, is never read here). Null without them.
 */
async function readPlacedAsks(
  db: BoundReadDb,
  projectId: string,
): Promise<WorkflowInsights["placed"] | null> {
  const data = traceWorkflowInsights.data;
  const [row] = await db
    .select({
      placed: sql<unknown>`case when (${data} -> 'version') = to_jsonb(3)
        and jsonb_typeof(${data} -> 'placed') = 'object'
        and jsonb_typeof(${data} -> 'unserved') = 'array'
        then ${data} -> 'placed' end`,
    })
    .from(traceWorkflowInsights)
    .where(
      and(
        eq(traceWorkflowInsights.projectId, projectId),
        gt(traceWorkflowInsights.computedAt, new Date(0)),
      ),
    )
    .limit(1);
  return isRecord(row?.placed) ? (row.placed as WorkflowInsights["placed"]) : null;
}

/**
 * The latest tasks reading, built the way the Tasks list builds it (names,
 * colors, finish rates), from the run's tasks, their names and the asks
 * placed in them, plus each task's own steps. Issues, fixes, intents and
 * self-corrections are left out: the tile shows none of them. Null before
 * the first reading.
 */
export async function readTasks(db: BoundReadDb, projectId: string): Promise<TasksRead | null> {
  const run = await loadLatestTasksRun(projectId, db);
  if (!run) return null;
  const labels = await loadWorkflowLabels(projectId, db);
  const names = await loadCatalogNames(projectId, db);
  const placed = await readPlacedAsks(db, projectId);
  const list = buildTaskList({
    projectId,
    run: { windowDays: run.windowDays, finishedAt: run.finishedAt, turnsScanned: run.turnsScanned },
    stored: run.workflows,
    labels,
    names,
    issues: [],
    insights: placed
      ? { version: 3, asksSeen: 0, judged: 0, unclear: 0, placed, unserved: [] }
      : null,
    fixes: [],
    recorded: null,
    topics: null,
    price: null,
  });
  const steps = (parseStoredWorkflows(run.workflows)?.items ?? []).map((item) =>
    Array.isArray(item.coreTools)
      ? item.coreTools.filter((tool): tool is string => typeof tool === "string")
      : [],
  );
  return { list, steps };
}

/** Clock slack around a run when looking up its turn: a turn ends with its last step, inside its trace. */
const RUN_SLACK_MS = 60_000;
/** A turn built from one OpenTelemetry trace is keyed by it (`turns/segment.ts`). */
const OTLP_TURN_PREFIX = "otlp:";

/**
 * The task each run was placed in, by trace id, for runs sent as
 * OpenTelemetry (each trace is one turn, keyed `otlp:<trace id>`). Runs from
 * the SDK, and runs no task holds, are left out. One range scan on closed
 * turns between the runs' first start and last end.
 */
export async function readRunTasks(
  db: BoundReadDb,
  projectId: string,
  runs: readonly { traceId: string; startedAt: Date; endedAt: Date }[],
): Promise<Map<string, string>> {
  if (runs.length === 0) return new Map();
  const from = Math.min(...runs.map((run) => run.startedAt.getTime())) - RUN_SLACK_MS;
  const to =
    Math.max(...runs.map((run) => Math.max(run.endedAt.getTime(), run.startedAt.getTime()))) +
    RUN_SLACK_MS;
  const rows = await db
    .select({ key: traceTurns.turnKey, task: traceTurns.workflowId })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.status, "closed"),
        gte(traceTurns.endedAt, new Date(from)),
        lte(traceTurns.endedAt, new Date(to)),
        inArray(
          traceTurns.turnKey,
          runs.map((run) => `${OTLP_TURN_PREFIX}${run.traceId}`),
        ),
        isNotNull(traceTurns.workflowId),
      ),
    );
  return new Map(
    rows.flatMap((row) =>
      row.task ? [[row.key.slice(OTLP_TURN_PREFIX.length), row.task] as const] : [],
    ),
  );
}
