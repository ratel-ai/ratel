import { type BoundReadDb, withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import type { TraceSignalRow } from "@/lib/readings/trace-signals/schema";
import { FIX_PATTERNS, type FixPattern } from "@/lib/readings/trace-signals/self-corrections/kinds";
import { loadTopicNames } from "@/lib/readings/trace-signals/self-corrections/run-queries";
import { loadCatalogNames } from "@/lib/readings/trace-signals/signals/analysis-context";
import type { StoredWorkflows } from "@/lib/readings/trace-signals/signals/workflow-stored";
import type { WindowDays } from "@/lib/readings/trace-signals/view";
import { loadWorkflowLabels } from "@/lib/readings/trace-signals/workflows/label-queries";
import {
  type WorkflowLabels,
  workflowDisplayName,
} from "@/lib/readings/trace-signals/workflows/name";
import {
  buildSelfCorrectionsPage,
  type CorrectionIssue,
  type CorrectionNames,
  type CorrectionReads,
  type SelfCorrectionsPageModel,
  trendBucketDays,
} from "@/lib/views/health/self-corrections/page-model";
import {
  countByBucket,
  countCorrections,
  countFailedCalls,
  countSentiment,
  countTurns,
  countTurnsBy,
  groupCorrections,
  listExamples,
  listOpenCorrectionIssues,
  loadCorrectionRun,
  type PageRange,
} from "@/lib/views/health/self-corrections/page-queries";
import { NO_FILTERS, type SelfCorrectionFilters } from "@/lib/views/health/self-corrections/paths";
import { claimModel } from "@/lib/views/health/signals/claims-model";
import { toSignalRecord } from "@/lib/views/health/signals/page-view";

/**
 * The Self-corrections page's one read, bounded by a statement timeout: the
 * latest reading's facts, the window and the window before (anchored at the
 * end of what that reading read, so rows and turns are counted over the same
 * span), names, and the open issues told in the words of their cards. The
 * page wraps it in `loadOrFallback`, so a failed read shows the error state.
 */

const DAY_MS = 86_400_000;

export interface SelfCorrectionsPageRequest {
  projectId: string;
  windowDays: WindowDays;
  filters?: SelfCorrectionFilters;
  now?: Date;
}

const metricText = (metrics: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = metrics[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** Whether an issue concerns what the page is filtered to. */
function inScope(row: TraceSignalRow, filters: SelfCorrectionFilters): boolean {
  const metrics = (row.metrics ?? {}) as Record<string, unknown>;
  if (
    filters.tool &&
    row.subjectKey !== filters.tool &&
    metricText(metrics, "fixTool") !== filters.tool
  )
    return false;
  if (filters.task && !(row.subjectKind === "workflow" && row.subjectKey === filters.task))
    return false;
  if (filters.topic && metricText(metrics, "topicId") !== filters.topic) return false;
  return true;
}

function issuesOf(
  rows: readonly TraceSignalRow[],
  filters: SelfCorrectionFilters,
  names: ReadonlyMap<string, string>,
  labels: WorkflowLabels,
  windowDays: number,
): CorrectionIssue[] {
  return rows.flatMap((row) => {
    const record = toSignalRecord(row);
    if (!record || !inScope(row, filters)) return [];
    const copy = claimModel(record, names, windowDays, labels);
    const pattern = metricText(record.metrics, "pattern");
    return [
      {
        id: record.id,
        subjectKind: record.subjectKind,
        subjectKey: record.subjectKey,
        claim: copy.claim,
        fix: copy.fix,
        pattern:
          pattern && (FIX_PATTERNS as readonly string[]).includes(pattern)
            ? (pattern as FixPattern)
            : "failed",
        topicId: metricText(record.metrics, "topicId"),
        severity: record.severity,
        fixTool: metricText(record.metrics, "fixTool"),
      },
    ];
  });
}

function tasksOf(
  summary: unknown,
  tools: ReadonlyMap<string, string>,
  labels: WorkflowLabels,
): Map<string, { name: string; runs: number }> {
  const workflows = (summary as { workflows?: StoredWorkflows } | null)?.workflows;
  return new Map(
    (workflows?.items ?? []).map(
      (item) =>
        [item.id, { name: workflowDisplayName(item, tools, labels), runs: item.runs }] as const,
    ),
  );
}

/** Everything the page reads, in one bounded transaction. */
export async function readSelfCorrectionsPage(
  db: BoundReadDb,
  request: SelfCorrectionsPageRequest,
): Promise<SelfCorrectionsPageModel> {
  const { projectId, windowDays } = request;
  const filters = request.filters ?? NO_FILTERS;
  const run = await loadCorrectionRun(db, projectId);
  // One connection inside the bounded read: the reads run one after another.
  const tools = await loadCatalogNames(projectId, db);
  const labels = await loadWorkflowLabels(projectId, db);
  const topics = await loadTopicNames(projectId, db);
  const names: CorrectionNames = { tools, tasks: tasksOf(run?.summary, tools, labels), topics };
  if (!run) {
    return buildSelfCorrectionsPage({ projectId, windowDays, filters, names, reads: emptyReads() });
  }
  const now = request.now ?? new Date();
  const end = run.windowEnd.getTime() < now.getTime() ? run.windowEnd : now;
  const current: PageRange = { from: new Date(end.getTime() - windowDays * DAY_MS), to: end };
  const before: PageRange = {
    from: new Date(current.from.getTime() - windowDays * DAY_MS),
    to: current.from,
  };
  const trust = run.stored.trust;
  const covered = run.coveredFrom !== null && run.coveredFrom.getTime() <= before.from.getTime();

  const turns = await countTurns(db, projectId, current, filters, trust);
  const groups = await groupCorrections(db, projectId, current, filters, trust);
  const buckets = await countByBucket(
    db,
    projectId,
    current,
    filters,
    trust,
    trendBucketDays(windowDays),
  );
  const failed = await countFailedCalls(db, projectId, current, filters, trust);
  const previous = covered
    ? {
        turns: await countTurns(db, projectId, before, filters, trust),
        events: await countCorrections(db, projectId, before, filters, trust),
      }
    : null;
  const by = await countTurnsBy(db, projectId, current, filters, trust);
  const examples = await listExamples(db, projectId, current, filters, trust);
  const sentiment = await countSentiment(db, projectId, current, filters, trust);
  const issues = issuesOf(
    await listOpenCorrectionIssues(db, projectId),
    filters,
    tools,
    labels,
    windowDays,
  );

  const reads: CorrectionReads = {
    run: {
      computedAt: (run.finishedAt ?? run.windowEnd).toISOString(),
      trust,
      turnsWithReplies: run.stored.turnsWithReplies,
    },
    current: { turns, groups, failedCalls: failed.failed, recoveredCalls: failed.recovered },
    buckets,
    previous,
    taskTurns: by.tasks,
    topicTurns: by.topics,
    examples,
    issues,
    sentiment,
  };
  return buildSelfCorrectionsPage({ projectId, windowDays, filters, names, reads });
}

function emptyReads(): CorrectionReads {
  return {
    run: null,
    current: { turns: 0, groups: [], failedCalls: 0, recoveredCalls: 0 },
    previous: null,
    taskTurns: new Map(),
    topicTurns: new Map(),
    examples: [],
    issues: [],
    sentiment: null,
  };
}

/** The page's read under the statement timeout; throws on failure (the page falls back). */
export function loadSelfCorrectionsPage(
  request: SelfCorrectionsPageRequest,
  db?: BoundReadDb,
): Promise<SelfCorrectionsPageModel> {
  return withStatementTimeout((tx) => readSelfCorrectionsPage(tx, request), {
    operation: "self_corrections_page",
    ...(db ? { db } : {}),
  });
}

/** What the page shows when its read failed: its frame and an error, never a guess. */
export function unavailableSelfCorrectionsPage(
  projectId: string,
  windowDays: WindowDays,
  filters: SelfCorrectionFilters = NO_FILTERS,
): SelfCorrectionsPageModel {
  const model = buildSelfCorrectionsPage({
    projectId,
    windowDays,
    filters,
    names: { tools: new Map(), tasks: new Map(), topics: new Map() },
    reads: emptyReads(),
  });
  return { ...model, state: "unavailable" };
}
