import { Suspense } from "react";
import { RunsSkeleton } from "@/components/console/traces/TracesSkeletons";
import type { TraceListSearchParams } from "@/lib/synthesis/traces/view";
import { RunsPageV2 } from "../runs-v2";

export const metadata = { title: "Turns" };

/**
 * Traces, Turns tab (RC-503): the second tab, after Sessions.
 */
export default async function TracesTurnsTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<TraceListSearchParams>;
}) {
  const { projectId } = await params;
  return (
    <Suspense fallback={<RunsSkeleton />}>
      <RunsPageV2 projectId={projectId} searchParams={await searchParams} />
    </Suspense>
  );
}
