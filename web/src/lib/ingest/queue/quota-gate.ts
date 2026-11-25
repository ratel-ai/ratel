import type { EventQuotaResult } from "@/lib/platform/entitlements";

const TTL_MS = 60_000;
const MAX_ENTRIES = 10_000;

/**
 * Accept's answer to "is this organization over its monthly events", kept for at most 60 s
 * (ADR-0009), so that a 202 does not wait for the plan and the meter. Per process.
 */
export interface QuotaGate {
  check(organizationId: string, load: () => Promise<EventQuotaResult>): Promise<EventQuotaResult>;
}

export function createQuotaGate(now: () => number = Date.now): QuotaGate {
  const answers = new Map<string, { until: number; quota: Promise<EventQuotaResult> }>();
  return {
    async check(organizationId, load) {
      const at = now();
      const cached = answers.get(organizationId);
      if (cached && at < cached.until) return cached.quota;
      if (answers.size >= MAX_ENTRIES) answers.clear();
      const entry = { until: at + TTL_MS, quota: load() };
      answers.set(organizationId, entry);
      try {
        return await entry.quota;
      } catch (error) {
        // A failed read is not an answer.
        if (answers.get(organizationId) === entry) answers.delete(organizationId);
        throw error;
      }
    },
  };
}

/** The process-wide gate of the traces route. */
export const ingestQuotaGate: QuotaGate = createQuotaGate();
