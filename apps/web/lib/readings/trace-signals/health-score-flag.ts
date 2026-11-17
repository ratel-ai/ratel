import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";

/**
 * Whether a public Agent health link shows the Health score (RC-226).
 *
 * Owned (ADR-0030): upstream asks its flag service for `cloud-health-score` the way background
 * work asks a flag, as the link's project with its organization's properties, because a share
 * link has no session. Here the score is the deployment switch `FF_HEALTH_SCORE` (off by
 * default), the one the member page reads, so a link shows the score exactly where the page
 * does. The project and organization are kept only for the callers' shape.
 */
export const HEALTH_SCORE_FLAG = "FF_HEALTH_SCORE" as const;

export async function sharedHealthScoreEnabled(
  _projectId: string,
  _organization: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  return experimentalFeatureEnabled(HEALTH_SCORE_FLAG, env);
}
