import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";

export const OTLP_RAW_CAPTURE_FLAG = "FF_OTLP_RAW_CAPTURE" as const;

/**
 * Raw OTLP capture at ingest (RC-405): keep the raw body of each accepted export.
 *
 * Owned (ADR-0030): upstream asks its flag service for `cloud-otlp-raw-capture`, decided for the
 * project's organization. Here it is the deployment switch `FF_OTLP_RAW_CAPTURE` (off by default),
 * read from the platform layer. The project and organization are kept only for the callers' shape.
 */
export async function otlpRawCaptureEnabled(
  _projectId: string,
  _organization: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  return experimentalFeatureEnabled(OTLP_RAW_CAPTURE_FLAG, env);
}
