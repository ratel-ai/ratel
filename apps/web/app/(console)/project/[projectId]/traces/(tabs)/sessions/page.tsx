import { notFound } from "next/navigation";
import { Suspense } from "react";
import { RunsSkeleton } from "@/components/console/traces/TracesSkeletons";
import { SessionsPage } from "@/components/console/traces-sessions/SessionsPage";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { traceViewsV3EnabledForActor } from "@/lib/synthesis/traces/v2/views-flag";

export const metadata = { title: "Sessions" };

/**
 * Traces, Sessions tab (RC-472, `FF_TRACE_VIEWS_V3`): the turns grouped by
 * session, each row with its first ask, turns, time and cost; a row opens the
 * session on its chat. Without the switch the tab does not exist.
 */
export default async function TracesSessionsTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ show?: string | string[] }>;
}) {
  const { projectId } = await params;
  const session = isDbConfigured() ? await getSessionContext() : null;
  if (!session || !(await traceViewsV3EnabledForActor(projectId, session.user.externalId)))
    notFound();
  return (
    <Suspense fallback={<RunsSkeleton />}>
      <SessionsPage projectId={projectId} searchParams={await searchParams} />
    </Suspense>
  );
}
