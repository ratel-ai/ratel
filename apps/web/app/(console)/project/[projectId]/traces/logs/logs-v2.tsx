import { LogsView } from "@/components/console/traces/LogsView";
import { TracesUnavailable } from "@/components/console/traces/TracesUnavailable";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { listProjectEvents } from "@/lib/synthesis/traces/events-queries";
import {
  type EventListSearchParams,
  resolveEventListView,
  serializeEventCursor,
} from "@/lib/synthesis/traces/events-view";
import type { TraceFacetValue } from "@/lib/synthesis/traces/queries";
import { hasFilters, searchFromParams } from "@/lib/synthesis/traces/v2/filters";

/**
 * The v2 Logs page's data: the v1 log list. The search box's `name` filters
 * log names (v1's project-scoped Logs tab did the same with its shared name
 * field); an old `eventName` link still works.
 */
export async function LogsPageV2({
  projectId,
  searchParams,
}: {
  projectId: string;
  searchParams: EventListSearchParams;
}) {
  if (!isDbConfigured()) return <TracesUnavailable />;
  // The project layout already guarded the id against the session.
  const project = { id: projectId };

  const now = new Date();
  const params: EventListSearchParams = { ...searchParams, peek: undefined };
  const name = params.name ?? params.eventName;
  const view = resolveEventListView({ ...params, eventName: name }, now);
  const page = await withStatementTimeout(
    (db) => listProjectEvents(project.id, view.queryOptions, db),
    {
      operation: "trace_events",
    },
  );

  return (
    <LogsView
      projectId={project.id}
      now={now.toISOString()}
      timeWindow={{
        preset: view.range.preset,
        from: view.range.from,
        to: view.range.to,
        today: now.toISOString().slice(0, 10),
      }}
      logs={page.items.map((item) => ({ ...item, occurredAt: item.occurredAt.toISOString() }))}
      experiments={experimentValues(
        page.items.flatMap((item) => (item.experimentName ? [item.experimentName] : [])),
      )}
      nextCursor={
        page.hasMore && page.nextCursor ? serializeEventCursor(page.nextCursor, view.filters) : null
      }
      paged={Boolean(view.queryOptions.cursor)}
      filtered={hasFilters("logs", searchFromParams(params))}
    />
  );
}

/** The experiments seen on this page, most frequent first: the "Add filter" values. */
function experimentValues(names: readonly string[]): TraceFacetValue[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || (left.value < right.value ? -1 : 1));
}
