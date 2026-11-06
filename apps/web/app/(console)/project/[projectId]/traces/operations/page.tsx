import { permanentRedirect } from "next/navigation";
import { operationsAsSpansSearch } from "@/lib/synthesis/traces/v2/filters";
import type { TraceListSearchParams } from "@/lib/synthesis/traces/view";

/** Operations is Spans grouped ("Group by"); an old link keeps its filters and grouping. */
export default async function OperationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<TraceListSearchParams>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  permanentRedirect(
    `/project/${encodeURIComponent(projectId)}/traces/spans${operationsAsSpansSearch(query)}`,
  );
}
