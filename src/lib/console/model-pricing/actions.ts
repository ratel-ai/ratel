"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import {
  type ModelPricingDeps,
  type ModelPricingResult,
  resetProjectModelPrice,
  saveProjectModelPrice,
} from "@/lib/ingest/model-pricing/settings";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { reportServerException, trackServerEvent } from "@/lib/platform/telemetry";
import { repriceProjectModel } from "@/lib/synthesis/model-pricing/reprice";

/**
 * Server actions for Settings > General > Model pricing (RC-482). The checks
 * live in `./settings`; this file binds the signed-in session to them.
 */

const logger = getLogger("model-pricing/actions");

/** Save the project's price of one model. Admin-only. */
export async function saveModelPriceAction(
  projectId: string,
  input: unknown,
): Promise<ModelPricingResult> {
  const result = await saveProjectModelPrice(projectId, input, deps());
  if (result.ok) revalidatePath(`/project/${encodeURIComponent(projectId)}`, "layout");
  return result;
}

/** Drop the project's price of one model: the built-in price applies again. */
export async function resetModelPriceAction(
  projectId: string,
  model: string,
): Promise<ModelPricingResult> {
  const result = await resetProjectModelPrice(projectId, model, deps());
  if (result.ok) revalidatePath(`/project/${encodeURIComponent(projectId)}`, "layout");
  return result;
}

function deps(): ModelPricingDeps {
  return {
    getActor: async () => {
      const session = await getSessionContext();
      return session ? { userId: session.user.id, externalId: session.user.externalId } : null;
    },
    // Owned (ADR-0030): one organization per session, so the scope takes the project id only.
    findRole: async (id) => (await findProjectScope(id))?.role ?? null,
    isRestricted: isRestrictedBySupportSession,
    // A project's stored calls of one model, re-priced after the response so a
    // large project does not hold the save open.
    reprice: (projectId, model, version) =>
      after(async () => {
        try {
          const changed = await repriceProjectModel(projectId, model, version, getDb());
          logger.info(
            {
              project_id: projectId,
              model,
              spans: changed.spans,
              events: changed.events,
              stale: changed.stale,
            },
            "model calls repriced",
          );
        } catch (err) {
          logger.error({ err, project_id: projectId, model }, "model call reprice failed");
          reportServerException(err, `project:${projectId}`, {
            project_id: projectId,
            operation: "model_price_reprice",
          });
        }
      }),
    track: ({ externalId, projectId, model, action }) =>
      trackServerEvent(
        "project_settings_updated",
        { externalId, projectId },
        { field: "model_price", model, action },
      ),
  };
}
