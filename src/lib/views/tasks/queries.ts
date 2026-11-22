import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import type { getDb } from "@/lib/platform/db/client";
import { traceTopics, traceTurnTopics } from "@/lib/readings/topics/schema";
import {
  type TraceSignalRow,
  taskSegments,
  traceSelfCorrections,
  traceSignalRuns,
} from "@/lib/readings/trace-signals/schema";
import { parsePreviousWorkflows } from "@/lib/readings/trace-signals/signals/workflow-previous";
import { assignTurn } from "@/lib/readings/trace-signals/workflows/assign";
import {
  type AskSource,
  loadAskSourcesByTurn,
} from "@/lib/readings/trace-signals/workflows/label-queries";
import type { WorkflowStep } from "@/lib/readings/trace-signals/workflows/types";
import { stepToken } from "@/lib/readings/trace-signals/workflows/units";
import { toSignalRecord } from "@/lib/views/health/signals/page-view";
import {
  type ExampleStatus,
  type ExampleStep,
  exampleStatus,
  exampleSteps,
} from "@/lib/views/tasks/examples";
import {
  CORRECTION_KINDS,
  type CorrectionCounts,
  type CorrectionKind,
  type RecordedCorrections,
  type TaskIssueSource,
  type TaskSegmentSummary,
  type TaskTopic,
} from "@/lib/views/tasks/model";

/**
 * The reads behind the task pages that nothing else makes: the latest signal
 * run's tasks (only the JSON the pages need), the intents each task serves
 * and the self-corrections recorded in its runs (both through each run's
 * task in `trace_turns.workflow_id`), and a few example runs with their calls and what was asked in them, read only
 * when a task page shows them. Every function takes the database it runs on, so the loader
 * bounds each with a statement timeout.
 */

export type TasksDb = Pick<ReturnType<typeof getDb>, "select" | "insert">;

export interface LatestTasksRun {
  id: string;
  windowDays: number;
  windowStart: Date;
  finishedAt: Date | null;
  turnsScanned: number;
  /** `summary.workflows`, untrusted JSON. */
  workflows: unknown;
  /** `summary.daily`, for the project's model round-trip price. */
  daily: unknown;
}

export async function loadLatestTasksRun(
  projectId: string,
  db: Pick<TasksDb, "select">,
): Promise<LatestTasksRun | null> {
  const [row] = await db
    .select({
      id: traceSignalRuns.id,
      windowDays: traceSignalRuns.windowDays,
      windowStart: traceSignalRuns.windowStart,
      finishedAt: traceSignalRuns.finishedAt,
      turnsScanned: traceSignalRuns.turnsScanned,
      workflows: sql<unknown>`${traceSignalRuns.summary} -> 'workflows'`,
      daily: sql<unknown>`${traceSignalRuns.summary} -> 'daily'`,
    })
    .from(traceSignalRuns)
    .where(and(eq(traceSignalRuns.projectId, projectId), eq(traceSignalRuns.status, "completed")))
    .orderBy(desc(traceSignalRuns.createdAt))
    .limit(1);
  return row ?? null;
}

