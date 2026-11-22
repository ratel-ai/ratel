import type { CountryRow } from "@/lib/views/clients/queries";
import { canonicalAlpha2 } from "./country-codes";

/**
 * The pure parts of the caller map (RC-1058): which rows color which country,
 * and how dark. Calls per country are skewed (one country often has most of
 * them), so the buckets grow on a log scale: a country with a handful of calls
 * still shows next to the busiest one.
 */

/** Colored buckets; bucket 0 is the neutral fill of a country with no calls. */
export const CALL_BUCKETS = 4;

/** Guards the log ratio against float error at the bucket edges (10 of 10,000 is exactly a quarter). */
const EPSILON = 1e-9;

export interface CountryCalls {
  /** ISO 3166-1 alpha-2, upper case, withdrawn codes as their successor. */
  code: string;
  calls: number;
  sessions: number;
}

/** The bucket of a country's calls, 0 (no calls) to CALL_BUCKETS (the busiest), given the busiest country's calls. */
export function callBucket(calls: number, maxCalls: number): number {
  if (calls <= 0 || maxCalls <= 0) return 0;
  if (maxCalls <= 1) return CALL_BUCKETS;
  const share = Math.log(Math.min(calls, maxCalls)) / Math.log(maxCalls);
  return Math.min(CALL_BUCKETS, 1 + Math.floor(share * CALL_BUCKETS + EPSILON));
}

/** The rows with a known country, keyed by the code the map joins on. The unknown row stays in the table only. */
export function countryCalls(rows: readonly CountryRow[]): Map<string, CountryCalls> {
  const byCode = new Map<string, CountryCalls>();
  for (const row of rows) {
    if (!row.country) continue;
    const code = canonicalAlpha2(row.country);
    const seen = byCode.get(code);
    byCode.set(code, {
      code,
      calls: (seen?.calls ?? 0) + row.calls,
      sessions: (seen?.sessions ?? 0) + row.sessions,
    });
  }
  return byCode;
}
