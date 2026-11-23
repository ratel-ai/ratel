"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import { reportServerException, trackServerEvent } from "@/lib/platform/telemetry";
import { evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import { changeTaskScorer, type ScorerActionResult } from "@/lib/views/task-scorers/actions";
import { resetScorer, upsertScorer } from "@/lib/views/task-scorers/store";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";

/**
 * Owned (ADR-0004): the project comes from the console scope.
 */
const logger = getLogger("task-scorers/actions");

export async function changeTaskScorerAction(input: unknown): Promise<ScorerActionResult> {
  if (!isDbConfigured()) return { ok: false, error: "No database is connected." };
  try {
    return await changeTaskScorer(input, {
      getSession: getSessionContext,
      findProjectScope,
      enabled: evalGateEnabledForActor,
      save: upsertScorer,
      reset: resetScorer,
      observe: async (fields) => {
        logger.info(fields, "task_scorer_updated");
        await trackServerEvent(
          "task_scorer_updated",
          { externalId: fields.actor, projectId: fields.project_id, orgId: fields.organization_id },
          fields,
        );
        revalidatePath(
          `${topLevelTasksHref(fields.project_id)}/${encodeURIComponent(fields.task_id)}`,
        );
      },
    });
  } catch (err) {
    logger.error({ err }, "task scorer update failed");
    reportServerException(err, "system:task-scorers", { operation: "task_scorer_update" });
    return { ok: false, error: "Could not save the scorer. Try again." };
  }
}
