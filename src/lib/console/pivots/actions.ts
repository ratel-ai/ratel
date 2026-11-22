"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import type { PivotInput } from "@/lib/ingest/pivots/model";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { enqueuePivotRefill } from "@/lib/synthesis/pivots/refill";
import {
  addPivot,
  type PivotSettingsDeps,
  type PivotSettingsResult,
  removePivot,
  renamePivot,
  reorderPivot,
} from "@/lib/synthesis/pivots/settings";

/**
 * Server actions for Settings > Pivots (RC-881). The checks live in
 * `./settings`; this file binds the signed-in session to them. Owned
 * (ADR-0030): the console's project scope checks the membership, and the
 * support session is the core's port.
 */

export async function addPivotAction(
  projectId: string,
  input: PivotInput,
): Promise<PivotSettingsResult> {
  return revalidated(projectId, await addPivot(projectId, input, deps()));
}

export async function renamePivotAction(
  projectId: string,
  key: string,
  label: string,
): Promise<PivotSettingsResult> {
  return revalidated(projectId, await renamePivot(projectId, key, label, deps()));
}

export async function movePivotAction(
  projectId: string,
  key: string,
  direction: "up" | "down",
): Promise<PivotSettingsResult> {
  return revalidated(
    projectId,
    await reorderPivot(projectId, key, direction === "up" ? "up" : "down", deps()),
  );
}

export async function removePivotAction(
  projectId: string,
  key: string,
): Promise<PivotSettingsResult> {
  return revalidated(projectId, await removePivot(projectId, key, deps()));
}

function revalidated(projectId: string, result: PivotSettingsResult): PivotSettingsResult {
  if (result.ok) revalidatePath(`/project/${encodeURIComponent(projectId)}/settings/pivots`);
  return result;
}

function deps(): PivotSettingsDeps {
  return {
    getActor: async () => {
      const session = await getSessionContext();
      return session ? { userId: session.user.id, externalId: session.user.externalId } : null;
    },
    findScope: async (projectId) => {
      const scope = await findProjectScope(projectId);
      return scope ? { organizationId: scope.organization.id } : null;
    },
    isRestricted: isRestrictedBySupportSession,
    // The cron drain runs it within a minute (RC-884).
    refill: (projectId) => enqueuePivotRefill(projectId),
    track: (event, context, properties) => trackServerEvent(event, context, { ...properties }),
  };
}
