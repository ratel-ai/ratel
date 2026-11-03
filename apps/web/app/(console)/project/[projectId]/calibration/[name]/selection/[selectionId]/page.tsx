import { cn } from "@ratel/design-system/cn";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SelectionRankingDiff } from "@/components/console/calibration/SelectionRankingDiff";
import { BackLink } from "@/components/console/traces/compare/BackLink";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import type {
  SelectionDetail,
  SelectionLogRecord,
} from "@/lib/synthesis/experiments/calibration-types";
import {
  buildSelectionRankingView,
  type SelectionRankingView,
  selectionQuery,
} from "@/lib/synthesis/experiments/selection-view";
import { playgroundHref } from "@/lib/synthesis/playground/links";
import {
  calibrationMismatchesPath,
  comparisonSearchParams,
  formatScore,
  type OutcomeTone,
  outcomeTone,
  resolveComparisonBrowserView,
  singleSearchParam,
} from "@/lib/synthesis/traces/calibration-view";
import { getSelectionDetail } from "@/lib/synthesis/traces/experiment-calibration-queries";
import { experimentNameFromPathSegment } from "@/lib/synthesis/traces/experiment-view";
import {
  formatAttributeValue,
  formatDuration,
  formatTimestamp,
} from "@/lib/synthesis/traces/format";
import { resolveTraceListView, type TraceListSearchParams } from "@/lib/synthesis/traces/view";

export const metadata = { title: "Selection inspector" };

const TONE_CHIP: Record<OutcomeTone, string> = {
  ok: "border-green/25 bg-green/10 text-green",
  warn: "border-ctx-tools/30 bg-ctx-tools/10 text-ctx-tools",
  error: "border-coral/30 bg-coral/10 text-coral",
  muted: "border-forest-300 bg-forest/40 text-warm-muted",
};

/** Owned (ADR-0030): the project comes from the guarded route, a 404 outside the organization. */
export default async function SelectionInspectorPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; name: string; selectionId: string }>;
  searchParams: Promise<TraceListSearchParams>;
}) {
  const [{ projectId, name: nameSegment, selectionId }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  if (!isDbConfigured()) notFound();

  const name = experimentNameFromPathSegment(nameSegment);
  const { project } = await requireProjectScope(projectId);
  const view = resolveTraceListView({ ...query, project: project.slug });

  const detail = await loadOrFallback({
    operation: "calibration_selection_detail",
    distinctId: `project:${project.id}`,
    fallback: null as SelectionDetail | null,
    load: () =>
      withStatementTimeout((db) =>
        // Next has already decoded the dynamic param once.
        getSelectionDetail(project.id, selectionId, db),
      ),
  });
  if (!detail) notFound();

  const ranking = buildSelectionRankingView(detail.records);
  // Read off any record that carries it, not just the comparison: a skipped or
  // dropped shadow produces no comparison at all, and those selections still
  // have a query worth reproducing.
  const queryText = ranking?.query ?? selectionQuery(detail.records);
  const basePath = `/project/${project.id}/calibration`;
  const backSearch = new URLSearchParams({
    project: project.slug,
    range: view.range.preset,
  });
  if (view.range.preset === "custom") {
    backSearch.set("from", view.range.from);
    backSearch.set("to", view.range.to);
  }
  const comparisonView = resolveComparisonBrowserView({
    comparisons: singleSearchParam(query.comparisons),
    comparisonMatch: singleSearchParam(query.comparisonMatch),
    comparisonPage: singleSearchParam(query.comparisonPage),
    comparisonPageSize: singleSearchParam(query.comparisonPageSize),
  });
  // Carry the browser's filter and page back so the inspector returns to the
  // exact list the row was opened from.
  const backHref = `${calibrationMismatchesPath(basePath, name)}?${comparisonSearchParams(
    backSearch,
    comparisonView,
  ).toString()}`;
  const traceHref =
    detail.traceHasSpans && detail.traceId
      ? `/project/${project.id}/traces/${detail.traceId}?project=${encodeURIComponent(project.slug)}`
      : null;

  return (
    <div className="flex flex-col gap-7">
      <div className="pixel-header card-enter flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <BackLink href={backHref}>Back to {name}</BackLink>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="eyebrow">Selection inspector</span>
            {ranking && (
              <span className="font-mono text-[10px] text-warm-muted">
                {formatTimestamp(ranking.occurredAt)}
              </span>
            )}
          </div>
          <h1 className="mt-1.5 break-all font-mono text-lg font-semibold tracking-tight text-cream">
            {detail.selectionId}
          </h1>
        </div>
        {traceHref && detail.traceId ? (
          <Link
            href={traceHref}
            title={`Open trace ${detail.traceId}`}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-forest-300 px-3 py-1.5 text-xs font-medium text-cream-dim transition-colors hover:border-indigo-300/40 hover:bg-indigo-300/10 hover:text-indigo-300"
          >
            Trace {shortId(detail.traceId)} <span aria-hidden>→</span>
          </Link>
        ) : (
          <span
            className="inline-flex min-h-8 items-center rounded-lg border border-dashed border-forest-300 px-3 py-1.5 font-mono text-[10px] text-warm-muted"
            title="Comparison records are a census; arm spans are trace-sampled, so most selections have no stored trace."
          >
            trace not sampled
          </span>
        )}
      </div>

      <QueryPanel
        query={queryText}
        playgroundHref={
          queryText
            ? playgroundHref(project.id, {
                query: queryText,
                selectionId: detail.selectionId,
                experimentName: name,
              })
            : null
        }
      />

      {ranking && <AgreementStrip ranking={ranking} />}

      {ranking ? (
        <SelectionRankingDiff
          servedArm={ranking.servedArm}
          shadowArm={ranking.shadowArm}
          servedResultIds={ranking.servedResultIds}
          shadowResultIds={ranking.shadowResultIds}
          servedResultScores={ranking.servedResultScores}
          shadowResultScores={ranking.shadowResultScores}
        />
      ) : (
        <p className="rounded-xl border border-forest-300 bg-forest-600/35 px-4 py-3 text-sm text-warm-muted">
          This selection has no comparison record. The shadow arm was skipped or dropped before a
          comparison could run. The raw records below say why.
        </p>
      )}

      <RecordsList records={detail.records} />
    </div>
  );
}

function QueryPanel({
  query,
  playgroundHref: href,
}: {
  query: string | null;
  playgroundHref: string | null;
}) {
  return (
    <section
      aria-labelledby="selection-query-title"
      className="rounded-2xl border border-forest-300 bg-forest-600/45 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="selection-query-title" className="eyebrow">
          Query
        </h2>
        {href && (
          <Link
            href={href}
            title="Re-rank this query against the live catalog and try different descriptions"
            className="ml-auto font-mono text-xs text-warm-muted transition-colors hover:text-indigo-300"
          >
            open in playground →
          </Link>
        )}
      </div>
      <p
        className={cn(
          "mt-1.5 whitespace-pre-wrap text-sm leading-relaxed",
          query === null ? "italic text-warm-muted/60" : "text-cream",
        )}
      >
        {query ??
          "No record for this selection carried the query text. The SDK version that produced it did not export one."}
      </p>
    </section>
  );
}

function AgreementStrip({ ranking }: { ranking: SelectionRankingView }) {
  const facts: Array<{ label: string; value: string; tone?: OutcomeTone }> = [
    {
      label: "match score",
      value: formatScore(ranking.jaccardAtK),
    },
    {
      label: "top-1",
      value: agreementWord(ranking.top1),
      tone: agreementTone(ranking.top1),
    },
    {
      label: "exact order",
      value: agreementWord(ranking.exactOrder),
      tone: agreementTone(ranking.exactOrder),
    },
    { label: "k", value: ranking.agreementK?.toString() ?? "—" },
    {
      label: `${ranking.servedArm ?? "served"} · served`,
      value: `${ranking.servedOutcome ?? "—"} · ${msWord(ranking.servedDurationMs)}`,
      tone: outcomeTone(ranking.servedOutcome),
    },
    {
      label: `${ranking.shadowArm ?? "shadow"} · shadow`,
      value: `${ranking.shadowOutcome ?? "—"} · ${msWord(ranking.shadowDurationMs)}`,
      tone: outcomeTone(ranking.shadowOutcome),
    },
  ];

  return (
    <section aria-label="Agreement summary" className="flex flex-wrap gap-2">
      {facts.map(({ label, value, tone }) => (
        <span
          key={label}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 font-mono text-xs",
            TONE_CHIP[tone ?? "muted"],
          )}
        >
          <span className="text-[10px] uppercase tracking-wide opacity-70">{label}</span>
          <span className="tabular-nums">{value}</span>
        </span>
      ))}
    </section>
  );
}

