"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { composition } from "@/lib/composition/ports";
import { deleteConsoleOrganization } from "@/lib/console/delete-organization";
import { isDbConfigured } from "@/lib/platform/db/client";
import { checkOrganizationDeletion } from "@/lib/platform/entitlements";
import { deleteOrganization } from "@/lib/platform/identity/queries";
import { getSessionContext } from "@/lib/platform/session";
import { trackProductEvent } from "@/lib/platform/telemetry";

export type DeleteOrganizationState = { ok: false; error: string };

/**
 * Permanently delete an organization and everything it owns (projects, API keys, ingested
 * events, memberships) via ON DELETE cascade. Admin-only, refused while the entitlements port
 * says a subscription must be canceled first, and guarded by typing the organization name to
 * confirm. The checks live in `deleteConsoleOrganization`, which this wires to the ports and
 * the real queries; on success the console entry provisions an empty organization.
 */
export async function deleteOrganizationAction(
  organizationId: string,
  confirmName: string,
): Promise<DeleteOrganizationState> {
  if (!isDbConfigured()) return { ok: false, error: "Database not connected." };
  const result = await deleteConsoleOrganization(organizationId, confirmName, {
    actingAs: () => composition.session.actingAs(),
    session: async () => {
      const context = await getSessionContext();
      if (!context) return null;
      return { user: context.user, organization: context.organization, role: context.role };
    },
    checkDeletion: checkOrganizationDeletion,
    deleteOrganization: (id) => deleteOrganization(id),
    track: trackProductEvent,
  });
  if (!result.ok) return result;
  revalidatePath("/", "layout");
  redirect(result.next);
}
