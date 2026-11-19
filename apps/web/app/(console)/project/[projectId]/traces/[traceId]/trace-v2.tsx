import { notFound } from "next/navigation";
import { TracesUnavailable } from "@/components/console/traces/TracesUnavailable";
import { TraceView } from "@/components/console/traces/TraceView";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { firstParam, searchFromParams } from "@/lib/synthesis/traces/v2/filters";
import { runsListPath } from "@/lib/synthesis/traces/v2/run-noun";
import type { TraceListSearchParams } from "@/lib/synthesis/traces/view";
import { loadTraceSession } from "@/lib/views/session-chat/trace-session";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import { loadTraceViewProps } from "@/lib/views/traces/trace-view-props";

/**
 * The v2 full trace's data: the same span load and lifecycle records the v1
 * page reads, plus the run summary for the header. The list's query rides
 * along so the crumb goes back to the exact list view.
 */
export async function TracePageV2({
  projectId,
  traceId,
  searchParams,
}: {
  projectId: string;
  traceId: string;
  searchParams: TraceListSearchParams & {
    span?: string | readonly string[];
    tab?: string | readonly string[];
  };
}) {
  if (!isDbConfigured()) return <TracesUnavailable title="Trace" />;
  // The project layout already guarded the id against the session.
  const project = { id: projectId };

  const { span, tab, ...listParams } = searchParams;
  const requestedTab = firstParam(tab);
  const tracesPath = `/project/${encodeURIComponent(project.id)}/traces`;
  const id = traceId.toLowerCase();
  const props = await loadTraceViewProps(project.id, id, {
    listHref: `${tracesPath}${searchFromParams({ ...listParams, peek: undefined, compare: undefined, project: undefined })}`,
    compareHref: `${tracesPath}${searchFromParams({ ...listParams, peek: undefined, project: undefined, compare: id })}`,
    tab: requestedTab,
    spanId: firstParam(span) ?? null,
  });
  if (!props) notFound();
  // RC-503: Traces opens on Sessions, so the crumb and Compare go back to the Turns tab.
  const list = runsListPath(tracesPath);
  props.listHref = props.listHref.replace(tracesPath, list);
  props.compareHref = props.compareHref.replace(tracesPath, list);
  // RC-472: a turn links to its full session, and keeps the session's turns on top.
  const traceSession = await loadOrFallback({
    operation: "trace_session",
    distinctId: `project:${project.id}`,
    fallback: null,
    load: () =>
      withStatementTimeout(
        async (db) =>
          loadTraceSession(project.id, id, { readContent: await contentOptIn(project.id, db) }, db),
        { operation: "trace_session" },
      ),
  });
  return <TraceView {...props} session={traceSession} />;
}

// Moved to lib so get_trace's MCP view reads a run the same way; the session replay page imports it from here.
export { loadTraceViewProps } from "@/lib/views/traces/trace-view-props";
