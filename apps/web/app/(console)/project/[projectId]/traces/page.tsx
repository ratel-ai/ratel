import { Suspense } from "react";
import { RunsSkeleton } from "@/components/console/traces/TracesSkeletons";
import type { TraceListSearchParams } from "@/lib/synthesis/traces/view";
import { RunsPageV2 } from "./runs-v2";

export const metadata = { title: "Traces" };

export default async function ScopedTracesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<TraceListSearchParams>;
}) {
  const { projectId } = await params;
  // The skeleton streams first. A Suspense boundary here rather than a route
  // `loading.tsx`: Next swaps a route's loading file in on every search-param
  // change, so each filter would flash a skeleton, while this boundary stays
  // revealed and the page dims in place as the next view loads.
  return (
    <Suspense fallback={<RunsSkeleton />}>
      <RunsPageV2 projectId={projectId} searchParams={await searchParams} />
    </Suspense>
  );
}
