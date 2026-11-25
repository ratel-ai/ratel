"use server";

import { composition } from "@/lib/composition";
import { requireOrganizationScope } from "@/lib/console/scope/organization-scope";
import {
  canCheckModels,
  checkModelsAtMostEvery,
  type ModelCheck,
  OSS_EDITION,
} from "@/lib/console/settings/models";

/**
 * One small call per kind of model, for an admin of the organization, at most once every
 * 30 seconds for the deployment; the open-source edition's.
 */
export async function checkModelsAction(slug: string): Promise<ModelCheck[]> {
  const { role } = await requireOrganizationScope(slug);
  if (!canCheckModels(role)) throw new Error("Only an organization's admins can check the models.");
  if (composition.edition !== OSS_EDITION) return [];
  return checkModelsAtMostEvery();
}
