"use server";

import { revalidatePath } from "next/cache";
import {
  type UpdateOrganizationResult,
  updateConsoleOrganization,
} from "@/lib/console/organization-settings";
import { updateOrganizationSettings } from "@/lib/platform/identity/queries";
import { getSessionContext } from "@/lib/platform/session";

/** Renames the session organization and its address; the shell and links pick it up. */
export async function updateOrganizationAction(
  organizationSlug: string,
  name: string,
  slug: string,
): Promise<UpdateOrganizationResult> {
  const result = await updateConsoleOrganization(
    organizationSlug,
    { name, slug },
    {
      scope: async () => {
        const context = await getSessionContext();
        return context ? { organization: context.organization, role: context.role } : null;
      },
      update: (id, values) => updateOrganizationSettings(id, values),
    },
  );
  if (result.ok) revalidatePath("/", "layout");
  return result;
}
