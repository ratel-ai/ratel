import {
  movePivot,
  type Pivot,
  type PivotError,
  type PivotInput,
  planPivot,
  validateLabel,
} from "@/lib/ingest/pivots/model";
import {
  deletePivot,
  insertPivot,
  listPivots,
  type PivotsDb,
  setPivotOrder,
  updatePivotLabel,
} from "@/lib/ingest/pivots/store";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import type { PivotsFlagOrganization } from "@/lib/platform/pivots-flag";

/**
 * Settings > Pivots (RC-881): a member of the project's organization lists,
 * adds, renames, moves and removes the project's pivots, with `FF_PIVOTS`
 * on. Each write is scoped to the project the person belongs to and sends
 * `pivot_created`, `pivot_updated` or `pivot_deleted`.
 */

export type PivotEvent = "pivot_created" | "pivot_updated" | "pivot_deleted";

export interface PivotEventProperties {
  pivot_key: string;
  preset_id: string | null;
  change?: "label" | "position";
  pivot_count: number;
}

export interface PivotScope {
  organizationId: string;
  /** The identity the flag targets. */
  flagOrganization: PivotsFlagOrganization;
}

export interface PivotSettingsDeps {
  db?: PivotsDb;
  /** The signed-in person, or null. */
  getActor: () => Promise<{ userId: string; externalId: string } | null>;
  /** The project's organization when the person is a member of it, else null. */
  findScope: (projectId: string, userId: string) => Promise<PivotScope | null>;
  isEnabled: (projectId: string, organization: PivotsFlagOrganization) => Promise<boolean>;
  /** An admin support session may look but not change settings. */
  isRestricted?: () => Promise<boolean>;
  /**
   * Queue the refill of the project's trace `dims` (RC-884). Called when a
   * pivot is added or removed: a new name or order changes no value.
   */
  refill?: (projectId: string) => Promise<unknown>;
  track?: (
    event: PivotEvent,
    context: { externalId: string; projectId: string; orgId: string },
    properties: PivotEventProperties,
  ) => Promise<void>;
}

export type PivotSettingsResult = { ok: true; pivots: Pivot[] } | { ok: false; error: string };

export const PIVOT_SETTINGS_ERRORS = {
  signed_out: "Sign in to change pivots.",
  not_found: "No project you belong to has that ID.",
  restricted: "A support session cannot change settings.",
  missing: "That pivot is gone. Reload the page.",
  invalid_key:
    "Enter an attribute key of up to 128 letters, digits or _ . - : /. A preset name cannot be a key.",
  invalid_label: "Enter a name of 1 to 40 characters.",
  unknown_preset: "That preset does not exist.",
  duplicate: "The project already has that pivot.",
  limit: "A project has at most 5 pivots. Remove one first.",
} as const satisfies Record<string, string> & Record<PivotError, string>;

type ErrorCode = keyof typeof PIVOT_SETTINGS_ERRORS;

interface Actor {
  externalId: string;
  orgId: string;
}

const logger = getLogger("pivots/settings");

/** The project's pivots for the signed-in member. */
export async function readPivots(
  projectId: string,
  deps: PivotSettingsDeps,
): Promise<PivotSettingsResult> {
  const actor = await authorize(projectId, deps, { write: false });
  if ("error" in actor) return actor;
  return { ok: true, pivots: await listPivots(projectId, db(deps)) };
}

/** Add a preset or a custom key as the last pivot. */
export async function addPivot(
  projectId: string,
  input: PivotInput,
  deps: PivotSettingsDeps,
): Promise<PivotSettingsResult> {
  const actor = await authorize(projectId, deps);
  if ("error" in actor) return actor;
  const existing = await listPivots(projectId, db(deps));
  const plan = planPivot(existing, input);
  if (!plan.ok) return refuse(plan.error, projectId);
  const outcome = await insertPivot(projectId, plan.pivot, db(deps));
  if (outcome !== "inserted") return refuse(outcome, projectId);
  await queueRefill(projectId, deps);
  return written(projectId, actor, "pivot_created", plan.pivot, undefined, deps);
}

