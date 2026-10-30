import { RunsView } from "@/components/console/traces/RunsView";
import type { TracesEmptyKind } from "@/components/console/traces/TracesEmpty";
import { TracesUnavailable } from "@/components/console/traces/TracesUnavailable";
import { isDbConfigured } from "@/lib/platform/db/client";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { RANGE_PRESETS } from "@/lib/synthesis/dashboard";
import {
  EMPTY_TRACE_FACETS,
  getTraceAggregates,
  getTraceFacets,
  getTracesIngestDiagnostics,
  listTraces,
  type TraceAggregateSummary,
} from "@/lib/synthesis/traces/queries";
import { listRunAsks, listRunTools, type RunAsk } from "@/lib/synthesis/traces/run-details";
import { hasFilters, presetCovering, searchFromParams } from "@/lib/synthesis/traces/v2/filters";
import { runStats, toRunRow } from "@/lib/synthesis/traces/v2/runs";
import { buildVolumeModel, needsHourlyVolume } from "@/lib/synthesis/traces/v2/volume";
import {
  resolveSpanListView,
  resolveTraceListView,
  resolveTraceRange,
  serializeTraceCursor,
  type TraceListSearchParams,
  toTraceSummaryView,
} from "@/lib/synthesis/traces/view";

/**
 * The v2 Runs page's data. The same reads the v1 page makes (the trace list,
 * the filtered aggregate, the facets), with the
 * aggregate's volume hourly for short windows and two extra bounded reads for
 * the page's tools and asks. Each supplementary read degrades on its own and
 * says so on the page: a failed aggregate is never shown as zero.
 */
export async function RunsPageV2({
  projectId,
  searchParams,
}: {
  projectId: string;
  searchParams: TraceListSearchParams;
}) {
  if (!isDbConfigured()) return <TracesUnavailable />;
  // The project layout already guarded the id against the session.
  const project = { id: projectId };

  const now = new Date();
  const params: TraceListSearchParams = { ...searchParams, peek: undefined };
  const view = resolveTraceListView(params, now);
  const spanView = resolveSpanListView(params, now);
  const distinctId = `project:${project.id}`;
  const timeoutMs = supplementaryReadTimeoutMs();
  const hourly = needsHourlyVolume(view.range.days.length);

  const [page, facets, aggregate] = await Promise.all([
    withStatementTimeout((db) => listTraces(project.id, view.queryOptions, db), {
      operation: "trace_list",
    }),
    loadOrFallback({
      operation: "trace_facets",
      distinctId,
      fallback: EMPTY_TRACE_FACETS,
      load: () =>
        withStatementTimeout((db) => getTraceFacets(project.id, spanView.queryOptions, db), {
          operation: "trace_facets",
          timeoutMs,
        }),
    }),
    loadOrFallback<TraceAggregateSummary | null>({
      operation: "trace_filtered_aggregates",
      distinctId,
      fallback: null,
      load: () =>
        withStatementTimeout(
          (db) =>
            getTraceAggregates(
              project.id,
              {
                ...view.queryOptions,
                since: view.range.since,
                until: view.range.until,
                volumeBucket: hourly ? "hour" : "day",
              },
              db,
            ),
          { operation: "trace_filtered_aggregates", timeoutMs },
        ),
    }),
  ]);

  // Separate reads under separate timeouts: a slow one costs only its own column.
  const traceIds = page.items.map((item) => item.traceId);
  const [tools, asks] =
    traceIds.length > 0
      ? await Promise.all([
          loadOrFallback<Map<string, string[]> | null>({
            operation: "trace_run_tools",
            distinctId,
            fallback: null,
            load: () =>
              withStatementTimeout((db) => listRunTools(project.id, traceIds, db), {
                operation: "trace_run_tools",
                timeoutMs,
              }),
          }),
          loadOrFallback<Map<string, RunAsk> | null>({
            operation: "trace_run_asks",
            distinctId,
            fallback: null,
            load: () =>
              withStatementTimeout((db) => listRunAsks(project.id, traceIds, db), {
                operation: "trace_run_asks",
                timeoutMs,
              }),
          }),
        ])
      : [new Map<string, string[]>(), new Map<string, RunAsk>()];

  const search = searchFromParams(params);
  let empty: TracesEmptyKind | null = null;
  let latestRunAt: string | null = null;
  if (page.items.length === 0 && !view.queryOptions.cursor) {
    if (hasFilters("runs", search)) {
      empty = "filtered";
    } else {
      const diagnostics = await getTracesIngestDiagnostics(project.id);
      latestRunAt = diagnostics.latestSpanAt
        ? new Date(diagnostics.latestSpanAt).toISOString()
        : null;
      empty = !diagnostics.hasSpans
        ? diagnostics.hasEvents
          ? "events-only"
          : "no-telemetry"
        : "outside-window";
    }
  }
  const wider = presetCovering(
    latestRunAt,
    view.range.preset,
    (preset) => resolveTraceRange({ range: preset }, now).from,
  );

  return (
    <RunsView
      projectId={project.id}
      now={now.toISOString()}
      timeWindow={{
        preset: view.range.preset,
        from: view.range.from,
        to: view.range.to,
        today: now.toISOString().slice(0, 10),
      }}
      rows={page.items.map((item) =>
        toRunRow(toTraceSummaryView(item), {
          tools: tools?.get(item.traceId) ?? [],
          prompt: asks?.get(item.traceId)?.prompt ?? null,
          // Unknown when the read failed: then no run is called incomplete.
          hasRoot: asks?.get(item.traceId)?.hasRoot,
        }),
      )}
      stats={aggregate ? runStats(aggregate) : null}
      volume={
        aggregate
          ? buildVolumeModel({ from: view.range.from, to: view.range.to, points: aggregate.volume })
          : null
      }
      detailsUnavailable={tools === null || asks === null}
      facets={facets}
      sort={{ id: view.filters.sort, direction: view.filters.direction }}
      nextCursor={
        page.hasMore && page.nextCursor ? serializeTraceCursor(page.nextCursor, view.filters) : null
      }
      paged={Boolean(view.queryOptions.cursor)}
      empty={empty}
      latestRunAt={latestRunAt}
      widerPreset={
        wider
          ? {
              id: wider,
              label: RANGE_PRESETS.find((preset) => preset.id === wider)?.label ?? wider,
            }
          : null
      }
      // No experiments module in this build: no running-experiment banner.
      experiment={null}
    />
  );
}
