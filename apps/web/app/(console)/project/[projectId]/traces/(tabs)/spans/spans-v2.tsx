import { SpansView } from "@/components/console/traces/SpansView";
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
  getTraceFacets,
  getTracesIngestDiagnostics,
  listOperations,
  listSpans,
  type OperationAggregate,
  type OperationGroupBy,
  type SpanPage,
} from "@/lib/synthesis/traces/queries";
import {
  firstParam,
  groupedSpanOptions,
  hasFilters,
  presetCovering,
  searchFromParams,
} from "@/lib/synthesis/traces/v2/filters";
import {
  resolveOperationsView,
  resolveSpanListView,
  resolveTraceRange,
  serializeSpanCursor,
  type TraceListSearchParams,
  toSpanSummaryView,
} from "@/lib/synthesis/traces/view";

const GROUPS: ReadonlySet<string> = new Set(["name", "model", "tool"]);

/**
 * The v2 Spans page's data: the v1 span list, or with `?groupBy=` the v1
 * operations aggregate (the Operations tab folded into Spans) under the same
 * filters as the list, plus the facets for "Add filter".
 */
export async function SpansPageV2({
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
  const requestedGroup = firstParam(params.groupBy);
  const groupBy =
    requestedGroup && GROUPS.has(requestedGroup) ? (requestedGroup as OperationGroupBy) : null;
  const view = resolveSpanListView(params, now);
  const operationsView = groupBy ? resolveOperationsView(params, now) : null;
  const distinctId = `project:${project.id}`;
  const timeoutMs = supplementaryReadTimeoutMs();

  const [page, operations, facets] = await Promise.all([
    operationsView
      ? Promise.resolve<SpanPage>({ items: [], hasMore: false, nextCursor: null })
      : withStatementTimeout((db) => listSpans(project.id, view.queryOptions, db), {
          operation: "trace_spans",
        }),
    operationsView
      ? withStatementTimeout(
          (db) =>
            listOperations(
              project.id,
              groupedSpanOptions(operationsView.queryOptions, view.queryOptions),
              db,
            ),
          { operation: "trace_operations" },
        )
      : Promise.resolve<OperationAggregate[]>([]),
    loadOrFallback({
      operation: "trace_facets",
      distinctId,
      fallback: EMPTY_TRACE_FACETS,
      load: () =>
        withStatementTimeout((db) => getTraceFacets(project.id, view.queryOptions, db), {
          operation: "trace_facets",
          timeoutMs,
        }),
    }),
  ]);

  const nothing = operationsView
    ? operations.length === 0
    : page.items.length === 0 && !view.queryOptions.cursor;
  let empty: TracesEmptyKind | null = null;
  let latestAt: string | null = null;
  if (nothing) {
    if (hasFilters("spans", searchFromParams(params))) {
      empty = "filtered";
    } else {
      const diagnostics = await getTracesIngestDiagnostics(project.id);
      latestAt = diagnostics.latestSpanAt ? new Date(diagnostics.latestSpanAt).toISOString() : null;
      empty = !diagnostics.hasSpans
        ? diagnostics.hasEvents
          ? "events-only"
          : "no-telemetry"
        : "outside-window";
    }
  }
  const wider = presetCovering(
    latestAt,
    view.range.preset,
    (preset) => resolveTraceRange({ range: preset }, now).from,
  );

  return (
    <SpansView
      projectId={project.id}
      now={now.toISOString()}
      timeWindow={{
        preset: view.range.preset,
        from: view.range.from,
        to: view.range.to,
        today: now.toISOString().slice(0, 10),
      }}
      facets={facets}
      groupBy={groupBy}
      spans={page.items.map(toSpanSummaryView)}
      operations={operations}
      sort={
        operationsView
          ? { id: operationsView.filters.sort, direction: operationsView.filters.direction }
          : { id: view.filters.sort, direction: view.filters.direction }
      }
      nextCursor={
        page.hasMore && page.nextCursor ? serializeSpanCursor(page.nextCursor, view.filters) : null
      }
      paged={Boolean(view.queryOptions.cursor)}
      empty={empty}
      latestAt={latestAt}
      widerPreset={
        wider
          ? {
              id: wider,
              label: RANGE_PRESETS.find((preset) => preset.id === wider)?.label ?? wider,
            }
          : null
      }
    />
  );
}
