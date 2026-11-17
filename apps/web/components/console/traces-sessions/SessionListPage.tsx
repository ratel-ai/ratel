import type { TracesEmptyKind } from "@/components/console/traces/TracesEmpty";
import { TracesUnavailable } from "@/components/console/traces/TracesUnavailable";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { getTracesIngestDiagnostics } from "@/lib/synthesis/traces/queries";
import {
  defaultTraceFilterFacetWindow,
  EMPTY_TRACE_FILTER_FACETS,
  getTraceFilterFacets,
} from "@/lib/synthesis/traces/trace-filters";
import {
  hasFilters,
  searchFromParams,
  traceFilterFromSearch,
} from "@/lib/synthesis/traces/v2/filters";
import { loadSessionListPage } from "@/lib/synthesis/traces/v2/sessions-list";
import { parseSessionsFilter, SESSIONS_FILTER_PARAM } from "@/lib/synthesis/traces-sessions/view";
import { SessionListView } from "./SessionListView";

/**
 * The Sessions tab (RC-503): the first page of
 * sessions, newest last update first, under All or Failed. Further pages load
 * as the person scrolls (`/api/projects/:id/traces/sessions`).
 */
export async function SessionListPage({
  projectId,
  searchParams,
}: {
  projectId: string;
  searchParams: { [SESSIONS_FILTER_PARAM]?: string | readonly string[] } & Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
}) {
  if (!isDbConfigured()) return <TracesUnavailable />;
  // Checked here too, as upstream does: the list shows each session's ask.
  const { project } = await requireProjectScope(projectId);

  const filter = parseSessionsFilter(searchParams[SESSIONS_FILTER_PARAM]);
  const now = new Date();
  // RC-506: the property filters, matched on the per-trace rollup.
  const search = searchFromParams(searchParams);
  const traces = traceFilterFromSearch(search);
  const [page, filterFacets] = await Promise.all([
    loadSessionListPage(project.id, { filter, now, traces }),
    loadOrFallback({
      operation: "trace_filter_facets",
      distinctId: `project:${project.id}`,
      fallback: EMPTY_TRACE_FILTER_FACETS,
      // Sessions have no time window: the facets use the Turns default range.
      load: () =>
        withStatementTimeout(
          (db) => getTraceFilterFacets(project.id, defaultTraceFilterFacetWindow(now), db),
          {
            operation: "trace_filter_facets",
            timeoutMs: supplementaryReadTimeoutMs(),
          },
        ),
    }),
  ]);
  let empty: TracesEmptyKind | "no-failed" | null = null;
  if (page.items.length === 0) {
    if (hasFilters("rollup", search)) empty = "filtered";
    else if (filter === "failed") empty = "no-failed";
    else {
      const diagnostics = await getTracesIngestDiagnostics(project.id);
      empty = diagnostics.hasEvents && !diagnostics.hasSpans ? "events-only" : "no-telemetry";
    }
  }
  return (
    <SessionListView
      projectId={project.id}
      filter={filter}
      rows={page.items}
      nextCursor={page.nextCursor}
      now={now.toISOString()}
      empty={empty}
      filterFacets={filterFacets}
    />
  );
}
