import { openSecret, sealSecret } from "@/lib/platform/secret-box";

/** Who started an install, and where. */
export interface InstallState {
  actor: string;
  organizationId: string;
  projectId: string;
}

const BINDING = "slack_install_state";
const TTL_MS = 10 * 60_000;
const MAX_LENGTH = 2_000;

/** The `state` of an install: authenticated and encrypted with the deployment's key, for 10 minutes. */
export function makeState(state: InstallState, now: Date = new Date(), key?: string): string {
  return sealSecret(JSON.stringify({ ...state, expires: now.getTime() + TTL_MS }), BINDING, key);
}

/** Null when it is missing, changed, made with another key or expired. */
export function readState(raw: unknown, now: Date = new Date(), key?: string): InstallState | null {
  if (typeof raw !== "string" || raw.length > MAX_LENGTH) return null;
  try {
    const { expires, actor, organizationId, projectId } = JSON.parse(
      openSecret(raw, BINDING, key),
    ) as InstallState & { expires: number };
    return expires > now.getTime() ? { actor, organizationId, projectId } : null;
  } catch {
    return null;
  }
}
