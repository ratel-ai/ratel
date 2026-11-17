"use server";

import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import { traceViewsV3EnabledForActor } from "@/lib/synthesis/traces/v2/views-flag";
import {
  loadStepContent,
  type StepContent,
  type StepContentRequest,
} from "@/lib/views/session-chat/inspect-load";
import { loadSessionChat } from "@/lib/views/session-chat/load";
import type { ChatTurn } from "@/lib/views/session-chat/model";
import { loadTurnTraceIds } from "@/lib/views/session-chat/turn-traces";
import { sessionReplayEnabledForActor } from "@/lib/views/session-replay/gate";
import { contentOptIn } from "@/lib/views/session-replay/runs";

/**
 * The session chat's server actions. RC-284: the stored text behind an
 * inspector view, read on demand; it checks membership, `FF_SESSION_REPLAY`
 * and the content opt-in, and `inspect-load.ts` scopes every read to the
 * project. RC-503: the whole session as chat for the Sessions tab's side
 * panel, behind `FF_TRACE_VIEWS_V3`.
 */

export type StepContentResult =
  | { ok: true; content: StepContent | null }
  | { ok: false; error: string };

/** One turn of the side panel's chat, with the trace it opens. */
export interface PanelChatTurn
  extends Pick<ChatTurn, "turnIndex" | "ask" | "reply" | "startedAt" | "endedAt" | "work"> {
  traceId: string | null;
}

export interface PanelChat {
  textOff: boolean;
  turns: PanelChatTurn[];
}

export type SessionPanelChatResult =
  | { ok: true; chat: PanelChat | null }
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

export async function loadSessionPanelChatAction(
  projectId: string,
  sessionId: string,
): Promise<SessionPanelChatResult> {
  try {
    const session = await getSessionContext();
    if (!session) return { ok: false, error: "Sign in to see this session." };
    const scope = await findProjectScope(projectId);
    if (!scope) return { ok: false, error: "No project you belong to has that ID." };
    if (!(await traceViewsV3EnabledForActor(scope.project.id, session.user.externalId)))
      return { ok: false, error: "Not found." };
    const chat = await loadSessionChat(scope.project.id, sessionId, {
      readContent: await contentOptIn(scope.project.id),
    });
    if (!chat) return { ok: true, chat: null };
    const traces = await loadTurnTraceIds(
      scope.project.id,
      chat.turns.map((turn) => turn.turnId),
    );
    return {
      ok: true,
      chat: {
        textOff: chat.textOff,
        turns: chat.turns.map(({ turnId, turnIndex, ask, reply, startedAt, endedAt, work }) => ({
          turnIndex,
          ask,
          reply,
          startedAt,
          endedAt,
          work,
          traceId: traces.get(turnId)?.[0] ?? null,
        })),
      },
    };
  } catch (err) {
    logger.error({ err, project_id: projectId }, "session_panel_chat_load_failed");
    return { ok: false, error: "This session could not be loaded. Try again." };
  }
}
