import { cache } from "react";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { pivotsEnabled } from "@/lib/platform/pivots-flag";

/**
 * Whether the signed-in reader sees Settings > Pivots (RC-881) for the
 * project: a member of its organization, with `FF_PIVOTS` on for the
 * project. Cached per request, so the settings layout and the page share one
 * decision. Owned (ADR-0030): the console's project scope reads the session
 * and the membership; the switch is `FF_PIVOTS` for the project.
 */
export const pivotsVisible = cache(async (projectId: string): Promise<boolean> => {
  const scope = await findProjectScope(projectId);
  return scope ? pivotsEnabled(projectId, scope.organization) : false;
});
