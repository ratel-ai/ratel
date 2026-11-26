import { SpansView } from "@/components/console/traces/SpansView";
import type { TracesEmptyKind } from "@/components/console/traces/TracesEmpty";
import { TracesNoTelemetry } from "@/components/console/traces/TracesNoTelemetry";
import { TracesUnavailable } from "@/components/console/traces/TracesUnavailable";
import { isDbConfigured } from "@/lib/platform/db/client";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { RANGE_PRESETS } from "@/lib/synthesis/dashboard";
import {
  AGENT_DIMENSIONS,
  agentDimensionFiltersOf,
  isAgentDimension,
} from "@/lib/synthesis/traces/agent-dimensions";
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

/** Name, model and tool, and the coding-agent dimensions (AOBS-5). */
const GROUPS: ReadonlySet<string> = new Set(["name", "model", "tool", ...AGENT_DIMENSIONS]);

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
  // The exact dimension filters of a group's drill-down. Not part of the
  // cursor's context: the list links carry them beside it.
  const dimensions = agentDimensionFiltersOf(params);
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
      : withStatementTimeout(
          (db) => listSpans(project.id, { ...view.queryOptions, ...dimensions }, db),
          {
            operation: "trace_spans",
          },
        ),
    operationsView
      ? withStatementTimeout(
          (db) =>
            listOperations(
              project.id,
              {
                ...groupedSpanOptions(operationsView.queryOptions, view.queryOptions),
                ...dimensions,
              },
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
        withStatementTimeout(
          (db) => getTraceFacets(project.id, { ...view.queryOptions, ...dimensions }, db),
          {
            operation: "trace_facets",
            timeoutMs,
          },
        ),
    }),
  ]);

  const nothing = operationsView
    ? operations.length === 0
    : page.items.length === 0 && !view.queryOptions.cursor;
  let empty: TracesEmptyKind | null = null;
  let latestAt: string | null = null;
  let noDimensionValue = false;
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
      // AOBS-5: the window has spans, and none carries the dimension grouped by.
      noDimensionValue =
        isAgentDimension(groupBy) &&
        diagnostics.latestSpanAt !== null &&
        new Date(diagnostics.latestSpanAt) >= view.range.since;
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
      noDimensionValue={noDimensionValue}
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
      noTelemetry={
        // Only in that state: a slot given to a client component renders on the server, shown or not.
        empty === "no-telemetry" ? <TracesNoTelemetry projectId={project.id} unit="spans" /> : null
      }
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
