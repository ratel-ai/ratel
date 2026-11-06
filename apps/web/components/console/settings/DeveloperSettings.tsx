import {
  sdkEventLabel,
  sourceStatusNote,
  toDropView,
  toRejectView,
  toSdkEventPayload,
  toSdkEventView,
} from "@/lib/console/settings/sdk-events";
import { projectSettingsRoot } from "@/lib/console/settings/tabs";
import {
  countRuntimeEventRejects,
  countRuntimeEvents,
  getRuntimeEvent,
  listRuntimeEventFacets,
  listRuntimeEventRejects,
  listRuntimeEvents,
  summarizeRuntimeEventClientDrops,
  sumRuntimeEventClientDrops,
} from "@/lib/ingest/runtime-events/queries";
import {
  type RuntimeEventsSearchParams,
  resolveRuntimeEventsView,
} from "@/lib/ingest/runtime-events/view";
import {
  type BoundReadDb,
  readTimeoutMs,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { requireProjectScope } from "./project-scope";
import { SdkEventsView } from "./SdkEventsView";

/**
 * Settings > Developer: SDK events, read with `lib/runtime-events/queries.ts`.
 * Every read runs under a statement timeout (the counts and facets under the
 * short supplementary one) and degrades on its own, logged and reported by
 * `loadOrFallback`: a slow count is cancelled and costs its number, not the
 * page. The list ships without payloads; only the event
 * the URL opens comes with its payload, and the Panel loads others on open.
 */
export async function DeveloperSettings({
  projectId,
  searchParams,
}: {
  projectId: string;
  searchParams: RuntimeEventsSearchParams;
}) {
  const { project } = await requireProjectScope(projectId);
  const view = resolveRuntimeEventsView(searchParams);
  const root = `${projectSettingsRoot(project.id)}/developer`;
  // The summary answers for the window (and source); the lists also honor the event filter.
  const windowFilters = {
    sourceId: view.sourceId || undefined,
    since: view.since,
    until: view.until,
  };
  const listFilters = { ...windowFilters, type: view.type || undefined };
  const distinctId = `project:${project.id}`;
  const supplementary = supplementaryReadTimeoutMs();
  const primary = readTimeoutMs();
  function read<T>(
    operation: string,
    timeoutMs: number | null,
    load: (db: BoundReadDb) => Promise<T>,
  ): Promise<T | null> {
    return loadOrFallback<T | null>({
      operation,
      distinctId,
      fallback: null,
      load: () => withStatementTimeout(load, { operation, timeoutMs }),
    });
  }
  const dropped = view.tab === "dropped";

  const [received, droppedCount, rejected, events, rejects, drops, facets, selected] =
    await Promise.all([
      read("sdk_events_received", supplementary, (db) =>
        countRuntimeEvents(project.id, windowFilters, db),
      ),
      read("sdk_events_dropped", supplementary, (db) =>
        sumRuntimeEventClientDrops(project.id, windowFilters, db),
      ),
      read("sdk_events_rejected", supplementary, (db) =>
        countRuntimeEventRejects(project.id, windowFilters, db),
      ),
      dropped
        ? Promise.resolve([])
        : read("sdk_events_list", primary, (db) => listRuntimeEvents(project.id, listFilters, db)),
      dropped
        ? read("sdk_events_rejects", primary, (db) =>
            listRuntimeEventRejects(project.id, listFilters, db),
          )
        : Promise.resolve([]),
      // The drop groups show only in their own view, as on the v1 page.
      dropped
        ? read("sdk_events_drop_groups", primary, (db) =>
            summarizeRuntimeEventClientDrops(project.id, windowFilters, db),
          )
        : Promise.resolve([]),
      read("sdk_events_facets", supplementary, (db) => listRuntimeEventFacets(project.id, {}, db)),
      view.selectedEventId
        ? read("sdk_events_selected", supplementary, (db) =>
            getRuntimeEvent(project.id, view.selectedEventId, db),
          )
        : Promise.resolve(null),
    ]);

  // No trace link: the trace view is not in this build.
  const toView = (row: Parameters<typeof toSdkEventView>[0]) => ({
    ...toSdkEventView(row, ""),
    traceHref: null,
  });
  const eventViews = events?.map(toView) ?? null;
  const pinned =
    selected && !eventViews?.some((event) => event.key === selected.id) ? toView(selected) : null;

  return (
    <SdkEventsView
      data={{
        root,
        projectId: project.id,
        setupHref: `${projectSettingsRoot(project.id)}/api-keys`,
        state: { tab: view.tab, range: view.range, type: view.type, sourceId: view.sourceId },
        summary: {
          received,
          dropped: droppedCount,
          rejected,
          sources: facets?.sources.filter((source) => source.status === "active").length ?? 0,
        },
        events: eventViews,
        pinned,
        // The URL's event comes with its payload, keyed by the id the URL names.
        openPayload: selected
          ? { ...toSdkEventPayload(selected), identifier: view.selectedEventId }
          : null,
        rejects: rejects?.map(toRejectView) ?? null,
        drops: drops?.map(toDropView) ?? null,
        typeOptions: (facets?.types ?? [])
          .map((type) => ({ value: type, label: sdkEventLabel(type) }))
          .sort((a, b) => a.label.localeCompare(b.label, "en")),
        sourceOptions: (facets?.sources ?? []).map((source) => {
          const note = sourceStatusNote(source.status);
          return {
            value: source.sourceId,
            label: note ? `${source.sourceId} (${note.toLowerCase()})` : source.sourceId,
          };
        }),
        everReceived:
          Boolean(facets && (facets.types.length > 0 || facets.sources.length > 0)) ||
          (received ?? 0) > 0,
        now: new Date().toISOString(),
      }}
    />
  );
}
