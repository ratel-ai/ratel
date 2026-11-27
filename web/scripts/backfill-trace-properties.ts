#!/usr/bin/env tsx
/**
 * Fill the values of indexed trace properties (RTL-395, ADR-0012) for the traces a project stored
 * before a property became indexed, from the raw OTLP exports the raw store still holds
 * (`otlp_raw_exports`, kept `OTLP_RAW_RETENTION_DAYS`): older traces cannot be filled.
 *
 * Indexing a property in Settings or with `change_trace_property` queues the same fill as a job
 * (`fill_trace_properties`), and so does ingest for a standard property it indexes at first sight.
 * This script is for a fill by hand: after a failed job, or for every indexed property at once.
 *
 * It is a dry run by default: it counts the spans and summaries it would fill and writes nothing.
 * Pass `--apply` to write. It adds only a key a row does not hold, so it is safe to re-run and to
 * interrupt: a second run writes nothing. It does not move the summary sweep cursor. It logs
 * counts only, never a value.
 *
 * Usage:
 *   DATABASE_URL=… pnpm --filter @ratel/platform backfill:trace-properties --project <id> [--apply] [--name <property>]... [--since <ISO date>] [--page-size <n>]
 */

import "./load-env";
import { getDb } from "@/lib/platform/db/client";
import {
  backfillTraceProperties,
  propertyBackfillOptionsFromArgs,
} from "@/lib/synthesis/traces/property-backfill";

async function main() {
  const options = propertyBackfillOptionsFromArgs(process.argv.slice(2));
  const { apply, projectId, names } = options;
  console.log(
    `${apply ? "Filling" : "Dry run (pass --apply to write): counting"} trace property values of project ${projectId}` +
      `${names ? ` for ${names.join(", ")}` : " for every indexed property"}`,
  );
  const { exports, undecodable, spans, summaries, batches } = await backfillTraceProperties(
    getDb(),
    {
      ...options,
      onBatch: (progress) =>
        console.log(
          `… ${progress.spans} spans and ${progress.summaries} summaries from ${progress.exports} exports, ${progress.batches} batches`,
        ),
    },
  );
  const read = `${exports} exports (${undecodable} undecodable), ${batches} batches`;
  console.log(
    apply
      ? `✓ Trace property fill complete: ${spans} spans and ${summaries} summaries filled from ${read}.`
      : `✓ Trace property fill dry run: ${spans} spans and ${summaries} summaries to fill from ${read}. Nothing was written; pass --apply to write.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`✗ Trace property fill failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
