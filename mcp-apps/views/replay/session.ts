/**
 * The glue between a tool result and the console's session replay: the
 * SessionChat a result's `view` carries (lib/mcp/operations/session-chat-view.ts),
 * and what the model hears when the user opens a step. No UI here; the view
 * renders components/session-chat as the console does.
 */
import { stepWords } from "@/components/console/session-chat/format";
import type { SessionChatViewData } from "@/lib/mcp/operations/session-chat-view";
import type { SessionChat } from "@/lib/views/session-chat/model";
import { type ChatPeek, chatPeekId } from "@/lib/views/session-chat/peek";
import type { ToolSuccess } from "../../shell/state";

export type { SessionChatViewData };

function isChat(value: unknown): value is SessionChat {
  const chat = value as Partial<SessionChat> | null;
  return (
    !!chat &&
    typeof chat.sessionId === "string" &&
    Array.isArray(chat.turns) &&
    Array.isArray(chat.segments) &&
    Array.isArray(chat.calls)
  );
}

/**
 * The result's session, or null: a run outside any session, session replay off,
 * or a host that passed the text content only (the view data is never in it).
 */
export function readSessionChatView(result: Pick<ToolSuccess, "view">): SessionChatViewData | null {
  const view = result.view as Partial<SessionChatViewData> | undefined;
  if (
    !view ||
    view.kind !== "session_chat" ||
    typeof view.projectId !== "string" ||
    !isChat(view.chat)
  )
    return null;
  return {
    kind: "session_chat",
    projectId: view.projectId,
    chat: view.chat,
    turnIndex: typeof view.turnIndex === "number" ? view.turnIndex : null,
    sessionHref: typeof view.sessionHref === "string" ? view.sessionHref : "",
    settingsHref: typeof view.settingsHref === "string" ? view.settingsHref : "",
  };
}

/** The panel a run's view opens on: its own turn's work, so the run is what the user sees first. */
export function initialPeek(view: SessionChatViewData): string | null {
  if (view.turnIndex === null || !view.chat.turns.some((turn) => turn.turnIndex === view.turnIndex))
    return null;
  return chatPeekId({ kind: "work", turnIndex: view.turnIndex });
}

/** What the model is told when the user opens a step or a turn in the replay (ui/update-model-context). */
export function peekContext(
  chat: SessionChat,
  peek: ChatPeek,
): { text: string; structured: Record<string, unknown> } | null {
  if (peek.kind === "step") {
    const segment = chat.segments.find((item) => item.stepIndex === peek.stepIndex);
    if (!segment) return null;
    const flags = chat.problems.find((item) => item.stepIndex === peek.stepIndex)?.kinds ?? [];
    const words = stepWords(segment);
    return {
      text: `The user is looking at step ${peek.stepIndex} of session ${chat.sessionId}, in turn ${segment.turnIndex}: ${words}${flags.length > 0 ? ` (flagged: ${flags.join(", ")})` : ""}.`,
      structured: {
        sessionId: chat.sessionId,
        turnIndex: segment.turnIndex,
        stepIndex: peek.stepIndex,
        step: words,
        ...(flags.length > 0 ? { flags } : {}),
      },
    };
  }
  const turn = chat.turns.find((item) => item.turnIndex === peek.turnIndex);
  if (!turn) return null;
  const what =
    peek.kind === "ask"
      ? "the user's message"
      : peek.kind === "reply"
        ? "the agent's reply"
        : `the agent's work (${turn.work.label})`;
  return {
    text: `The user is looking at ${what} in turn ${turn.turnIndex} of session ${chat.sessionId}.`,
    structured: { sessionId: chat.sessionId, turnIndex: turn.turnIndex, part: peek.kind },
  };
}
