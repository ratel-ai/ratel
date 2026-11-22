"use server";

import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import { loadStepContent, type StepContentRequest } from "@/lib/views/session-chat/inspect-load";
import type { StepContentResult } from "@/lib/views/session-chat/panel-route";
import { contentOptIn } from "@/lib/views/session-replay/runs";

/**
 * The session chat's server action. RC-284: the stored text behind an
 * inspector view, read on demand; it checks membership and the content
 * opt-in, and `inspect-load.ts` scopes every read to the
 * project. RC-530: a read-only support session refuses Server Actions, so the
 * reads move to GET routes (`panel-route.ts`): the side panel's chat already
 * did, and this action goes once `StepInspector` uses `fetchStepContent`.
 */

export type {
  PanelChat,
  PanelChatTurn,
  SessionPanelChatResult,
  StepContentResult,
} from "@/lib/views/session-chat/panel-route";

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
    const content = await loadStepContent(scope.project.id, request, {
      readContent: await contentOptIn(scope.project.id),
    });
    return { ok: true, content };
  } catch (err) {
    logger.error({ err, project_id: projectId }, "step_content_load_failed");
    return { ok: false, error: "This step could not be loaded. Try again." };
  }
}
