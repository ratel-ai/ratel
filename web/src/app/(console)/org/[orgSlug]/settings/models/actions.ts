"use server";

import { composition } from "@/lib/composition";
import { requireOrganizationScope } from "@/lib/console/scope/organization-scope";
import { checkModels, type ModelCheck, OSS_EDITION } from "@/lib/console/settings/models";

/** One small call per kind of model, for a reader of the organization; the open-source edition's. */
export async function checkModelsAction(slug: string): Promise<ModelCheck[]> {
  await requireOrganizationScope(slug);
  if (composition.edition !== OSS_EDITION) return [];
  return checkModels();
}
