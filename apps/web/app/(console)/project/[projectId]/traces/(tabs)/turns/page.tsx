import { redirect } from "next/navigation";
import { Suspense } from "react";
import { RunsSkeleton } from "@/components/console/traces/TracesSkeletons";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { traceViewsV3EnabledForActor } from "@/lib/synthesis/traces/v2/views-flag";
import type { TraceListSearchParams } from "@/lib/synthesis/traces/view";
import { RunsPageV2 } from "../runs-v2";

export const metadata = { title: "Turns" };

/**
 * Traces, Turns tab (RC-503, `FF_TRACE_VIEWS_V3`): the second tab, after
 * Sessions. Without the switch the first tab lists runs, so this one sends there.
 */
export default async function TracesTurnsTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<TraceListSearchParams>;
}) {
  const { projectId } = await params;
  const session = isDbConfigured() ? await getSessionContext() : null;
  if (!session || !(await traceViewsV3EnabledForActor(projectId, session.user.externalId)))
    redirect(`/project/${encodeURIComponent(projectId)}/traces`);
  return (
    <Suspense fallback={<RunsSkeleton />}>
      <RunsPageV2 projectId={projectId} searchParams={await searchParams} />
    </Suspense>
  );
}