/** Give one pivot a new name. */
export async function renamePivot(
  projectId: string,
  key: string,
  label: unknown,
  deps: PivotSettingsDeps,
): Promise<PivotSettingsResult> {
  const actor = await authorize(projectId, deps);
  if ("error" in actor) return actor;
  const checked = validateLabel(label);
  if (!checked.ok) return refuse(checked.error, projectId);
  if (!(await updatePivotLabel(projectId, key, checked.value, db(deps))))
    return refuse("missing", projectId);
  return written(projectId, actor, "pivot_updated", key, "label", deps);
}

/** Move one pivot up or down by one place. */
export async function reorderPivot(
  projectId: string,
  key: string,
  direction: "up" | "down",
  deps: PivotSettingsDeps,
): Promise<PivotSettingsResult> {
  const actor = await authorize(projectId, deps);
  if ("error" in actor) return actor;
  const order = movePivot(await listPivots(projectId, db(deps)), key, direction);
  if (!order || !(await setPivotOrder(projectId, order, db(deps))))
    return refuse("missing", projectId);
  return written(projectId, actor, "pivot_updated", key, "position", deps);
}

/** Remove one pivot; the others close the gap. */
export async function removePivot(
  projectId: string,
  key: string,
  deps: PivotSettingsDeps,
): Promise<PivotSettingsResult> {
  const actor = await authorize(projectId, deps);
  if ("error" in actor) return actor;
  const before = (await listPivots(projectId, db(deps))).find((pivot) => pivot.key === key);
  if (!before || !(await deletePivot(projectId, key, db(deps))))
    return refuse("missing", projectId);
  await queueRefill(projectId, deps);
  return written(projectId, actor, "pivot_deleted", before, undefined, deps);
}

/** The write is saved either way: a failed queue is logged, and the next change queues it again. */
async function queueRefill(projectId: string, deps: PivotSettingsDeps): Promise<void> {
  try {
    await deps.refill?.(projectId);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "pivot refill enqueue failed");
  }
}

async function written(
  projectId: string,
  actor: Actor,
  event: PivotEvent,
  pivot: Pick<Pivot, "key" | "presetId"> | string,
  change: PivotEventProperties["change"],
  deps: PivotSettingsDeps,
): Promise<PivotSettingsResult> {
  const pivots = await listPivots(projectId, db(deps));
  const target = typeof pivot === "string" ? pivots.find((entry) => entry.key === pivot) : pivot;
  const key = typeof pivot === "string" ? pivot : pivot.key;
  logger.info({ project_id: projectId, pivot_key: key, outcome: event }, "pivots changed");
  await deps.track?.(
    event,
    { externalId: actor.externalId, projectId, orgId: actor.orgId },
    {
      pivot_key: key,
      preset_id: target?.presetId ?? null,
      ...(change ? { change } : {}),
      pivot_count: pivots.length,
    },
  );
  return { ok: true, pivots };
}

async function authorize(
  projectId: string,
  deps: PivotSettingsDeps,
  options: { write: boolean } = { write: true },
): Promise<Actor | { ok: false; error: string }> {
  const actor = await deps.getActor();
  if (!actor) return refuse("signed_out", projectId);
  const scope = await deps.findScope(projectId, actor.userId);
  // Flag off reads as not found: the page and its writes do not exist.
  if (!scope || !(await deps.isEnabled(projectId, scope.flagOrganization)))
    return refuse("not_found", projectId);
  if (options.write && (await deps.isRestricted?.())) return refuse("restricted", projectId);
  return { externalId: actor.externalId, orgId: scope.organizationId };
}

function refuse(code: ErrorCode, projectId: string): { ok: false; error: string } {
  logger.info({ project_id: projectId, outcome: code }, "pivots change refused");
  return { ok: false, error: PIVOT_SETTINGS_ERRORS[code] };
}

function db(deps: PivotSettingsDeps): PivotsDb {
  return deps.db ?? getDb();
}
