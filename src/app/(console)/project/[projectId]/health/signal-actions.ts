"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException, trackProductEvent } from "@/lib/platform/telemetry";
import { DISMISSABLE_KINDS } from "@/lib/readings/trace-signals/dismiss";
import { setSignalDismissed } from "@/lib/readings/trace-signals/signals/queries";

/**
 * Hide a slow-tool problem as "slow by design", and show it again. Any member
 * of the project may: it changes what the team's page lists, not what is
 * measured. Membership is re-resolved server-side; the client posts only the
 * project and signal ids. Owned (ADR-0030): the project comes from the console
 * scope, and the actor is the session user.
 */

const logger = getLogger("trace-signals/signal-actions");

export type SignalActionResult = { ok: true } | { ok: false; message: string };

const DENIED: SignalActionResult = { ok: false, message: "This issue cannot be changed here." };

async function authorize(projectId: unknown, signalId: unknown) {
  if (typeof projectId !== "string" || typeof signalId !== "string" || !isDbConfigured())
    return null;
  const scope = await findProjectScope(projectId);
  if (!scope) return null;
  return { scope, signalId };
}

async function setDismissed(
  projectId: string,
  signalId: string,
  dismissed: boolean,
): Promise<SignalActionResult> {
  const auth = await authorize(projectId, signalId);
  if (!auth) return DENIED;
  const { scope } = auth;
  try {
    const changed = await setSignalDismissed({
      projectId: scope.project.id,
      signalId: auth.signalId,
      kinds: DISMISSABLE_KINDS,
      dismissed,
      by: scope.user.externalId,
    });
    if (!changed) return DENIED;
    const actor = {
      externalId: scope.user.externalId,
      orgId: scope.organization.id,
      projectId: scope.project.id,
    };
    if (dismissed) {
      await trackProductEvent("health_signal_dismissed", actor, {
        kind: changed.kind,
        reason: "slow_by_design",
      });
    } else {
      await trackProductEvent("health_signal_restored", actor, { kind: changed.kind });
    }
    revalidatePath(`/project/${scope.project.id}/health`);
    return { ok: true };
  } catch (err) {
    logger.error(
      { err, project_id: scope.project.id, dismissed },
      "health signal status update failed",
    );
    reportServerException(err, scope.user.externalId, {
      project_id: scope.project.id,
      operation: dismissed ? "health_signal_dismiss" : "health_signal_restore",
    });
    return { ok: false, message: "Could not save that. Try again." };
  }
}

/** Hide a slow-tool problem: the tool is slow by design. */
export async function dismissSlowSignalAction(
  projectId: string,
  signalId: string,
): Promise<SignalActionResult> {
  return setDismissed(projectId, signalId, true);
}

/** Show a hidden slow-tool problem again. */
export async function restoreSignalAction(
  projectId: string,
  signalId: string,
): Promise<SignalActionResult> {
  return setDismissed(projectId, signalId, false);
}
