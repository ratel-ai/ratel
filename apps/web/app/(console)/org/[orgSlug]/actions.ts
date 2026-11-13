"use server";

import { notFound, redirect } from "next/navigation";
import { startProjectCreation } from "@/lib/console/start-project-creation";
import { isDbConfigured } from "@/lib/platform/db/client";
import { listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";
import { trackProductEvent } from "@/lib/platform/telemetry";

/** "New project": opens onboarding for the organization, or says why it cannot at the plan's cap. */
export async function startProjectCreationAction(orgSlug: string): Promise<void> {
  if (!isDbConfigured()) throw new Error("database not configured");

  const context = await getSessionContext();
  if (!context) redirect("/");

  const destination = await startProjectCreation(orgSlug, {
    organization: async () => context.organization,
    listProjects: (organizationId) => listProjectsForOrganization(organizationId),
    onRefused: async (organization, capacity) => {
      await trackProductEvent(
        "quota_limit_hit",
        { externalId: context.user.externalId, orgId: organization.id },
        { limit: "maxProjects", cap: capacity.limit },
      );
    },
  });
  if ("notFound" in destination) notFound();
  redirect(destination.redirect);
}
