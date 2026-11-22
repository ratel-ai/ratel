import type { SessionChat } from "@/lib/views/session-chat/model";
import { sessionReplayHref } from "@/lib/views/session-replay/view";

/**
 * What the replay view (mcp-apps/views/replay) reads from a result's `view`
 * (OperationResult.view): the console's own SessionChat, as
 * /sessions/[sessionId] renders it, and where it lives in the console. Only
 * the view reads it; the agent's text never carries it.
 */
export interface SessionChatViewData {
  kind: "session_chat";
  projectId: string;
  chat: SessionChat;
  /** The turn the call was about (a run's own turn), or null for the whole session. */
  turnIndex: number | null;
  /** The console's session page, and its Settings, where an admin turns message text on. */
  sessionHref: string;
  settingsHref: string;
}

export function sessionChatView(
  projectId: string,
  chat: SessionChat,
  turnIndex: number | null = null,
): SessionChatViewData & Record<string, unknown> {
  return {
    kind: "session_chat",
    projectId,
    chat,
    turnIndex,
    sessionHref: sessionReplayHref(projectId, chat.sessionId),
    settingsHref: `/project/${encodeURIComponent(projectId)}/settings`,
  };
}
