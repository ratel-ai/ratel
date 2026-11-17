import { Suspense } from "react";
import { RunsSkeleton } from "@/components/console/traces/TracesSkeletons";
import { SessionListPage } from "@/components/console/traces-sessions/SessionListPage";
import type { TraceListSearchParams } from "@/lib/synthesis/traces/view";

export const metadata = { title: "Traces" };

export default async function ScopedTracesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<TraceListSearchParams & { show?: string | string[] }>;
}) {
  const { projectId } = await params;
  // RC-503: the first tab lists sessions only, and Turns has its own tab (`./turns`).
  // The skeleton streams first. A Suspense boundary here rather than a route
  // `loading.tsx`: Next swaps a route's loading file in on every search-param
  // change, so each filter would flash a skeleton, while this boundary stays
  // revealed and the page dims in place as the next view loads.
  return (
    <Suspense fallback={<RunsSkeleton />}>
      <SessionListPage projectId={projectId} searchParams={await searchParams} />
    </Suspense>
  );
}
