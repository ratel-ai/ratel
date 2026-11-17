import { notFound, redirect } from "next/navigation";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { traceViewsV3EnabledForActor } from "@/lib/synthesis/traces/v2/views-flag";

export const metadata = { title: "Sessions" };

/**
 * The old Sessions tab address (RC-472). RC-503: Sessions is now the first
 * tab of Traces, so this sends there with the query. Without
 * `FF_TRACE_VIEWS_V3` the tab does not exist.
 */
export default async function TracesSessionsTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const session = isDbConfigured() ? await getSessionContext() : null;
  if (!session || !(await traceViewsV3EnabledForActor(projectId, session.user.externalId)))
    notFound();
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams))
    for (const item of [value ?? []].flat()) query.append(key, item);
  const text = query.toString();
  redirect(`/project/${encodeURIComponent(projectId)}/traces${text ? `?${text}` : ""}`);
}
