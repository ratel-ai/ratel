"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException, trackServerEvent } from "@/lib/platform/telemetry";
import { fixSeams } from "@/lib/views/fixes/seams";

/**
 * Dismiss a drafted change on Fixes. Any member of the project may: it changes
 * what the team's list shows, and the next analysis keeps the same change from
 * being drafted again. The project is re-resolved here; the client posts only
 * the project and draft ids. Owned (ADR-0030): the project comes from the
 * console scope, and the dismissal from the seam the tool crafter fills.
 */

const logger = getLogger("fixes/actions");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DismissDraftResult = { ok: true } | { ok: false; message: string };

const DENIED: DismissDraftResult = { ok: false, message: "This fix can't be dismissed here." };

export async function dismissDraftedFixAction(
  projectId: string,
  proposalId: string,
): Promise<DismissDraftResult> {
  if (
    typeof projectId !== "string" ||
    typeof proposalId !== "string" ||
    !UUID.test(proposalId) ||
    !isDbConfigured()
  )
    return DENIED;
  const dismissDraft = fixSeams.dismissDraft;
  if (!dismissDraft) return DENIED;
  const scope = await findProjectScope(projectId);
  if (!scope) return DENIED;
  try {
    const dismissed = await dismissDraft(scope.project.id, proposalId, new Date());
    if (!dismissed)
      return {
        ok: false,
        message: "This fix was already dismissed or replaced by a newer reading.",
      };
    await trackServerEvent(
      "tool_craft_proposal_dismissed",
      {
        externalId: scope.user.externalId,
        orgId: scope.organization.id,
        projectId: scope.project.id,
      },
      { object_action: "tool_craft_proposal_dismissed", proposal_id: proposalId, surface: "fixes" },
    );
    revalidatePath(`/project/${scope.project.id}/improvement/fixes`);
    revalidatePath(`/project/${scope.project.id}/health/tasks`);
    return { ok: true };
  } catch (err) {
    logger.error(
      { err, project_id: scope.project.id, proposal_id: proposalId },
      "drafted fix dismissal failed",
    );
    reportServerException(err, scope.user.externalId, {
      project_id: scope.project.id,
      operation: "tool_craft_proposal_dismiss",
    });
    return { ok: false, message: "Couldn't dismiss the fix. Try again in a moment." };
  }
}
