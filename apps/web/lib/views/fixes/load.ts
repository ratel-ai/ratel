import "@/lib/views/quality/fix-rewrites";
import { and, eq } from "drizzle-orm";
import { skills as skillsTable } from "@/lib/catalog/schema";
import {
  type BoundReadDb,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { getAgentHealthLimits, getLimits } from "@/lib/platform/entitlements";
import type { Organization } from "@/lib/platform/identity/schema";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { loadTopicPatterns } from "@/lib/readings/topics/queries";
import { TOPIC_WINDOW_DAYS } from "@/lib/readings/topics/types";
import { figureCaption, signalTitle } from "@/lib/readings/trace-signals/claims";
import type { TraceSignalRow, TraceSignalRunRow } from "@/lib/readings/trace-signals/schema";
import { loadCatalogNames } from "@/lib/readings/trace-signals/signals/analysis-context";
import { evidenceSpanDays } from "@/lib/readings/trace-signals/signals/project-metrics";
import { latestSignalRun, listOpenSignals } from "@/lib/readings/trace-signals/signals/queries";
import type { StoredWorkflows } from "@/lib/readings/trace-signals/signals/workflow-stored";
import { loadWorkflowLabels } from "@/lib/readings/trace-signals/workflows/label-queries";
import {
  type WorkflowLabels,
  workflowDisplayName,
} from "@/lib/readings/trace-signals/workflows/name";
import { claimModel } from "@/lib/views/health/signals/claims-model";
import { parseRunSummary, toSignalRecord } from "@/lib/views/health/signals/page-view";
import { buildFixes, type IssueInput, type TaskInput, type TopicInput } from "./build";
import { NO_PRICE } from "./crafter-types";
import { type DraftFixInput, fixSeams, type RewriteRead } from "./seams";
import { type IntentGapInput, type PublishedSkill, SKILL_GAP_MIN_TURNS } from "./skill-gaps";
import { loadTopicInputs } from "./topics";
import type { FixesModel, FixSource } from "./types";

/**
 * Fixes' reads: every source on its own, under a statement timeout, each degrading to "not
 * read" (logged and reported by `loadOrFallback`), so one failing source costs its fixes and a
 * notice, never the page. Names, tasks and topics are garnish: without them a fix loses a link,
 * not its place.
 *
 * Other pages call `loadFixes` and then pick theirs with `fixesForSubject`.
 *
 * Owned (ADR-0030): the issue and intent sources are read here; the tool crafter's drafts and
 * quality's rewrites arrive through `fixSeams` once those readings land. Unset, a seam
 * contributes nothing and is not a failed source.
 */

export interface LoadFixesDeps {
  /** The database the reads run on; the pool by default. */
  db?: BoundReadDb;
}

const defaultDeps: LoadFixesDeps = {};

/** Published skills read for what covers an intent; a catalog this big is read as covering everything. */
const SKILLS_READ = 1_000;

interface SkillGapRead {
  intents: IntentGapInput[];
  skills: PublishedSkill[];
}

/**
 * What skill gaps are read from: each live intent's stored pattern (one row of the topic
 * reading, by a JSON path) and the published skills' tools. A catalog past `SKILLS_READ` skills
 * could cover an intent we did not read, so it raises no gap at all.
 */
export async function loadSkillGapInputs(
  projectId: string,
  db: BoundReadDb,
): Promise<SkillGapRead> {
  // In turn: both run in one transaction, on one client.
  const intents = await loadTopicPatterns(projectId, db);
  if (!intents.some((intent) => intent.turns >= SKILL_GAP_MIN_TURNS))
    return { intents: [], skills: [] };
  const rows = await db
    .select({ name: skillsTable.name, tools: skillsTable.tools })
    .from(skillsTable)
    .where(and(eq(skillsTable.projectId, projectId), eq(skillsTable.status, "published")))
    .limit(SKILLS_READ);
  if (rows.length >= SKILLS_READ) return { intents: [], skills: [] };
  const skills = rows.map((row) => ({
    name: row.name,
    tools: Array.isArray(row.tools)
      ? row.tools.filter((tool): tool is string => typeof tool === "string")
      : [],
  }));
  return { intents, skills };
}

export async function loadFixes(input: {
  projectId: string;
  organization: Organization;
  now?: Date;
  /** False skips the topic read, for callers that only need fixes and their issues (the Overview). */
  topics?: boolean;
  deps?: Partial<LoadFixesDeps>;
}): Promise<FixesModel> {
  const { projectId, organization } = input;
  const deps = { ...defaultDeps, ...input.deps };
  const now = input.now ?? new Date();
  const distinctId = `project:${projectId}`;
  const read = <T>(
    operation: string,
    fallback: T,
    load: (db: BoundReadDb) => Promise<T>,
    timeoutMs?: number | null,
  ) =>
    loadOrFallback({
      operation,
      distinctId,
      fallback,
      load: () =>
        withStatementTimeout(load, {
          operation,
          ...(deps.db ? { db: deps.db } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
    });

  // Rewrites exist only where quality has landed and the limits include match quality.
  const rewritesOn =
    fixSeams.loadRewrites !== undefined && getLimits(organization).matchQualityRunsPerMonth > 0;
  const supplementary = supplementaryReadTimeoutMs();

  const [names, run, labels, issueRows, topics, gaps] = await Promise.all([
    read("fixes_catalog_names", new Map<string, string>(), (db) => loadCatalogNames(projectId, db)),
    read<TraceSignalRunRow | null>("fixes_signal_run", null, (db) =>
      latestSignalRun(projectId, db, "completed"),
    ),
    read<WorkflowLabels>(
      "fixes_task_labels",
      new Map(),
      (db) => loadWorkflowLabels(projectId, db),
      supplementary,
    ),
    read<TraceSignalRow[] | null>("fixes_issues", null, (db) => listOpenSignals(projectId, db)),
    input.topics === false
      ? Promise.resolve([] as TopicInput[])
      : read<TopicInput[]>(
          "fixes_topics",
          [],
          (db) => loadTopicInputs(projectId, db, now),
          supplementary,
        ),
    read<SkillGapRead | null>(
      "fixes_skill_gaps",
      null,
      (db) => loadSkillGapInputs(projectId, db),
      supplementary,
    ),
  ]);

  const summary = run ? parseRunSummary(run.summary) : null;
  const price = fixSeams.priceOf ? fixSeams.priceOf(summary?.daily ?? []) : NO_PRICE;
  const { loadDrafts, loadRewrites } = fixSeams;
  const [drafts, rewrites] = await Promise.all([
    loadDrafts
      ? read<DraftFixInput[] | null>("fixes_drafts", null, (db) =>
          loadDrafts(projectId, db, { names, price }),
        )
      : Promise.resolve([] as DraftFixInput[]),
    rewritesOn && loadRewrites
      ? read<RewriteRead | null>("fixes_rewrites", null, (db) =>
          loadRewrites(projectId, organization, db, now),
        )
      : Promise.resolve(null),
  ]);

  const failed: FixSource[] = [];
  if (loadDrafts && drafts === null) failed.push("craft");
  if (issueRows === null) failed.push("issue");
  if (rewritesOn && rewrites === null) failed.push("rewrite");
  if (gaps === null) failed.push("intent");

  const shown = getAgentHealthLimits(organization).agentHealthSignalsShown;
  const spanDays =
    run && summary
      ? evidenceSpanDays(summary.daily, run.windowEnd, run.windowDays) || run.windowDays
      : 30;

  return buildFixes({
    projectId,
    names,
    rewrites: rewritesOn ? (rewrites?.rewrites ?? []) : null,
    dismissedRewrites: rewrites?.dismissed ?? [],
    drafts: drafts ?? [],
    // The limits' cut, as on Agent health: the worst issues first, the rest not read.
    issues: issueInputs(
      (issueRows ?? []).slice(
        0,
        Number.isFinite(shown) ? Math.max(0, Math.floor(shown)) : undefined,
      ),
      names,
      spanDays,
      labels,
    ),
    tasks: taskInputs(summary?.workflows, names, labels),
    topics,
    intents: gaps?.intents ?? null,
    skills: gaps?.skills ?? [],
    intentWindowDays: TOPIC_WINDOW_DAYS,
    overridesAdopted: rewrites?.overridesAdopted ?? null,
    failed,
  });
}

/** Open issues in their own words, for the limits' cut (worst first). */
export function issueInputs(
  rows: readonly TraceSignalRow[],
  names: ReadonlyMap<string, string>,
  spanDays: number,
  labels: WorkflowLabels,
): IssueInput[] {
  return rows.flatMap((row): IssueInput[] => {
    // A kind this build cannot tell in words is left out until it can.
    const record = toSignalRecord(row);
    if (!record) return [];
    const claim = claimModel(record, names, spanDays, labels);
    const storedRoute = typeof record.metrics.route === "string" ? record.metrics.route : null;
    return [
      {
        id: record.id,
        kind: record.kind,
        route: storedRoute ?? claim.fixRoute,
        subjectKind: record.subjectKind,
        subjectKey: record.subjectKey,
        toolIds: record.subjectKind === "query_cluster" ? [] : [...record.subjectIds],
        taskId: record.subjectKind === "workflow" ? record.subjectKey : null,
        topicId: (record.subjectKind as string) === "topic" ? record.subjectKey : null,
        title: signalTitle(record.kind),
        claim: claim.claim,
        cost: claim.cost,
        figureRaw: claim.figure.raw,
        figure: claim.figure.display
          ? { display: claim.figure.display, caption: figureCaption(record.kind, claim.figure) }
          : null,
        fix: claim.fix,
        caveat: claim.caveat,
        severity: record.severity,
        impact: record.impact,
        n: record.n,
        totalTurns: record.totalTurns,
        metrics: record.metrics,
        proposal:
          row.proposalKind && row.proposalId
            ? { kind: row.proposalKind, id: row.proposalId }
            : null,
        firstSeenAt: record.firstSeenAt,
      },
    ];
  });
}

/** The tasks of the latest reading, named as Agent health names them. */
export function taskInputs(
  workflows: StoredWorkflows | undefined,
  names: ReadonlyMap<string, string>,
  labels: WorkflowLabels,
): TaskInput[] {
  return (workflows?.items ?? []).map((workflow) => ({
    id: workflow.id,
    label: workflowDisplayName(workflow, names, labels),
    named: labels.has(workflow.id),
    runs: workflow.runs,
    tools: workflow.coreTools,
  }));
}
