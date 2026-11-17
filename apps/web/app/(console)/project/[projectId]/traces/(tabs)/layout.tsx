import type { ReactNode } from "react";
import { TraceViewsV3Provider } from "@/components/console/traces/views-v3-context";
import { TracesFrame } from "@/components/console/traces-sessions/TracesFrame";
import { traceViewsV3EnabledForActor } from "@/lib/synthesis/traces/v2/views-flag";
import { tracesSessionsEnabled } from "@/lib/synthesis/traces-sessions-flag";

/**
 * RC-312, RC-331: the Sessions tab and each tab's own summary. RC-413: "Turn" for "Run" and no
 * raw-id titles. Owned (ADR-0030): behind the deployment switches `FF_TRACES_SESSIONS` and
 * `FF_TRACE_VIEWS_V3` in place of upstream's flags.
 */
export default async function TracesLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const enabled = tracesSessionsEnabled();
  const viewsV3 = await traceViewsV3EnabledForActor(projectId, `project:${projectId}`);
  return (
    <TraceViewsV3Provider enabled={viewsV3}>
      <TracesFrame enabled={enabled}>{children}</TracesFrame>
    </TraceViewsV3Provider>
  );
}
