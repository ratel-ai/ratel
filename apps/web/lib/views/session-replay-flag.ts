import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";
import { sessionReplayHref } from "@/lib/views/session-replay/view";

/**
 * Session replay is off unless `FF_SESSION_REPLAY` (or, in the open-source edition,
 * `RATEL_EXPERIMENTAL_FEATURES`) is set: without it the page is a 404 and
 * no page links to it. Replaces upstream's organization flag (`session-replay/gate.ts`).
 */
export function sessionReplayEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return experimentalFeatureEnabled("FF_SESSION_REPLAY", env);
}

/** The session's replay link, or null while the flag is off. */
export function sessionReplayLink(
  projectId: string,
  sessionId: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return sessionReplayEnabled(env) ? sessionReplayHref(projectId, sessionId) : null;
}
