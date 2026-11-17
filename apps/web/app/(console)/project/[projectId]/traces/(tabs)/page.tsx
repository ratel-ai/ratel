import { Suspense } from "react";
import { RunsSkeleton } from "@/components/console/traces/TracesSkeletons";
import { SessionListPage } from "@/components/console/traces-sessions/SessionListPage";
import { SessionsPage } from "@/components/console/traces-sessions/SessionsPage";
import { traceViewsV3EnabledForActor } from "@/lib/synthesis/traces/v2/views-flag";
import type { TraceListSearchParams } from "@/lib/synthesis/traces/view";
import { tracesSessionsEnabled } from "@/lib/synthesis/traces-sessions-flag";
import { RunsPageV2 } from "./runs-v2";

export const metadata = { title: "Traces" };

export default async function ScopedTracesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<TraceListSearchParams & { show?: string | string[] }>;
}) {
  const { projectId } = await params;
  // RC-313: the Sessions tab (one row per session, newest first, no timeframe), read once per
  // request. RC-503: with the v3 views this first tab lists sessions only, and Turns has its own
  // tab (`./turns`). Owned (ADR-0030): the deployment switches FF_TRACES_SESSIONS and
  // FF_TRACE_VIEWS_V3, not upstream's flags.
  const viewsV3 = await traceViewsV3EnabledForActor(projectId, `project:${projectId}`);
  const sessions = !viewsV3 && tracesSessionsEnabled();
  // The skeleton streams first. A Suspense boundary here rather than a route
  // `loading.tsx`: Next swaps a route's loading file in on every search-param
  // change, so each filter would flash a skeleton, while this boundary stays
  // revealed and the page dims in place as the next view loads.
  return (
    <Suspense fallback={<RunsSkeleton />}>
      {viewsV3 ? (
        <SessionListPage projectId={projectId} searchParams={await searchParams} />
      ) : sessions ? (
        <SessionsPage projectId={projectId} searchParams={await searchParams} />
      ) : (
        <RunsPageV2 projectId={projectId} searchParams={await searchParams} />
      )}
    </Suspense>
  );
}
