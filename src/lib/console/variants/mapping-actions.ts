import { parseVariantMapping, type VariantMapping } from "@/lib/ingest/variants/domain/mappings";
import type { VariantExperimentsFlagOrganization } from "@/lib/platform/variants-flag";

/**
 * Add and remove a project's variant attribute mappings (RC-869). Any member
 * of the project may: a mapping changes how new spans are grouped, not what is
 * stored. The caller is a signed-in session, never an API key, and membership
 * and the flag are resolved here on each call; the client posts only ids and
 * the typed fields.
 *
 * Owned (ADR-0030): the scope's flag organization is the core's organization record or its id
 * (`FF_VARIANT_EXPERIMENTS` reads only the id), not upstream's ingest flag organization.
 */

/** What the switch reads of the organization: its record or its id. */
type FlagOrganization = VariantExperimentsFlagOrganization | string;

export type VariantMappingActionResult = { ok: true } | { ok: false; message: string };

export interface VariantMappingActor {
  userId: string;
  externalId: string;
}

export interface VariantMappingScope {
  projectId: string;
  organizationId: string;
  flagOrganization: FlagOrganization;
}

export interface VariantMappingActionDeps {
  /** The signed-in member, or null. */
  getActor: () => Promise<VariantMappingActor | null>;
  /** The project when the user is a member of its organization, else null. */
  findScope: (projectId: string, userId: string) => Promise<VariantMappingScope | null>;
  isEnabled: (projectId: string, organization: FlagOrganization) => Promise<boolean>;
  save: (
    projectId: string,
    mapping: VariantMapping,
    createdBy: string,
  ) => Promise<"saved" | "full">;
  remove: (projectId: string, mappingId: string) => Promise<boolean>;
  track: (
    event: "variant_mapping_saved" | "variant_mapping_removed",
    actor: { externalId: string; orgId: string; projectId: string },
  ) => Promise<void>;
  /** After a change, so the settings page reads it. */
  revalidate: (projectId: string) => void;
  logError: (message: string, err: unknown, fields: Record<string, unknown>) => void;
}

export const DENIED: VariantMappingActionResult = {
  ok: false,
  message: "You cannot change mappings of this project.",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAVE_FAILED: VariantMappingActionResult = {
  ok: false,
  message: "Could not save that. Try again.",
};

export async function saveVariantMappingAction(
  projectId: unknown,
  input: { attributeKey: unknown; experiment: unknown },
  deps: VariantMappingActionDeps,
): Promise<VariantMappingActionResult> {
  const auth = await authorize(projectId, deps);
  if (!auth) return DENIED;
  const parsed = parseVariantMapping(input);
  if (!parsed.ok) return parsed;
  try {
    const outcome = await deps.save(auth.scope.projectId, parsed.mapping, auth.actor.externalId);
    if (outcome === "full")
      return { ok: false, message: "This project has the most mappings. Remove one first." };
    await deps.track("variant_mapping_saved", trackActor(auth));
    deps.revalidate(auth.scope.projectId);
    return { ok: true };
  } catch (err) {
    deps.logError("variant mapping save failed", err, { project_id: auth.scope.projectId });
    return SAVE_FAILED;
  }
}

export async function removeVariantMappingAction(
  projectId: unknown,
  mappingId: unknown,
  deps: VariantMappingActionDeps,
): Promise<VariantMappingActionResult> {
  if (typeof mappingId !== "string" || !UUID.test(mappingId)) return DENIED;
  const auth = await authorize(projectId, deps);
  if (!auth) return DENIED;
  try {
    if (!(await deps.remove(auth.scope.projectId, mappingId))) return DENIED;
    await deps.track("variant_mapping_removed", trackActor(auth));
    deps.revalidate(auth.scope.projectId);
    return { ok: true };
  } catch (err) {
    deps.logError("variant mapping remove failed", err, { project_id: auth.scope.projectId });
    return SAVE_FAILED;
  }
}

async function authorize(projectId: unknown, deps: VariantMappingActionDeps) {
  if (typeof projectId !== "string") return null;
  const actor = await deps.getActor();
  if (!actor) return null;
  const scope = await deps.findScope(projectId, actor.userId);
  if (!scope) return null;
  if (!(await deps.isEnabled(scope.projectId, scope.flagOrganization))) return null;
  return { actor, scope };
}

function trackActor({ actor, scope }: { actor: VariantMappingActor; scope: VariantMappingScope }) {
  return { externalId: actor.externalId, orgId: scope.organizationId, projectId: scope.projectId };
}
