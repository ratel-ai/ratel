import { permanentRedirect } from "next/navigation";
import { projectSettingsRoot, withQuery } from "@/lib/console/settings/tabs";
import type { RuntimeEventsSearchParams } from "@/lib/ingest/runtime-events/view";

/**
 * Runtime events moved to Settings > Developer as SDK events. Gated like that
 * page; a link keeps its filters and the event it opened.
 */
export default async function RuntimeEventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<RuntimeEventsSearchParams>;
}) {
  const [{ projectId }, search] = await Promise.all([params, searchParams]);
  permanentRedirect(withQuery(`${projectSettingsRoot(projectId)}/developer`, { ...search }));
}
