import type { NavItem } from "@/lib/composition";
import { composition } from "@/lib/composition";

export type Runtime = {
  edition: string;
  nav: NavItem[];
};

/**
 * Single seam the spike UI reads. This is the only module that adapts ports to UI shape; the
 * console pages that arrive from ratel-cloud read `lib/platform/session.ts` instead. No plan
 * here: a plan belongs to an organization, and this seam resolves none.
 */
export async function getRuntime(): Promise<Runtime> {
  return { edition: composition.edition, nav: composition.nav };
}
