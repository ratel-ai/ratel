"use server";

import { composition } from "@/lib/composition/ports";
import {
  createFirstProject,
  type CreateProjectState as FirstProjectState,
} from "@/lib/console/onboarding/create-first-project";
import { generateApiKey } from "@/lib/platform/api-keys";
import { isDbConfigured } from "@/lib/platform/db/client";
import { checkQuota } from "@/lib/platform/entitlements";
import {
  createApiKey,
  createProject,
  listProjectsForOrganization,
} from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";
import { trackProductEvent } from "@/lib/platform/telemetry";

// A declaration, not `export type { … }`: the server-action transform keeps a bare re-export as a
// runtime binding, which fails at module evaluation.
export type CreateProjectState = FirstProjectState;

/**
 * Creates the project and its Default API key in one step. The refusals (a support session
 * through the session port, the plan's cap through the entitlements port, a stale session)
 * live in `createFirstProject`, which this wires to the real queries.
 */
export async function createProjectAction(
  _prev: CreateProjectState,
  formData: FormData,
): Promise<CreateProjectState> {
  const organizationId = String(formData.get("organizationId") ?? "").trim() || undefined;

  // The plaintext key comes back for the immediate client-side reveal (KeyReveal).
  // Do NOT add revalidatePath("/onboarding") / revalidate the root layout here:
  // re-rendering this route would re-run the onboarding page's project-cap guard
  // (now at the cap we just reached) and redirect away before the key is shown.
  // Keys are stored as hash and prefix only, so this response is the key's one reveal.
  return createFirstProject(
    { name: String(formData.get("name") ?? ""), organizationId },
    {
      dbConfigured: isDbConfigured,
      session: async () => (await getSessionContext()) ?? null,
      actingAs: () => composition.session.actingAs(),
      listProjects: (id) => listProjectsForOrganization(id),
      createProject: (input) => createProject(input),
      createApiKey: (input) => createApiKey(input),
      generateApiKey,
      checkQuota,
      track: trackProductEvent,
    },
  );
}
