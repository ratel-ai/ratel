#!/usr/bin/env tsx
/**
 * Fill the trace filter columns of trace summaries written before migration
 * 0038 (upstream 0097, RC-505): `models`, `tools`, `service_name` and `environment`.
 *
 * The summary sweep fills them for every trace it touches after the deploy.
 * This recomputes the older rows in (project_id, trace_id) batches, without
 * moving the sweep cursor. Safe to re-run and to interrupt: pass the same
 * `--before` again and it skips the rows a previous run finished. It logs
 * counts only.
 *
 * Usage:
 *   DATABASE_URL=… pnpm --filter @ratel/platform traces:backfill-filters [--before <ISO time>] [--batch-size <n>] [--dry-run]
 *
 * `--before` defaults to now. Use the 0038 deploy time to skip the rows the
 * sweep already recomputed.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import { getDb } from "@/lib/platform/db/client";
import {
  backfillTraceSummaryFilters,
  SUMMARY_FILTERS_BACKFILL_BATCH_SIZE,
} from "@/lib/synthesis/traces/summary-filters-backfill";

async function main() {
  const before = new Date(option("--before") ?? Date.now());
  if (Number.isNaN(before.getTime())) throw new Error("--before needs an ISO time");
  const batchSize = Number(option("--batch-size") ?? SUMMARY_FILTERS_BACKFILL_BATCH_SIZE);
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0)
    throw new Error("--batch-size needs a positive integer");
  const dryRun = process.argv.includes("--dry-run");

  console.log(
    `${dryRun ? "Dry run: counting" : "Recomputing"} trace summaries written before ${before.toISOString()}`,
  );
  const { traces, batches } = await backfillTraceSummaryFilters(getDb(), {
    before,
    batchSize,
    dryRun,
    onBatch: (progress) =>
      console.log(`… ${progress.traces} traces in ${progress.batches} batches`),
  });
  console.log(
    `✓ Trace filter backfill ${dryRun ? "dry run" : "complete"}: ${traces} traces in ${batches} batches.`,
  );
  process.exit(0);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

main().catch((err) => {
  console.error(`✗ Trace filter backfill failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
