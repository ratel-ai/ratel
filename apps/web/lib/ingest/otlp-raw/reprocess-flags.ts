import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";
import type { ReprocessIngestFlags } from "./reprocess";

/**
 * The ingest switches a reprocess runs with, decided as `/v1/traces` decides them.
 *
 * Owned (ADR-0030): upstream asks its flag service for `cloud-otlp-semconv-aliases` and
 * `cloud-session-replay` for the project's organization, and aborts when it cannot get a clean
 * answer, because a reprocess rewrites stored rows. Here both are the deployment's: the aliases
 * are always read (upstream retires that flag in #402) and the reply capture is the switch
 * `FF_SESSION_REPLAY`, the one ingest reads. A switch always answers, so nothing aborts.
 */

export interface ReprocessFlagDecision {
  flag: string;
  enabled: boolean;
  source: "always on" | "deployment switch";
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
    flags: { semconvAliases: true, captureReply },
    decisions: [
      { flag: "cloud-otlp-semconv-aliases", enabled: true, source: "always on" },
      { flag: "FF_SESSION_REPLAY", enabled: captureReply, source: "deployment switch" },
    ],
  };
}
