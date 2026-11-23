import type { TraceListSearchParams } from "@/lib/synthesis/traces/view";
import { TracePageV2 } from "./trace-v2";

export const metadata = { title: "Trace detail" };

export default async function ScopedTraceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; traceId: string }>;
  searchParams: Promise<
    TraceListSearchParams & { span?: string | string[]; tab?: string | string[] }
  >;
}) {
  const { projectId, traceId } = await params;
  return <TracePageV2 projectId={projectId} traceId={traceId} searchParams={await searchParams} />;
}
