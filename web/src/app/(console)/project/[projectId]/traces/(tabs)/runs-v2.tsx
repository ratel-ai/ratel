import { ExploreLink } from "@/components/console/explore/ExploreLink";
import { RunsView } from "@/components/console/traces/RunsView";
import type { TracesEmptyKind } from "@/components/console/traces/TracesEmpty";
import { TracesUnavailable } from "@/components/console/traces/TracesUnavailable";
import { hasUsableApiKey } from "@/lib/console/has-api-key";
import { isDbConfigured } from "@/lib/platform/db/client";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { RANGE_PRESETS } from "@/lib/synthesis/dashboard";
import { createExperimentService } from "@/lib/synthesis/experiments/service";
import type { ExperimentMode, ExperimentSummary } from "@/lib/synthesis/experiments/types";
import { calibrationDetailPath } from "@/lib/synthesis/traces/calibration-view";
import { createExperimentQueries } from "@/lib/synthesis/traces/experiment-queries";
import { selectExperimentBanner } from "@/lib/synthesis/traces/experiment-view";
import {
  EMPTY_TRACE_FACETS,
  getTraceAggregates,
  getTracesIngestDiagnostics,
  listTraces,
  type TraceAggregateSummary,
} from "@/lib/synthesis/traces/queries";
import { listRunAsks, listRunTools, type RunAsk } from "@/lib/synthesis/traces/run-details";
import { getTraceFilterFacets } from "@/lib/synthesis/traces/trace-filters";
import {
  hasFilters,
  presetCovering,
  searchFromParams,
  traceFilterFromSearch,
  withoutRollupFilters,
} from "@/lib/synthesis/traces/v2/filters";
import { runStats, toRunRow } from "@/lib/synthesis/traces/v2/runs";
import { buildVolumeModel, needsHourlyVolume } from "@/lib/synthesis/traces/v2/volume";
import {
  exactInstants,
  resolveTraceListView,
  resolveTraceRange,
  serializeTraceCursor,
  type TraceListSearchParams,
  toTraceSummaryView,
} from "@/lib/synthesis/traces/view";
import { exactly } from "@/lib/views/dashboards/range";
import { exploreTracesHref } from "@/lib/views/explore/links";
import { dashboardsEnabled } from "../../dashboards/context";

const EXPERIMENT_MODE: Readonly<Record<ExperimentMode, string>> = {
  split: "Runs in this window are split between its variants.",
  shadow: "A comparison variant runs alongside each run in this window.",
  mixed: "Runs in this window are split between its variants and compared.",
};

/**
 * The v2 Runs page's data. The same reads the v1 page makes (the trace list,
 * the filtered aggregate, the facets, the experiment banner), with the
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
  const search = searchFromParams(params);
  // RC-506: Turns filters on the per-trace rollup. Its parameters never reach
  // the span-scan options.
  // RC-790: the Agent and MCP server filters. Always on here: the core has no
  // `cloud-project-entities` flag.
  const filterOptions = { entities: true };
  const view = resolveTraceListView(paramsOf(withoutRollupFilters(search, filterOptions)), now);
  view.queryOptions = {
    ...view.queryOptions,
    traces: traceFilterFromSearch(search, filterOptions),
  };
  const exact = exactInstants(params);
  const distinctId = `project:${project.id}`;
  const timeoutMs = supplementaryReadTimeoutMs();
  const hourly = needsHourlyVolume(view.range.days.length);

  const [page, facets, aggregate, experiments, explore] = await Promise.all([
    withStatementTimeout((db) => listTraces(project.id, view.queryOptions, db), {
      operation: "trace_list",
    }),
    loadOrFallback({
      operation: "trace_facets",
      distinctId,
      fallback: EMPTY_TRACE_FACETS,
      load: () =>
        withStatementTimeout(
          async (db) => ({
            ...EMPTY_TRACE_FACETS,
            ...(await getTraceFilterFacets(
              project.id,
              { since: view.range.since, until: view.range.until },
              db,
              undefined,
              filterOptions,
            )),
          }),
          { operation: "trace_facets", timeoutMs },
        ),
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
    loadOrFallback({
      operation: "trace_experiments",
      distinctId,
      fallback: [] as ExperimentSummary[],
      load: () =>
        withStatementTimeout(
          (db) =>
            createExperimentService(createExperimentQueries(db)).listExperiments(project.id, {
              since: view.range.since,
              until: view.range.until,
            }),
          { operation: "trace_experiments", timeoutMs },
        ),
    }),
    dashboardsEnabled(project.id),
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

  let empty: TracesEmptyKind | null = null;
  let latestRunAt: string | null = null;
  if (page.items.length === 0 && !view.queryOptions.cursor) {
    if (hasFilters("rollup", search, filterOptions)) {
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
  // Nothing sent yet: the empty state points at the key onboarding made, or asks for one.
  const hasApiKey = empty === "no-telemetry" && (await hasUsableApiKey(project.id));
  const wider = presetCovering(
    latestRunAt,
    view.range.preset,
    (preset) => resolveTraceRange({ range: preset }, now).from,
  );

  const running = selectExperimentBanner(experiments, view.filters.experiment);
  const experiment = running
    ? {
        name: running.name,
        description: EXPERIMENT_MODE[running.mode],
        href: `${calibrationDetailPath(`/project/${project.id}/calibration`, running.name)}${windowQuery(view.range)}`,
      }
    : null;

  return (
    <RunsView
      projectId={project.id}
      actions={
        <>
          {exact ? (
            <span className="text-xs text-fg-subtle">
              {instantLabel(exact.since)} to {instantLabel(exact.until)} UTC
            </span>
          ) : null}
          {explore ? (
            <ExploreLink
              href={exploreTracesHref(
                project.id,
                search,
                exact ? exactly(exact.since, exact.until) : view.range,
              )}
            />
          ) : null}
        </>
      }
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
      filterTab="rollup"
      entities={filterOptions.entities}
      sort={{ id: view.filters.sort, direction: view.filters.direction }}
      nextCursor={
        page.hasMore && page.nextCursor ? serializeTraceCursor(page.nextCursor, view.filters) : null
      }
      paged={Boolean(view.queryOptions.cursor)}
      empty={empty}
      hasApiKey={hasApiKey}
      latestRunAt={latestRunAt}
      widerPreset={
        wider
          ? {
              id: wider,
              label: RANGE_PRESETS.find((preset) => preset.id === wider)?.label ?? wider,
            }
          : null
      }
      experiment={experiment}
    />
  );
}

function paramsOf(search: string): TraceListSearchParams {
  const params: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(search.slice(1))) {
    const current = params[key];
    params[key] = current === undefined ? value : [current, value].flat();
  }
  return params as TraceListSearchParams;
}

function windowQuery(range: { preset: string; from: string; to: string }): string {
  return range.preset === "custom"
    ? `?range=custom&from=${range.from}&to=${range.to}`
    : `?range=${range.preset}`;
}

/** "2026-11-24 12:00": seconds only where there are some. */
function instantLabel(at: Date): string {
  return at.toISOString().slice(0, 19).replace("T", " ").replace(/:00$/, "");
}
