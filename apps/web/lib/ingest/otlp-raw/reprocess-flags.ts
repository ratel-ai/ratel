import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";
import type { ReprocessIngestFlags } from "./reprocess";

/**
 * The ingest switch a reprocess runs with, decided as `/v1/traces` decides it.
 *
 * Owned (ADR-0030): upstream asks its flag service for `cloud-session-replay` for the project's
 * organization, and aborts when it cannot get a clean answer, because a reprocess rewrites
 * stored rows. Here the reply capture is the deployment switch `FF_SESSION_REPLAY`, the one
 * ingest reads, and a switch always answers, so nothing aborts.
 */

export interface ReprocessFlagDecision {
  flag: string;
  enabled: boolean;
  source: "deployment switch";
}

export interface ReprocessFlags {
  flags: Omit<ReprocessIngestFlags, "agentSpanDedupe">;
  decisions: ReprocessFlagDecision[];
}

export async function decideReprocessFlags(
  _projectId: string,
  _organization: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<ReprocessFlags> {
  const captureReply = experimentalFeatureEnabled("FF_SESSION_REPLAY", env);
  return {
    flags: { captureReply },
    decisions: [{ flag: "FF_SESSION_REPLAY", enabled: captureReply, source: "deployment switch" }],
  };
}
