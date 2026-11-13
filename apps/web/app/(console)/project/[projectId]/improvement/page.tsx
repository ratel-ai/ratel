import { permanentRedirect } from "next/navigation";
import { fixHref } from "@/lib/views/fixes/href";

/**
 * Improvements has no index page of its own any more: Fixes is the one list
 * of what to change, and Agent health, Quality and Adaptive ranking each have
 * their own rail item. An old link here (including `/explore?tab=intents` or
 * `?tab=suggestions`, which the legacy redirects send to this path) lands on
 * Fixes; the retired parameters are dropped.
 */
export default async function ImprovementsIndexPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  permanentRedirect(fixHref(projectId));
}
