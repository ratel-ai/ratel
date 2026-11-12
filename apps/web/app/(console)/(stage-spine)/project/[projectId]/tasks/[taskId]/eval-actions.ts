"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import { reportServerException, trackServerEvent } from "@/lib/platform/telemetry";
import { evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import { changeTaskEval, type TaskEvalActionResult } from "@/lib/views/task-evals/actions";
import { type DraftTestResult, draftTaskTest } from "@/lib/views/task-evals/draft-action";
import { enqueueTaskEvalRefreshJob } from "@/lib/views/task-evals/job";
import { draftTestFromRun, TestDraftError } from "@/lib/views/task-evals/run-to-test";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";

const logger = getLogger("task-evals/actions");

export async function changeTaskEvalAction(input: unknown): Promise<TaskEvalActionResult> {
  if (!isDbConfigured()) return { ok: false, error: "No database is connected." };
  try {
    return await changeTaskEval(input, {
      getSession: getSessionContext,
      findProjectScope,
      enabled: evalGateEnabledForActor,
      enqueue: enqueueTaskEvalRefreshJob,
      observe: async (fields) => {
        logger.info(fields, "task_eval_case_changed");
        await trackServerEvent(
          "task_eval_case_changed",
          { externalId: fields.actor, projectId: fields.project_id, orgId: fields.organization_id },
          {
            ...fields,
            object_action: "task_eval_case_changed",
          },
        );
        if (fields.test_saved) {
          logger.info(fields, "task_test_saved");
          await trackServerEvent(
            "task_test_saved",
            {
              externalId: fields.actor,
              projectId: fields.project_id,
              orgId: fields.organization_id,
            },
            {
              ...fields,
              object_action: "task_test_saved",
            },
          );
          revalidatePath(`/project/${fields.project_id}/traces/turns/${fields.turn_id}`);
        }
        revalidatePath(topLevelTasksHref(fields.project_id, fields.task_id));
      },
    });
  } catch (err) {
    logger.error({ err }, "task eval change failed");
    reportServerException(err, "system:task-evals", { operation: "task_eval_case_change" });
    return { ok: false, error: "Could not change the eval set. Try again." };
  }
}

export async function draftTaskTestAction(input: unknown): Promise<DraftTestResult> {
  if (!isDbConfigured()) return { ok: false, error: "No database is connected." };
  try {
    return await draftTaskTest(input, {
      getSession: getSessionContext,
      findProjectScope,
      enabled: evalGateEnabledForActor,
      draft: (projectId, taskId, turnId, actor) =>
        draftTestFromRun(projectId, taskId, turnId, { actor }),
    });
  } catch (err) {
    logger.error({ err }, "task test draft failed");
    reportServerException(err, "system:task-evals", { operation: "task_test_draft" });
    return {
      ok: false,
      error: err instanceof TestDraftError ? err.message : "Could not draft a test. Try again.",
    };
  }
}
