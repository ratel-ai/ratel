import { cache } from "react";
import { findProjectScope } from "@/lib/console/scope/project-scope";

/**
 * Whether the signed-in reader sees Settings > Pivots (RC-881) for the
 * project: a member of its organization. Cached per request, so the settings
 * layout and the page share one decision. Owned (ADR-0030): the console's
 * project scope reads the session and the membership.
 */
export const pivotsVisible = cache(async (projectId: string): Promise<boolean> => {
  return (await findProjectScope(projectId)) !== null;
});
