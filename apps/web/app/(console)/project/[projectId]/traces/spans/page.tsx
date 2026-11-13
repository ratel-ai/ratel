import { Suspense } from "react";
import { ListSkeleton } from "@/components/console/traces/TracesSkeletons";
import type { TraceListSearchParams } from "@/lib/synthesis/traces/view";
import { SpansPageV2 } from "./spans-v2";

export const metadata = { title: "Spans" };

export default async function SpansPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<TraceListSearchParams>;
}) {
  const { projectId } = await params;
  // See ../page.tsx: a Suspense boundary, not a loading file, so filters don't flash a skeleton.
  return (
    <Suspense fallback={<ListSkeleton />}>
      <SpansPageV2 projectId={projectId} searchParams={await searchParams} />
    </Suspense>
  );
}
