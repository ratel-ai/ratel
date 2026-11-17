import { type BatchPrices, PRICES_UNKNOWN, type PriceOverrides } from "@/lib/ingest/pricing";
import type { LogError } from "@/lib/platform/logger";

/** The project's own prices at ingest (RC-482): `loadOverrides` reads them once per batch. */
export interface ModelPricingIngestDeps {
  loadOverrides: (projectId: string) => Promise<PriceOverrides>;
}

/**
 * What a batch of model calls is priced with, for span ingest and for the
 * restate of a stored call (gen_ai log join): the current prices and the
 * project's own. A failed price read gives `PRICES_UNKNOWN` (logged as an
 * error): ingest then stores no cost, for `backfill:costs`.
 */
export async function resolveBatchPrices(
  projectId: string,
  modelPricing: ModelPricingIngestDeps,
  log: { logError: LogError; captureFailure?: (error: unknown) => void },
): Promise<BatchPrices> {
  try {
    return { overrides: await modelPricing.loadOverrides(projectId) };
  } catch (err) {
    log.logError("model price read failed", err, { project_id: projectId });
    log.captureFailure?.(err);
    return PRICES_UNKNOWN;
  }
}
