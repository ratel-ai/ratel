import type { TracesEmptyKind } from "@/components/console/traces/TracesEmpty";
import { TracesUnavailable } from "@/components/console/traces/TracesUnavailable";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getTracesIngestDiagnostics } from "@/lib/synthesis/traces/queries";
import { loadSessionListPage } from "@/lib/synthesis/traces/v2/sessions-list";
import { parseSessionsFilter, SESSIONS_FILTER_PARAM } from "@/lib/synthesis/traces-sessions/view";
import { SessionListView } from "./SessionListView";

/**
 * The Sessions tab with `FF_TRACE_VIEWS_V3` (RC-503): the first page of
 * sessions, newest last update first, under All or Failed. Further pages load
 * as the person scrolls (`/api/projects/:id/traces/sessions`).
 */
export async function SessionListPage({
  projectId,
  searchParams,
}: {
  projectId: string;
  searchParams: { [SESSIONS_FILTER_PARAM]?: string | string[] };
}) {
  if (!isDbConfigured()) return <TracesUnavailable />;
  // Checked here too, as upstream does: the list shows each session's ask.
  const { project } = await requireProjectScope(projectId);

  const filter = parseSessionsFilter(searchParams[SESSIONS_FILTER_PARAM]);
  const now = new Date();
  const page = await loadSessionListPage(project.id, { filter, now });
  let empty: TracesEmptyKind | "no-failed" | null = null;
  if (page.items.length === 0) {
    if (filter === "failed") empty = "no-failed";
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
    />
  );
}
