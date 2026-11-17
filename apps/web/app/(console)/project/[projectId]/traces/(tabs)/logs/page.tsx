import { Suspense } from "react";
import { ListSkeleton } from "@/components/console/traces/TracesSkeletons";
import type { EventListSearchParams } from "@/lib/synthesis/traces/events-view";
import { LogsPageV2 } from "./logs-v2";

export const metadata = { title: "Logs" };

export default async function ScopedTraceLogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<EventListSearchParams>;
}) {
  const { projectId } = await params;
  // See ../page.tsx: a Suspense boundary, not a loading file, so filters don't flash a skeleton.
  return (
    <Suspense fallback={<ListSkeleton />}>
      <LogsPageV2 projectId={projectId} searchParams={await searchParams} />
    </Suspense>
  );
}
