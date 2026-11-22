import { CURRENT_PRICES, type PriceBook } from "@/lib/ingest/pricing";
import { getDb } from "@/lib/platform/db/client";
import { getLogger, type LogError } from "@/lib/platform/logger";
import { loadPriceOverrides } from "./store";

/**
 * A project's price book (RC-482): the current price table, the date-only
 * lookup and the project's own prices. Ingest, the re-price, the jobs and
 * every page read it here, so they agree on one answer for a project.
 */

type PriceBookDb = Pick<ReturnType<typeof getDb>, "select">;

const logger = getLogger("model-pricing/price-book");

/** The prices the project's costs use. A failed read throws. */
export async function loadPriceBook(
  projectId: string,
  db: PriceBookDb = getDb(),
): Promise<PriceBook> {
  return { overrides: await loadPriceOverrides(projectId, db) };
}

/**
 * {@link loadPriceBook} for a job that must not fail on it (eval and replay
 * runs): a failed read is logged and falls back to the current built-in prices.
 */
export async function loadJobPriceBook(
  projectId: string,
  db: PriceBookDb = getDb(),
  {
    logError = (message, err, fields) => logger.error({ ...fields, err }, message),
  }: { logError?: LogError } = {},
): Promise<PriceBook> {
  try {
    return await loadPriceBook(projectId, db);
  } catch (err) {
    logError("model price book unreadable", err, { project_id: projectId, fallback: "current" });
    return CURRENT_PRICES;
  }
}
