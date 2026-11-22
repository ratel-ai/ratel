import { notFound, redirect } from "next/navigation";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import { getSessionContext } from "@/lib/platform/session";
import {
  fineTuningEnabled,
  fineTuningEnabledWithoutOrganization,
} from "@/lib/views/fine-tuning/flag";

export interface FineTuningPageContext {
  project: Project;
  organization: Organization;
  externalId: string;
  /** An organization admin: gives and withdraws the training opt-in. */
  isAdmin: boolean;
  /** When the request was read: the use cases' default window ends here. */
  now: Date;
}

/** What the context reads, injectable for the flag test. */
export interface FineTuningPageDeps {
  getSessionContext: () => Promise<{ user: { id: string; externalId: string } } | null>;
  getProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: Project; organization: Organization; role: string }>;
  fineTuningEnabled: (organization: Organization) => Promise<boolean>;
  isDbConfigured: () => boolean;
  /** The flag with no organization to decide for: overrides, else the default. */
  fineTuningEnabledWithoutOrganization: () => boolean;
}

/** What the page renders: the context, or the database notice (only with the flag on). */
export type FineTuningPageEntry =
  | { kind: "ready"; context: FineTuningPageContext }
  | { kind: "no_database" };

const defaultDeps: FineTuningPageDeps = {
  getSessionContext,
  getProjectScope,
  fineTuningEnabled: (organization) => fineTuningEnabled(organization),
  isDbConfigured,
  fineTuningEnabledWithoutOrganization,
};

/**
 * The page's entry (RC-1137): the flag is decided before the database
 * branch, so with the flag off the page is not found even with no database.
 */
export async function resolveFineTuningPageEntry(
  projectId: string,
  deps: FineTuningPageDeps = defaultDeps,
): Promise<FineTuningPageEntry> {
  if (!deps.isDbConfigured()) {
    if (!deps.fineTuningEnabledWithoutOrganization()) notFound();
    return { kind: "no_database" };
  }
  return { kind: "ready", context: await resolveFineTuningPageContext(projectId, deps) };
}

/** The Fine-tuning page (RC-1123) starts here: the signed-in person's project and the flag (`FF_FINE_TUNING`; off, the page does not exist). */
export async function resolveFineTuningPageContext(
  projectId: string,
  deps: FineTuningPageDeps = defaultDeps,
): Promise<FineTuningPageContext> {
  const session = await deps.getSessionContext();
  if (!session) redirect("/");
  const { project, organization, role } = await deps.getProjectScope(projectId, session.user.id);
  if (!(await deps.fineTuningEnabled(organization))) notFound();
  return {
    project,
    organization,
    externalId: session.user.externalId,
    isAdmin: role === "admin",
    now: new Date(),
  };
}
