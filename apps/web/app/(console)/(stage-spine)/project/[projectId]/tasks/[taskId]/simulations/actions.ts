"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import { reportServerException, trackServerEvent } from "@/lib/platform/telemetry";
import { evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import { loadFixContext } from "@/lib/views/eval-gate/service";
import { createFixShipment } from "@/lib/views/fixes/loop-queries";
import { stageSpineEnabled } from "@/lib/views/stage-spine-flag";
import { runTaskSimulation } from "@/lib/views/task-evals/simulation";
import {
  changeTaskSimulation,
  type TaskSimulationActionResult,
} from "@/lib/views/task-evals/simulation-actions";
// The task loop's shipment record (`fixSeams.recordShipment`): MarkLive queues the post-ship measures.
import "@/lib/views/task-evals/ship";

/**
 * Owned (ADR-0030): the project comes from the console scope; the stage spine is `FF_STAGE_SPINE`
 * (`stage-spine-flag.ts`) in place of the Cloud flag.
 */

const logger = getLogger("task-evals/simulation-actions");

export async function changeTaskSimulationAction(
  input: unknown,
): Promise<TaskSimulationActionResult> {
  if (!isDbConfigured()) return { ok: false, error: "No database is connected." };
  try {
    const result = await changeTaskSimulation(input, {
      getSession: getSessionContext,
      findProjectScope,
      enabled: async (projectId, actor) =>
        stageSpineEnabled() && (await evalGateEnabledForActor(projectId, actor)),
      ship: createFixShipment,
      loadFix: loadFixContext,
      run: async (fixId, options) => {
        const result = await runTaskSimulation(fixId, options);
        revalidatePath(`/project/${encodeURIComponent(options.projectId)}/tasks`, "layout");
        return result;
      },
      observe: async (fields) => {
        const event = fields.what === "shipment" ? "fix_shipped" : "task_simulation_edited";
        logger.info(fields, event);
        await trackServerEvent(
          event,
          { externalId: fields.actor, projectId: fields.project_id, orgId: fields.organization_id },
          {
            ...fields,
            object_action: event,
          },
        );
        revalidatePath(`/project/${encodeURIComponent(fields.project_id)}/tasks`, "layout");
      },
    });
    return result;
  } catch (err) {
    logger.error({ err }, "task simulation change failed");
    reportServerException(err, "system:task-evals", { operation: "task_simulation_change" });
    return { ok: false, error: "Could not change the simulation. Try again." };
  }
}
