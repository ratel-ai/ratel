import type { HealthShareLink } from "@/lib/contracts/composition";
import { parseWindowDays } from "@/lib/readings/trace-signals/view";

/**
 * The live share link as the member's dialog shows it: its window cut to the plan as it is now,
 * which is the window the public page opens on (`loadSharedHealth`). A link made on a longer
 * window keeps it stored, so an upgrade brings it back. Upstream does this inline on the page.
 */
export function shareLinkOnPlan(
  link: HealthShareLink | null,
  planWindowDays: number,
): HealthShareLink | null {
  return link && { ...link, windowDays: parseWindowDays(String(link.windowDays), planWindowDays) };
}