function RecordsList({ records }: { records: SelectionLogRecord[] }) {
  return (
    <section
      aria-labelledby="selection-records-title"
      className="overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/35"
    >
      <header className="flex items-center gap-2 border-b border-forest-300 bg-base-deep/30 px-4 py-2.5">
        <span className="h-px w-5 bg-indigo-300/80" aria-hidden />
        <h2 id="selection-records-title" className="eyebrow">
          Lifecycle records
        </h2>
        <span className="ml-auto font-mono text-[10px] tabular-nums text-warm-muted/70">
          {records.length} record{records.length === 1 ? "" : "s"}
        </span>
      </header>
      <div className="divide-y divide-forest-300/50">
        {records.map((record) => (
          <article key={record.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs font-medium text-cream">{record.eventName}</span>
              {record.arm && (
                <span className="rounded-md border border-forest-300 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-warm-muted">
                  {record.arm}
                  {record.role ? ` · ${record.role}` : ""}
                </span>
              )}
              <span className="ml-auto font-mono text-[10px] text-warm-muted">
                {formatTimestamp(record.occurredAt)}
              </span>
            </div>
            {Object.keys(record.experimentAttrs).length > 0 && (
              <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                {Object.entries(record.experimentAttrs).map(([key, value]) => (
                  <div key={key} className="flex min-w-0 items-baseline gap-2">
                    <dt
                      className="min-w-0 flex-1 truncate font-mono text-[10px] text-warm-muted"
                      title={key}
                    >
                      {key.replace("ratel.experiment.", "")}
                    </dt>
                    <dd
                      className="max-w-[55%] truncate font-mono text-[11px] tabular-nums text-cream-dim"
                      title={formatAttributeValue(value)}
                    >
                      {formatAttributeValue(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function agreementWord(value: boolean | null): string {
  return value === null ? "—" : value ? "agree" : "differ";
}

function agreementTone(value: boolean | null): OutcomeTone {
  return value === null ? "muted" : value ? "ok" : "error";
}

function msWord(value: number | null): string {
  return value === null ? "—" : formatDuration(value);
}

function shortId(id: string): string {
  return id.length <= 13 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}
