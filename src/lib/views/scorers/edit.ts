import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import { drizzleScorerRepository } from "./adapters/store";
import { ScorerConfigError } from "./domain/config";
import { SCORER_KINDS, type Scorer, type ScorerKind, type ScorerScope } from "./domain/types";
import { STARTER_DEFINITIONS, STARTER_NAMES } from "./view";

/**
 * RC-615: the console's scorer edits. The caller must be a member of the
 * project and have `cloud-eval-gate` on. A config the domain refuses comes
 * back as its message, for the form to show.
 */

export type ScorerEditResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ScorerEditDeps {
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: { id: string }; organization: { id: string } } | null>;
  enabled?: (projectId: string, actor: string) => Promise<boolean>;
  db?: ReturnType<typeof getDb>;
  track?: (
    event: "scorer_changed" | "eval_scorer_switched",
    scope: { externalId: string; projectId: string; orgId: string },
    fields: Record<string, unknown>,
  ) => Promise<void>;
}

export type ScorerEdit =
  | { action: "create"; scope: ScorerScope; taskId: string | null; kind: ScorerKind }
  | {
      action: "save";
      scorerId: string;
      name: string;
      config: unknown;
      goodThreshold: number;
      enabled: boolean;
    }
  | { action: "delete"; scorerId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const logger = getLogger("scorers/edit");

/** Create a scorer with a starter config, save one, or delete one. */
export async function editScorer(
  projectId: string,
  edit: ScorerEdit,
  deps: ScorerEditDeps,
): Promise<ScorerEditResult<Scorer | null>> {
  const allowed = await allow(projectId, deps);
  if (!allowed.ok) return allowed;
  const { actor, scope } = allowed.value;
  const repo = drizzleScorerRepository(deps.db ?? getDb());
  try {
    let saved: Scorer | null;
    if (edit.action === "create") {
      if (!SCORER_KINDS.includes(edit.kind)) return { ok: false, error: "Pick a scorer kind." };
      saved = await repo.create({
        projectId: scope.project.id,
        scope: edit.scope,
        taskId: edit.taskId,
        name: STARTER_NAMES[edit.kind],
        ...STARTER_DEFINITIONS[edit.kind],
        createdBy: actor,
      });
    } else if (edit.action === "save") {
      saved = await repo.update(scope.project.id, edit.scorerId, {
        name: edit.name,
        config: edit.config,
        goodThreshold: edit.goodThreshold,
        enabled: edit.enabled,
        updatedBy: actor,
      });
      if (!saved) return { ok: false, error: "This scorer no longer exists." };
    } else {
      if (!(await repo.remove(scope.project.id, edit.scorerId)))
        return { ok: false, error: "This scorer no longer exists." };
      saved = null;
    }
    const fields = {
      action: edit.action,
      scorer_id: saved?.id ?? ("scorerId" in edit ? edit.scorerId : null),
      kind: saved?.kind ?? null,
      scope: saved?.scope ?? null,
      actor,
    };
    logger.info({ project_id: scope.project.id, ...fields }, "scorer changed");
    await deps.track?.(
      "scorer_changed",
      { externalId: actor, projectId: scope.project.id, orgId: scope.organization.id },
      { object_action: "scorer_changed", ...fields },
    );
    return { ok: true, value: saved };
  } catch (err) {
    if (err instanceof ScorerConfigError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Switch one scorer for one eval. Null clears the switch so the scorer's own switch applies. */
export async function switchEvalScorer(
  projectId: string,
  evalId: string,
  scorerId: string,
  enabled: boolean | null,
  deps: ScorerEditDeps,
): Promise<ScorerEditResult<boolean | null>> {
  const allowed = await allow(projectId, deps);
  if (!allowed.ok) return allowed;
  const { actor, scope } = allowed.value;
  try {
    await drizzleScorerRepository(deps.db ?? getDb()).setOverride(
      scope.project.id,
      evalId,
      scorerId,
      enabled,
      actor,
    );
  } catch (err) {
    if (err instanceof ScorerConfigError) return { ok: false, error: err.message };
    throw err;
  }
  await deps.track?.(
    "eval_scorer_switched",
    { externalId: actor, projectId: scope.project.id, orgId: scope.organization.id },
    { object_action: "eval_scorer_switched", eval_id: evalId, scorer_id: scorerId, enabled, actor },
  );
  return { ok: true, value: enabled };
}

async function allow(
  projectId: string,
  deps: ScorerEditDeps,
): Promise<
  ScorerEditResult<{
    actor: string;
    scope: { project: { id: string }; organization: { id: string } };
  }>
> {
  const session = await deps.getSession();
  if (!session) return { ok: false, error: "Sign in to edit scorers." };
  const scope = UUID.test(projectId)
    ? await deps.findProjectScope(projectId, session.user.id)
    : null;
  if (!scope) return { ok: false, error: "No project you belong to has that ID." };
  const actor = session.user.externalId;
  const enabled =
    deps.enabled ??
    ((id: string, who: string) => evalGateEnabledForActor(id, who, deps.db ?? getDb()));
  if (!(await enabled(scope.project.id, actor)))
    return { ok: false, error: "Scorers are off for this project." };
  return { ok: true, value: { actor, scope } };
}