/** Per task, the intents (stored as topics) its runs were about, most runs first; null before any run was given one. */
export async function loadTaskTopics(
  projectId: string,
  since: Date,
  db: TasksDb,
): Promise<Map<string, TaskTopic[]> | null> {
  const [any] = await db
    .select({ turnId: traceTurnTopics.turnId })
    .from(traceTurnTopics)
    .where(eq(traceTurnTopics.projectId, projectId))
    .limit(1);
  if (!any) return null;
  const runs = sql<number>`count(*)::int`;
  const rows = await db
    .select({
      taskId: traceTurns.workflowId,
      topicId: traceTurnTopics.topicId,
      name: traceTopics.name,
      runs,
    })
    .from(traceTurnTopics)
    .innerJoin(
      traceTurns,
      and(eq(traceTurns.id, traceTurnTopics.turnId), eq(traceTurns.projectId, projectId)),
    )
    .leftJoin(
      traceTopics,
      and(
        eq(traceTopics.projectId, traceTurnTopics.projectId),
        eq(traceTopics.topicId, traceTurnTopics.topicId),
      ),
    )
    .where(
      and(
        eq(traceTurnTopics.projectId, projectId),
        eq(traceTurnTopics.verdict, "topic"),
        isNotNull(traceTurnTopics.topicId),
        isNotNull(traceTurns.workflowId),
        gte(traceTurnTopics.startedAt, since),
      ),
    )
    .groupBy(traceTurns.workflowId, traceTurnTopics.topicId, traceTopics.name)
    .orderBy(desc(runs), traceTurnTopics.topicId);
  const out = new Map<string, TaskTopic[]>();
  for (const row of rows) {
    if (!row.taskId || !row.topicId) continue;
    const topics = out.get(row.taskId) ?? [];
    topics.push({ id: row.topicId, name: row.name ?? "Unnamed intent", runs: row.runs });
    out.set(row.taskId, topics);
  }
  return out;
}

const KINDS: ReadonlySet<string> = new Set(CORRECTION_KINDS);

/**
 * Self-corrections recorded in each task's runs since `since`, by kind,
 * counted through the run's task (`trace_turns.workflow_id`) so they always
 * agree with the task's runs. Null when the project has none recorded: the
 * pages then read the ones a task's steps show.
 */
export async function loadTaskCorrections(
  projectId: string,
  since: Date,
  db: TasksDb,
): Promise<RecordedCorrections | null> {
  const [any] = await db
    .select({ id: traceSelfCorrections.id })
    .from(traceSelfCorrections)
    .where(
      and(
        eq(traceSelfCorrections.projectId, projectId),
        gte(traceSelfCorrections.occurredAt, since),
      ),
    )
    .limit(1);
  if (!any) return null;
  const events = sql<number>`count(*)::int`;
  const rows = await db
    .select({ taskId: traceTurns.workflowId, kind: traceSelfCorrections.kind, events })
    .from(traceSelfCorrections)
    .innerJoin(
      traceTurns,
      and(eq(traceTurns.id, traceSelfCorrections.turnId), eq(traceTurns.projectId, projectId)),
    )
    .where(
      and(
        eq(traceSelfCorrections.projectId, projectId),
        gte(traceSelfCorrections.occurredAt, since),
        isNotNull(traceTurns.workflowId),
      ),
    )
    .groupBy(traceTurns.workflowId, traceSelfCorrections.kind);
  const byTask = new Map<string, CorrectionCounts>();
  for (const row of rows) {
    if (!row.taskId || !KINDS.has(row.kind)) continue;
    const counts = byTask.get(row.taskId) ?? {};
    counts[row.kind as CorrectionKind] = (counts[row.kind as CorrectionKind] ?? 0) + row.events;
    byTask.set(row.taskId, counts);
  }
  return { byTask };
}

/** Open issues with the fix each one opens, once a fix is linked to it. */
export function issueSources(rows: readonly TraceSignalRow[]): TaskIssueSource[] {
  return rows.flatMap((row) => {
    const record = toSignalRecord(row);
    return record ? [{ record, proposalId: row.proposalId ?? null }] : [];
  });
}

export interface ExampleRun {
  traceCount?: number;
  turnId: string;
  sessionId: string;
  startedAt: Date;
  endedAt: Date;
  calls: number;
  failures: number;
  /** The tools it called, in order; empty once its steps are pruned. */
  steps: ExampleStep[];
  status: ExampleStatus;
  /** What was asked, when the customer sends it: the user's words, the prompt, or the first search. */
  ask: { text: string; source: AskSource } | null;
}

/**
 * A task page's example runs: each one's calls in order, how it ended, and
 * what was asked in it. Read when the page shows them, never stored.
 */
