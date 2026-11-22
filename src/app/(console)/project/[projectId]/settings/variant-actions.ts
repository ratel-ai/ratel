"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import {
  DENIED,
  removeVariantMappingAction as removeMapping,
  saveVariantMappingAction as saveMapping,
  type VariantMappingActionDeps,
  type VariantMappingActionResult,
} from "@/lib/console/variants/mapping-actions";
import { removeVariantMapping, saveVariantMapping } from "@/lib/ingest/variants/mappings-store";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import { reportServerException, trackProductEvent } from "@/lib/platform/telemetry";
import { variantExperimentsEnabled } from "@/lib/platform/variants-flag";

/**
 * Settings > General > Variant attributes (RC-869): save and remove a project's mappings. Owned
 * (ADR-0030): the session, the console's project scope and the telemetry port are the core's; the
 * switch is `FF_VARIANT_EXPERIMENTS` for the project.
 */

const logger = getLogger("variants/mapping-actions");

const deps: VariantMappingActionDeps = {
  getActor: async () => {
    const session = await getSessionContext();
    return session ? { userId: session.user.id, externalId: session.user.externalId } : null;
  },
  // The console's project scope checks the signed-in member's membership.
  findScope: async (projectId) => {
    const scope = await findProjectScope(projectId);
    return scope
      ? {
          projectId: scope.project.id,
          organizationId: scope.organization.id,
          flagOrganization: scope.organization,
        }
      : null;
  },
  isEnabled: variantExperimentsEnabled,
  save: (projectId, mapping, createdBy) =>
    saveVariantMapping(projectId, mapping, createdBy, getDb()),
  remove: (projectId, mappingId) => removeVariantMapping(projectId, mappingId, getDb()),
  track: (event, actor) => trackProductEvent(event, actor, {}),
  revalidate: (projectId) => revalidatePath(`/project/${projectId}/settings`),
  logError: (message, err, fields) => {
    logger.error({ err, ...fields }, message);
    reportServerException(err, `project:${String(fields.project_id)}`, {
      ...fields,
      operation: "variant_mapping_change",
    });
  },
};

export async function saveVariantMappingAction(
  projectId: string,
  attributeKey: string,
  experiment: string,
): Promise<VariantMappingActionResult> {
  if (!isDbConfigured()) return DENIED;
  return saveMapping(projectId, { attributeKey, experiment }, deps);
}

export async function removeVariantMappingAction(
  projectId: string,
  mappingId: string,
): Promise<VariantMappingActionResult> {
  if (!isDbConfigured()) return DENIED;
  return removeMapping(projectId, mappingId, deps);
}
