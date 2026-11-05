import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { figureCaption, signalTitle } from "@/lib/readings/trace-signals/claims";
import { type TraceSignalRow, traceSignals } from "@/lib/readings/trace-signals/schema";
import { loadCatalogNames } from "@/lib/readings/trace-signals/signals/analysis-context";
import { evidenceSpanDays } from "@/lib/readings/trace-signals/signals/project-metrics";
import { latestSignalRun, listOpenSignals } from "@/lib/readings/trace-signals/signals/queries";
import { SIGNAL_KINDS, type SignalKind } from "@/lib/readings/trace-signals/view";
import { loadWorkflowLabels } from "@/lib/readings/trace-signals/workflows/label-queries";
import { issueHref } from "@/lib/views/fixes/href";
import { loadFixes } from "@/lib/views/fixes/load";
import type { FixesModel } from "@/lib/views/fixes/types";
import { claimModel } from "@/lib/views/health/signals/claims-model";
import { parseRunSummary, toSignalRecord } from "@/lib/views/health/signals/page-view";
import { metricRef, traceRef, withHref } from "@/lib/views/lineage/refs";
import { firstTraceOf, sampledTurnIds, traceIdsForTurns } from "@/lib/views/lineage/turn-traces";
import type { LineageRef } from "@/lib/views/lineage/types";

/**
 * The reads behind the loop tools: insights in the words Agent health uses,
 * and the project's fixes as `lib/fixes` builds them for the Fixes page. Each
 * insight carries its lineage source (the trace it was seen in, or the run
 * that measured it), so every tool result can say where it came from.
 */

export interface InsightView {
  id: string;
  kind: string;
  title: string;
  claim: string;
  cost: string;
  whatToDo: string;
  figure: { display: string; caption: string } | null;
  caveat: string | null;
  severity: number;
  impact: number;
  n: number;
  status: string;
  subject: { kind: string; key: string; tools: { id: string; name: string }[] };
  firstSeenAt: string;
  lastSeenAt: string;
  href: string;
  source: LineageRef;
}

/**
 * Where an insight came from, as RC-45's `sourceOf` says it: the first sampled
 * trace, else the reading it fired on (a metric named by its signal kind).
 */
export function insightSource(
  projectId: string,
  row: Pick<TraceSignalRow, "kind">,
  traceId: string | null,
): LineageRef {
  if (traceId) return withHref(traceRef(traceId, `Trace ${traceId.slice(0, 8)}`), projectId);
  return withHref(
    metricRef(row.kind, isSignalKind(row.kind) ? signalTitle(row.kind) : undefined),
    projectId,
  );
}

function isSignalKind(kind: string): kind is SignalKind {
  return (SIGNAL_KINDS as readonly string[]).includes(kind);
}

/** Turn signal rows into insights, in their stored order (worst first). */
export async function toInsights(
  projectId: string,
  rows: readonly TraceSignalRow[],
): Promise<InsightView[]> {
  if (rows.length === 0) return [];
  const [names, labels, run] = await Promise.all([
    loadCatalogNames(projectId),
    loadWorkflowLabels(projectId),
    latestSignalRun(projectId, undefined, "completed"),
  ]);
  const summary = run ? parseRunSummary(run.summary) : null;
  const spanDays =
    run && summary
      ? evidenceSpanDays(summary.daily, run.windowEnd, run.windowDays) || run.windowDays
      : 30;
  const sampled = rows.map((row) => sampledTurnIds(row.evidence));
  const traces = await traceIdsForTurns(projectId, sampled.flat());

  return rows.flatMap((row, i): InsightView[] => {
    const record = toSignalRecord(row);
    // A kind this build cannot put in words is left out, as on Agent health.
    if (!record) return [];
    const claim = claimModel(record, names, spanDays, labels);
    const traceId = firstTraceOf(sampled[i]!, traces);
    return [
      {
        id: record.id,
        kind: record.kind,
        title: signalTitle(record.kind),
        claim: claim.claim,
        cost: claim.cost,
        whatToDo: claim.fix,
        figure: claim.figure.display
          ? { display: claim.figure.display, caption: figureCaption(record.kind, claim.figure) }
          : null,
        caveat: claim.caveat,
        severity: record.severity,
        impact: record.impact,
        n: record.n,
        status: record.status,
        subject: {
          kind: record.subjectKind,
          key: record.subjectKey,
          tools: record.subjectIds.map((id) => ({ id, name: names.get(id) ?? id })),
        },
        firstSeenAt: record.firstSeenAt,
        lastSeenAt: record.lastSeenAt,
        href: issueHref(projectId, record.id),
        source: insightSource(projectId, row, traceId),
      },
    ];
  });
}

export async function loadOpenInsights(projectId: string): Promise<InsightView[]> {
  return toInsights(projectId, await listOpenSignals(projectId));
}

/** One insight by id, whatever its status; null when the project has no such insight. */
export async function loadInsight(
  projectId: string,
  insightId: string,
): Promise<InsightView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(insightId)) return null;
  const rows = await getDb()
    .select()
    .from(traceSignals)
    .where(and(eq(traceSignals.projectId, projectId), eq(traceSignals.id, insightId)))
    .limit(1);
  const [insight] = await toInsights(projectId, rows);
  return insight ?? null;
}

/** The project's fixes, as the Fixes page reads them; null when the project has no organization. */
export async function loadProjectFixes(projectId: string): Promise<FixesModel | null> {
  const organization = await getOrganizationByProjectId(projectId);
  if (!organization) return null;
  return loadFixes({ projectId, organization, topics: false });
}