export async function loadExampleRuns(
  projectId: string,
  turnIds: readonly string[],
  db: TasksDb,
  names: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, ExampleRun>> {
  if (turnIds.length === 0) return new Map();
  // One after another: a bounded read runs on one connection.
  const rows = await db
    .select({
      id: traceTurns.id,
      sessionId: traceTurns.sessionId,
      startedAt: traceTurns.startedAt,
      endedAt: traceTurns.endedAt,
      calls: traceTurns.invokeCount,
      failures: traceTurns.errorCount,
    })
    .from(traceTurns)
    .where(and(eq(traceTurns.projectId, projectId), inArray(traceTurns.id, [...turnIds])));
  const stepRows = await db
    .select({
      turnId: traceTurnSteps.turnId,
      kind: traceTurnSteps.kind,
      targetType: traceTurnSteps.targetType,
      targetId: traceTurnSteps.targetId,
      outcome: traceTurnSteps.outcome,
    })
    .from(traceTurnSteps)
    .where(
      and(eq(traceTurnSteps.projectId, projectId), inArray(traceTurnSteps.turnId, [...turnIds])),
    )
    .orderBy(traceTurnSteps.turnId, traceTurnSteps.ordinal);
  const stepsByTurn = new Map<string, (typeof stepRows)[number][]>();
  for (const step of stepRows)
    stepsByTurn.set(step.turnId, [...(stepsByTurn.get(step.turnId) ?? []), step]);
  const asks = await loadAskSourcesByTurn(projectId, turnIds, db);
  return new Map(
    rows.map((row) => {
      const steps = exampleSteps(stepsByTurn.get(row.id) ?? [], names);
      return [
        row.id,
        {
          turnId: row.id,
          sessionId: row.sessionId,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          calls: row.calls,
          failures: row.failures,
          steps,
          status: exampleStatus(steps, row.failures),
          ask: asks.get(row.id) ?? null,
        },
      ];
    }),
  );
}

/**
 * The task an old Tool craft ask ran as, for its redirect: the ask's tools
 * (those in at least half of its turns, from the tool reading) placed with
 * the one placement rule against the latest tasks. Null when none matches.
 */
export function taskOfAskTools(
  tools: readonly { toolId: string; share: number }[],
  storedWorkflows: unknown,
): string | null {
  const items =
    storedWorkflows && typeof storedWorkflows === "object"
      ? (storedWorkflows as { items?: unknown }).items
      : null;
  const tasks = parsePreviousWorkflows(items);
  const main = tools.filter((tool) => tool.share >= 0.5).map((tool) => tool.toolId);
  if (main.length === 0 || tasks.length === 0) return null;
  return assignTurn(main, tasks)?.workflowId ?? null;
}

/** Segment counts and recent segment references for the typed task pages. */
export async function loadTaskSegmentSummaries(
  projectId: string,
  since: Date,
  db: TasksDb,
): Promise<Map<string, TaskSegmentSummary>> {
  const rows = await db
    .select({
      taskId: taskSegments.workflowId,
      runs: sql<number>`count(*)::int`,
      finishedRuns: sql<number>`count(*) filter (where ${traceTurnSteps.outcome} is distinct from 'error')::int`,
      medianMs: sql<number>`percentile_cont(0.5) within group (order by extract(epoch from (${taskSegments.endedAt}-${taskSegments.startedAt}))*1000)`,
    })
    .from(taskSegments)
    .leftJoin(
      traceTurnSteps,
      and(
        eq(traceTurnSteps.projectId, projectId),
        eq(traceTurnSteps.turnId, taskSegments.endTurnId),
        eq(traceTurnSteps.ordinal, taskSegments.endOrdinal),
      ),
    )
    .where(and(eq(taskSegments.projectId, projectId), gte(taskSegments.endedAt, since)))
    .groupBy(taskSegments.workflowId);
  const stepRows = await db
    .select({
      taskId: taskSegments.workflowId,
      kind: traceTurnSteps.kind,
      targetType: traceTurnSteps.targetType,
      targetId: traceTurnSteps.targetId,
      runs: sql<number>`count(distinct ${taskSegments.id})::int`,
    })
    .from(taskSegments)
    .innerJoin(
      traceTurnSteps,
      and(
        eq(traceTurnSteps.projectId, projectId),
        sql`${traceTurnSteps.turnId}=any(${taskSegments.turnIds})`,
        or(
          ne(traceTurnSteps.turnId, taskSegments.startTurnId),
          gte(traceTurnSteps.ordinal, taskSegments.startOrdinal),
        ),
        or(
          ne(traceTurnSteps.turnId, taskSegments.endTurnId),
          lte(traceTurnSteps.ordinal, taskSegments.endOrdinal),
        ),
      ),
    )
    .where(and(eq(taskSegments.projectId, projectId), gte(taskSegments.endedAt, since)))
    .groupBy(
      taskSegments.workflowId,
      traceTurnSteps.kind,
      traceTurnSteps.targetType,
      traceTurnSteps.targetId,
    );
  const byTask = new Map<string, Map<string, number>>();
  for (const row of stepRows) {
    const token = stepToken(row as unknown as WorkflowStep);
    if (!token) continue;
    const counts = byTask.get(row.taskId) ?? new Map<string, number>();
    counts.set(token, row.runs);
    byTask.set(row.taskId, counts);
  }
  const recent = db
    .select({
      id: taskSegments.id,
      taskId: taskSegments.workflowId,
      turnId: taskSegments.startTurnId,
      rank: sql<number>`row_number() over (partition by ${taskSegments.workflowId} order by ${taskSegments.endedAt} desc,${taskSegments.id})`.as(
        "rank",
      ),
    })
    .from(taskSegments)
    .where(and(eq(taskSegments.projectId, projectId), gte(taskSegments.endedAt, since)))
    .as("recent");
  const examples = await db
    .select()
    .from(recent)
    .where(lte(recent.rank, 10))
    .orderBy(asc(recent.rank));
  return new Map(
    rows.map((row) => [
      row.taskId,
      {
        runs: row.runs,
        finishedRuns: row.finishedRuns,
        medianMs: row.medianMs,
        stepRuns: byTask.get(row.taskId) ?? new Map(),
        examples: examples
          .filter((e) => e.taskId === row.taskId)
          .map((e) => ({
            turnId: e.turnId,
            segmentId: e.id,
            focusEventId: null,
            why: "recent" as const,
          })),
      },
    ]),
  );
}

/** Read only the calls inside each segment, including every contributing trace. */
export async function loadSegmentExamples(
  projectId: string,
  segmentIds: readonly string[],
  db: TasksDb,
  names: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, ExampleRun>> {
  if (!segmentIds.length) return new Map();
  const segments = await db
    .select()
    .from(taskSegments)
    .where(and(eq(taskSegments.projectId, projectId), inArray(taskSegments.id, [...segmentIds])));
  const ids = [...new Set(segments.flatMap((s) => s.turnIds))];
  if (!ids.length) return new Map();
  const rows = await db
    .select()
    .from(traceTurnSteps)
    .where(and(eq(traceTurnSteps.projectId, projectId), inArray(traceTurnSteps.turnId, ids)))
    .orderBy(asc(traceTurnSteps.ordinal));
  const asks = await loadAskSourcesByTurn(
    projectId,
    segments.filter((s) => s.startOrdinal === 1).map((s) => s.startTurnId),
    db,
  );
  return new Map(
    segments.map((segment) => {
      const kept = segment.turnIds.flatMap((id) =>
        rows.filter(
          (step) =>
            step.turnId === id &&
            (id !== segment.startTurnId || step.ordinal >= segment.startOrdinal) &&
            (id !== segment.endTurnId || step.ordinal <= segment.endOrdinal),
        ),
      );
      const steps = exampleSteps(kept, names, { typedSteps: true });
      const failures = steps.filter((s) => s.failed).length;
      return [
        segment.id,
        {
          turnId: segment.startTurnId,
          sessionId: segment.sessionId,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
          calls: steps.length,
          failures,
          steps,
          status: exampleStatus(steps, failures),
          ask: segment.startOrdinal === 1 ? (asks.get(segment.startTurnId) ?? null) : null,
          traceCount: segment.turnIds.length,
        },
      ];
    }),
  );
}
