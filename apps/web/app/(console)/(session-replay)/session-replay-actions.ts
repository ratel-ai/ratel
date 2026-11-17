"use server";

import { revalidatePath } from "next/cache";
import { changeTaskEvalAction } from "@/app/(console)/(stage-spine)/project/[projectId]/tasks/[taskId]/eval-actions";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { resolveFixChange } from "@/lib/views/eval-gate/seams";
import { loadFixContext } from "@/lib/views/eval-gate/service";
import { DRAFTING_MESSAGE } from "@/lib/views/fix-drafts/resolve";
import { type ContentOptInState, setContentOptIn } from "@/lib/views/session-replay/settings";
import {
  type ActionResult,
  addWhatIfToEvalSet,
  getWhatIfRun,
  submitWhatIf,
  type WhatIfDeps,
  type WhatIfRunView,
} from "@/lib/views/session-replay/what-if";

/**
 * Server actions for session replay (RC-144). Each one checks the caller's
 * membership, the flag and the content opt-in in `lib/session-replay`; this
 * file only binds the signed-in session to them.
 */

/** Turn content reading on or off for a project. Admin-only. */
export async function setContentOptInAction(
  projectId: string,
  readContent: boolean,
): Promise<ContentOptInState> {
  const result = await setContentOptIn(projectId, readContent, {
    getActor: async () => {
      const session = await getSessionContext();
      return session ? { userId: session.user.id, externalId: session.user.externalId } : null;
    },
    // The scope is the session organization's project, so the reader is the one asking.
    findRole: async (id) => (await findProjectScope(id))?.role ?? null,
    isRestricted: isRestrictedBySupportSession,
    track: ({ externalId, projectId: id, readContent: on }) =>
      trackServerEvent(
        "project_settings_updated",
        { externalId, projectId: id },
        { field: "session_replay_read_content", read_content: on },
      ),
  });
  if (result.ok) revalidatePath(`/project/${encodeURIComponent(projectId)}`, "layout");
  return result;
}

/** Queue a What-if run: fork one model call with a change and sample it k times. */
export async function submitWhatIfAction(input: unknown): Promise<ActionResult<WhatIfRunView>> {
  return submitWhatIf(input, whatIfDeps());
}

/** One What-if run, for the panel's polling. */
export async function getWhatIfRunAction(
  projectId: string,
  runId: string,
): Promise<ActionResult<WhatIfRunView>> {
  return getWhatIfRun(projectId, runId, whatIfDeps());
}

/** Add the run a What-if forked to its task's eval set. */
export async function addWhatIfToEvalSetAction(
  projectId: string,
  runId: string,
): Promise<ActionResult<string>> {
  return addWhatIfToEvalSet(projectId, runId, whatIfDeps());
}

function whatIfDeps(): WhatIfDeps {
  return {
    getSession: getSessionContext,
    findProjectScope,
    resolveFix: async (projectId, fixId, actor) => {
      const context = await loadFixContext(projectId, fixId);
      if (!context) return null;
      const resolved = await resolveFixChange(projectId, context.fix, { actor });
      if (resolved.status === "drafting") return { error: DRAFTING_MESSAGE };
      if (resolved.status === "unsupported")
        return { error: resolved.change.unsupportedReason ?? "This fix can't be tried on a step." };
      return { change: resolved.change, craft: context.fix.source === "craft" };
    },
    addToEvalSet: changeTaskEvalAction,
    track: ({ externalId, projectId, organizationId, changeKind, k, method, runId }) =>
      trackServerEvent(
        "what_if_submitted",
        { externalId, projectId, orgId: organizationId },
        { change_kind: changeKind, k, method, run_id: runId, actor: externalId },
      ),
  };
}
