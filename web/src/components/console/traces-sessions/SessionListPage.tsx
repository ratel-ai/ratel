import { ExploreLink } from "@/components/console/explore/ExploreLink";
import { TracesUnavailable } from "@/components/console/traces/TracesUnavailable";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { dbConfigured } from "@/lib/platform/db/request";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { featureEnabled } from "@/lib/platform/experimental-features";
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
import {
  parseSessionsFilter,
  SESSIONS_FILTER_PARAM,
  type SessionsEmptyKind,
  sessionsEmptyKind,
} from "@/lib/synthesis/traces-sessions/view";
import { exploreTracesHref } from "@/lib/views/explore/links";
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
  if (!(await dbConfigured())) return <TracesUnavailable />;
  // Checked here too, as upstream does: the list shows each session's ask.
  const { project, organization, user } = await requireProjectScope(projectId);

  const filter = parseSessionsFilter(searchParams[SESSIONS_FILTER_PARAM]);
  const now = new Date();
  // RC-506: the property filters, matched on the per-trace rollup.
  const search = searchFromParams(searchParams);
  // RC-790: the Agent and MCP server filters. Always on here: the core has no
  // `cloud-project-entities` flag.
  const filterOptions = { entities: true };
  const traces = traceFilterFromSearch(search, filterOptions);
  const [page, filterFacets, explore] = await Promise.all([
    loadSessionListPage(project.id, { filter, now, traces }),
    loadOrFallback({
      operation: "trace_filter_facets",
      distinctId: `project:${project.id}`,
      fallback: EMPTY_TRACE_FILTER_FACETS,
      // Sessions have no time window: the facets use the Turns default range.
      load: () =>
        withStatementTimeout(
          (db) =>
            getTraceFilterFacets(
              project.id,
              defaultTraceFilterFacetWindow(now),
              db,
              undefined,
              filterOptions,
            ),
          {
            operation: "trace_filter_facets",
            timeoutMs: supplementaryReadTimeoutMs(),
          },
        ),
    }),
    featureEnabled("customMonitoring", {
      projectId: project.id,
      organizationId: organization.id,
      actor: user.externalId,
    }),
  ]);
  // RC-752: turns with no session read "No sessions yet", not "No turns yet".
  let empty: SessionsEmptyKind | null = null;
  if (page.items.length === 0) {
    const filtered = hasFilters("rollup", search, filterOptions);
    const diagnostics =
      filtered || filter === "failed"
        ? { hasEvents: false, hasSpans: false }
        : await getTracesIngestDiagnostics(project.id);
    empty = sessionsEmptyKind({
      filter,
      filtered,
      hasEvents: diagnostics.hasEvents,
      hasSpans: diagnostics.hasSpans,
    });
  }
  return (
    <SessionListView
      projectId={project.id}
      actions={explore ? <ExploreLink href={exploreTracesHref(project.id, search, null)} /> : null}
      filter={filter}
      rows={page.items}
      nextCursor={page.nextCursor}
      now={now.toISOString()}
      empty={empty}
      filterFacets={filterFacets}
      entities={filterOptions.entities}
    />
  );
}
