import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getDb } from "@/lib/platform/db/client";
import { createDrizzleCaseStore } from "@/lib/views/evals/adapters/drizzle-case-store";
import { createDrizzleExperimentStore } from "@/lib/views/evals/adapters/drizzle-experiment-store";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { newAddress, type OldAddress } from "@/lib/views/evals/old-addresses";

/**
 * An old address of the evals pages. A route, not a page: a page streams the console shell first,
 * so its redirect would answer 200. With the flag off, and for a person who is not a member, it
 * answers 404 like the pages.
 */
export async function redirectOld(
  request: Request,
  projectId: string,
  old: OldAddress,
): Promise<Response> {
  if (!(await evalsEnabledForProject(projectId))) return new Response("Not found", { status: 404 });
  const target = await newAddress(projectId, old, {
    isMember: async (id) => (await findProjectScope(id)) !== null,
    experiment: (id, experimentId) => createDrizzleExperimentStore(getDb()).get(id, experimentId),
    evalCase: (id, caseId) => createDrizzleCaseStore(getDb()).get(id, caseId),
  });
  if (target === null) return new Response("Not found", { status: 404 });
  return Response.redirect(new URL(target, request.url), 307);
}
