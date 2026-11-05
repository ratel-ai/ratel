import { flagEnvEnabled } from "@/lib/platform/flags-env";
import { sessionReplayHref } from "@/lib/views/session-replay/view";

/**
 * Session replay is off unless `FF_SESSION_REPLAY` is set: without it the page is a 404 and
 * no page links to it. Replaces upstream's organization flag (`session-replay/gate.ts`).
 */
export function sessionReplayEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return flagEnvEnabled(env.FF_SESSION_REPLAY);
}

/** The session's replay link, or null while the flag is off. */
export function sessionReplayLink(
  projectId: string,
  sessionId: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return sessionReplayEnabled(env) ? sessionReplayHref(projectId, sessionId) : null;
}
