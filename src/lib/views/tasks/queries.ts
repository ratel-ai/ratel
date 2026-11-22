import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import type { getDb } from "@/lib/platform/db/client";
import { traceTopics, traceTurnTopics } from "@/lib/readings/topics/schema";
import {
  type TraceSignalRow,
  traceSelfCorrections,
  traceSignalRuns,
} from "@/lib/readings/trace-signals/schema";
import { parsePreviousWorkflows } from "@/lib/readings/trace-signals/signals/workflow-previous";
import { assignTurn } from "@/lib/readings/trace-signals/workflows/assign";
import {
  type AskSource,
  loadAskSourcesByTurn,
} from "@/lib/readings/trace-signals/workflows/label-queries";
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
  db: TasksDb,
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
