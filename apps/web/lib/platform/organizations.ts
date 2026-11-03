import { cache } from "react";
import { composition } from "@/lib/composition/ports";
import type { Organization } from "@/lib/contracts/session";
import { getProjectById } from "@/lib/platform/projects/queries";

/**
 * Organizations for paths with no session (API-key ingest, background jobs), read through the
 * session port: the edition owns the table. Upstream's names, so copied call sites resolve here.
 */
export type { Organization } from "@/lib/contracts/session";

export const getOrganizationById = cache(
  (id: string): Promise<Organization | null> => composition.session.getOrganization(id),
);

/** The organization that owns a project (API-key surfaces). */
export async function getOrganizationByProjectId(projectId: string): Promise<Organization | null> {
  const project = await getProjectById(projectId);
  return project ? getOrganizationById(project.organizationId) : null;
}
