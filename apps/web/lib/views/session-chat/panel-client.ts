import type { StepContentRequest } from "./inspect-load";
import type { SessionPanelChatResult, StepContentResult } from "./panel-route";

/**
 * The browser's loaders for the session chat's GET routes (panel-route.ts).
 * A route's own error answer is passed through; a network failure or a body
 * that is not an answer reads as the same retryable error the route gives.
 */

const CHAT_FAILED: SessionPanelChatResult = {
  ok: false,
  error: "This session could not be loaded. Try again.",
};
const STEP_FAILED: StepContentResult = {
  ok: false,
  error: "This step could not be loaded. Try again.",
};

export async function fetchSessionPanelChat(
  projectId: string,
  sessionId: string,
): Promise<SessionPanelChatResult> {
  const url = `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/chat`;
  return readAnswer(url, "chat", CHAT_FAILED);
}

/** For the session inspector (RC-524 switches `StepInspector` to it). */
export async function fetchStepContent(
  projectId: string,
  request: StepContentRequest,
): Promise<StepContentResult> {
  const params = new URLSearchParams();
  for (const id of request.eventIds) params.append("event", id);
  if (request.searchEventId) params.set("search", request.searchEventId);
  return readAnswer(
    `/api/projects/${encodeURIComponent(projectId)}/session-steps?${params.toString()}`,
    "content",
    STEP_FAILED,
  );
}

async function readAnswer<T extends { ok: boolean }>(
  url: string,
  field: string,
  failed: T,
): Promise<T> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    const body: unknown = await response.json().catch(() => null);
    return isAnswer(body, field) ? (body as T) : failed;
  } catch {
    return failed;
  }
}

function isAnswer(value: unknown, field: string): boolean {
  if (!value || typeof value !== "object" || !("ok" in value)) return false;
  const answer = value as Record<string, unknown>;
  return answer.ok === true ? field in answer : typeof answer.error === "string";
}
