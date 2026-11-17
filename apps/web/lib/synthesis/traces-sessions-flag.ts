import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";

/**
 * The Traces Sessions tab and each tab's own summary (RC-312, RC-313, RC-331) are off unless
 * `FF_TRACES_SESSIONS` (or, in the open-source edition, `RATEL_EXPERIMENTAL_FEATURES`) is set:
 * without it Traces opens on Runs, as before. Replaces upstream's `cloud-traces-sessions` flag,
 * which its flag service decides per person.
 */
export const TRACES_SESSIONS_FLAG = "FF_TRACES_SESSIONS" as const;

export function tracesSessionsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return experimentalFeatureEnabled(TRACES_SESSIONS_FLAG, env);
}
