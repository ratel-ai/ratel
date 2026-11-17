import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";

/**
 * Session chat capture at ingest (RC-280, RC-310): whether a project's
 * model-call payloads keep their own reply and request settings for the
 * session chat.
 *
 * Owned (ADR-0030): upstream asks its flag service for `cloud-session-replay`, decided for the
 * project's organization as the session page decides it. Here it is the deployment switch
 * `FF_SESSION_REPLAY` (off by default), the one the session page reads
 * (`views/session-replay-flag.ts`); ingest may not import views, so it is read from the platform
 * layer. The project and organization are kept only for the callers' shape.
 */
export const SESSION_CHAT_CAPTURE_FLAG = "FF_SESSION_REPLAY" as const;

export type SessionChatCaptureEnabled = (
  projectId: string,
  organization: unknown,
) => Promise<boolean>;

export async function sessionChatCaptureEnabled(
  _projectId: string,
  _organization: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  return experimentalFeatureEnabled(SESSION_CHAT_CAPTURE_FLAG, env);
}
