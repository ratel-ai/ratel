import { getLogger } from "@/lib/platform/logger";
import { trackProductEvent } from "@/lib/platform/telemetry";

/**
 * Reporting seam for the one API-key signal that originates inside the data
 * layer: a presented key that authenticates fine except that its expiry has
 * passed. `findActiveApiKeyByHash` calls this instead of importing the
 * analytics stack, and tests inject their own reporter.
 *
 * Create and revoke are user actions, so those events are emitted from the
 * server actions in `lib/api-keys/action-handlers.ts` where the acting user is
 * known.
 */

const logger = getLogger("api-keys");

export type ExpiredApiKey = {
  id: string;
  projectId: string;
  keyPrefix: string;
  expiresAt: Date | null;
};

export type ApiKeyExpiredReporter = (key: ExpiredApiKey) => Promise<void>;

/**
 * A broken integration retries, so an expired key can be presented many times a
 * second. Report each key at most once per window rather than mirroring the
 * retry rate into the event stream.
 */
const REPORT_WINDOW_MS = 10 * 60 * 1000;
/** Bound the map so a key-guessing flood can't grow it without limit. */
const MAX_TRACKED_KEYS = 1_000;

const lastReportedAt = new Map<string, number>();

function shouldReport(keyId: string, now: number): boolean {
  const previous = lastReportedAt.get(keyId);
  if (previous !== undefined && now - previous < REPORT_WINDOW_MS) return false;
  if (lastReportedAt.size >= MAX_TRACKED_KEYS) lastReportedAt.clear();
  lastReportedAt.set(keyId, now);
  return true;
}

/** Test seam — the dedupe window is process-wide state. */
export function resetApiKeyExpiryReporting(): void {
  lastReportedAt.clear();
}

/**
 * Log and track an expired-key rejection. Best-effort: observability can never
 * turn a clean 401 into a 500, so failures are swallowed after logging.
 */
export const reportApiKeyExpired: ApiKeyExpiredReporter = async (key) => {
  if (!shouldReport(key.id, Date.now())) return;

  logger.warn(
    {
      apiKeyId: key.id,
      projectId: key.projectId,
      keyPrefix: key.keyPrefix,
      expiresAt: key.expiresAt?.toISOString() ?? null,
    },
    "rejected expired api key",
  );
  await trackProductEvent(
    "api_key_expired",
    { projectId: key.projectId },
    { key_prefix: key.keyPrefix },
  );
};
