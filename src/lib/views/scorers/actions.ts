"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import { reportServerException, trackServerEvent } from "@/lib/platform/telemetry";
import type { Scorer } from "./domain/types";
import {
  editScorer,
  type ScorerEdit,
  type ScorerEditDeps,
  type ScorerEditResult,
  switchEvalScorer,
} from "./edit";

/** Server actions for scorers (RC-615). Membership and `cloud-eval-gate` are checked in `./edit`. */

const logger = getLogger("scorers/actions");

const deps: ScorerEditDeps = {
  getSession: getSessionContext,
  findProjectScope,
  track: (event, scope, fields) => trackServerEvent(event, scope, fields),
};

export async function editScorerAction(
  projectId: string,
  edit: ScorerEdit,
): Promise<ScorerEditResult<Scorer | null>> {
  try {
    const result = await editScorer(projectId, edit, deps);
    if (result.ok) revalidatePath(`/project/${encodeURIComponent(projectId)}`, "layout");
    return result;
  } catch (err) {
    logger.error({ err, project_id: projectId }, "scorer edit failed");
    reportServerException(err, "system:scorers", { operation: "scorer_edit" });
    return { ok: false, error: "Could not save the scorer. Try again." };
  }
}

export async function switchEvalScorerAction(
  projectId: string,
  evalId: string,
  scorerId: string,
  enabled: boolean | null,
): Promise<ScorerEditResult<boolean | null>> {
  try {
    const result = await switchEvalScorer(projectId, evalId, scorerId, enabled, deps);
    if (result.ok)
      revalidatePath(
        `/project/${encodeURIComponent(projectId)}/evals/${encodeURIComponent(evalId)}`,
      );
    return result;
  } catch (err) {
    logger.error({ err, project_id: projectId }, "eval scorer switch failed");
    reportServerException(err, "system:scorers", { operation: "eval_scorer_switch" });
    return { ok: false, error: "Could not switch the scorer. Try again." };
  }
}
