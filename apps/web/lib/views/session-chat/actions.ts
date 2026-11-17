"use server";

import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import {
  loadStepContent,
  type StepContent,
  type StepContentRequest,
} from "@/lib/views/session-chat/inspect-load";
import { sessionReplayEnabledForActor } from "@/lib/views/session-replay/gate";
import { contentOptIn } from "@/lib/views/session-replay/runs";

/**
 * The session chat's one server action (RC-284): the stored text behind an
 * inspector view, read on demand. Checks membership, `FF_SESSION_REPLAY`
 * and the content opt-in; `inspect-load.ts` scopes every
 * read to the project.
 */

export type StepContentResult =
  | { ok: true; content: StepContent | null }
  | { ok: false; error: string };

const logger = getLogger("session-chat/actions");

export async function loadStepContentAction(
  projectId: string,
  request: StepContentRequest,
): Promise<StepContentResult> {
  try {
    const session = await getSessionContext();
    if (!session) return { ok: false, error: "Sign in to see this step." };
    const scope = await findProjectScope(projectId);
    if (!scope) return { ok: false, error: "No project you belong to has that ID." };
    const actor = session.user.externalId;
    if (!(await sessionReplayEnabledForActor(scope.project.id, actor))) {
      return { ok: false, error: "Session replay is off for this organization." };
    }
    const content = await loadStepContent(scope.project.id, request, {
      readContent: await contentOptIn(scope.project.id),
    });
    return { ok: true, content };
  } catch (err) {
    logger.error({ err, project_id: projectId }, "step_content_load_failed");
    return { ok: false, error: "This step could not be loaded. Try again." };
  }
}
